#!/usr/bin/env python3
import argparse
import difflib
import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path, PurePosixPath


SHA256 = re.compile(r"^[0-9a-f]{64}$")
REVISION = re.compile(r"^[0-9a-f]{40}$")
IDENTIFIER = re.compile(r"^[a-z][a-z0-9-]*$")
ROUTE_HINTS = (
    re.compile(r"\blightweight(?:-engineering)?\b", re.IGNORECASE),
    re.compile(r"\bfeature route\b", re.IGNORECASE),
    re.compile(r"\bp-?stack\b", re.IGNORECASE),
    re.compile(r"\bpoteto(?:-mode)?\b", re.IGNORECASE),
    re.compile(r"\bworkflow receipt\b", re.IGNORECASE),
)
UNSAFE_TEXT = (
    ("home-path", re.compile(r"(?:/Users/|/home/)[^\s\"']+")),
    ("email-address", re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE)),
    ("github-token", re.compile(r"\b(?:gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b")),
    ("openai-key", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b")),
)
EXPECTED_REQUIREMENTS = {
    "lightweight-engineering": {
        "lightweight.intake.inspect",
        "lightweight.route.qualifies",
        "lightweight.build.smallest-complete-change",
        "lightweight.verify.direct-check",
    },
    "feature": {
        "feature.shape.how",
        "feature.shape.parallel-design",
        "feature.shape.throughput-checkpoint",
        "feature.build.delegated-implementation",
        "feature.verify.matching-surface",
        "feature.review.ordered-commits",
    },
}
REQUIRED_CAPTURES = {
    "command",
    "jsonl",
    "stdout",
    "stderr",
    "exit",
    "finalResponse",
    "initialTree",
    "finalTree",
    "binaryDiff",
}


def candidate_artifact_paths(route: str):
    profile = "lightweight-engineering.json" if route == "lightweight-engineering" else "feature.json"
    fixture = "organic-lightweight" if route == "lightweight-engineering" else "organic-feature"
    return [
        "adapters/codex/plugin.json",
        "adapters/codex/skills/temari/SKILL.md",
        "skills/poteto-mode/SKILL.md",
        f"skills/poteto-mode/playbook-contracts/v1/{profile}",
        # Pin the product this journey exercised, not the tools that measured it.
        # A pinned tool cannot be fixed without re-capturing every journey, and
        # the tools carry their own gates: journey-scorer-tests and
        # verifier-smoke.
        f"verification/verify-temari/fixtures/{fixture}/prompt.txt",
        f"verification/verify-temari/fixtures/{fixture}/initial/AGENTS.md",
    ]


def profile_path(route: str):
    name = "lightweight-engineering.json" if route == "lightweight-engineering" else "feature.json"
    return f"skills/poteto-mode/playbook-contracts/v1/{name}"


def git_candidate(candidate_root: Path):
    result = subprocess.run(["git", "-C", str(candidate_root), "rev-parse", "--is-inside-work-tree"], text=True, capture_output=True, check=False)
    return result.returncode == 0 and result.stdout.strip() == "true"


def revision_blob(candidate_root: Path, revision: str, relative: str):
    result = subprocess.run(["git", "-C", str(candidate_root), "show", f"{revision}:{relative}"], capture_output=True, check=False)
    if result.returncode != 0:
        raise EvidenceError(f"candidate revision does not contain {relative}")
    return hashlib.sha256(result.stdout).hexdigest()


class EvidenceError(Exception):
    pass


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def load_json(path: Path):
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise EvidenceError(f"cannot read JSON {path}: {error}") from error


def exact(value, keys, where):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise EvidenceError(f"{where} has unknown or missing fields")
    return value


def text(value, where, pattern=None):
    if not isinstance(value, str) or not value or (pattern and not pattern.fullmatch(value)):
        raise EvidenceError(f"{where} is invalid")
    return value


def safe_path(root: Path, value: str, where: str) -> Path:
    path = PurePosixPath(text(value, where))
    if path.is_absolute() or ".." in path.parts:
        raise EvidenceError(f"{where} must stay inside the journey directory")
    resolved = (root / Path(*path.parts)).resolve()
    if root.resolve() not in (resolved, *resolved.parents):
        raise EvidenceError(f"{where} escapes the journey directory")
    return resolved


def reference(root: Path, value, where: str) -> Path:
    raw = exact(value, {"path", "sha256"}, where)
    path = safe_path(root, raw["path"], f"{where}.path")
    expected = text(raw["sha256"], f"{where}.sha256", SHA256)
    if not path.is_file():
        raise EvidenceError(f"{where} is missing {raw['path']}")
    actual = digest(path)
    if actual != expected:
        raise EvidenceError(f"{where} hash mismatch for {raw['path']}")
    return path


def scan_safety(paths):
    for path in paths:
        try:
            content = path.read_text(errors="strict")
        except UnicodeDecodeError:
            continue
        for label, pattern in UNSAFE_TEXT:
            if pattern.search(content):
                raise EvidenceError(f"unsafe retained field {label} in {path.name}")


def validate_record(root: Path, requirement: str, entry, revision: str, profile_id: str, profile_sha256: str):
    raw = exact(entry, {"requirementId", "record", "evidence"}, f"workflow.records.{requirement}")
    if raw["requirementId"] != requirement:
        raise EvidenceError("workflow record requirement ID mismatch")
    record_path = reference(root, raw["record"], f"workflow.records.{requirement}.record")
    evidence_path = reference(root, raw["evidence"], f"workflow.records.{requirement}.evidence")
    record = load_json(record_path)
    expected = {
        "requirementId": requirement,
        "repositoryHead": revision,
        "profileId": profile_id,
        "profileSha256": profile_sha256,
        "evidencePath": raw["evidence"]["path"],
        "evidenceSha256": raw["evidence"]["sha256"],
    }
    if not isinstance(record, dict) or any(record.get(key) != value for key, value in expected.items()):
        raise EvidenceError(f"workflow record does not bind {requirement} to its profile, revision, and evidence")
    if not isinstance(record.get("stageId"), str) or not isinstance(record.get("producer"), str):
        raise EvidenceError(f"workflow record lacks stage ownership for {requirement}")
    return record_path, evidence_path, record


def validate_descriptor(path: Path, route: str, profile, profile_sha256: str):
    descriptor = exact(load_json(path), {"version", "sequence", "profileId", "profileSha256", "coordinator", "capabilities", "assignments"}, "workflow.descriptor")
    if descriptor["version"] != 1 or not isinstance(descriptor["coordinator"], str) or not descriptor["coordinator"]:
        raise EvidenceError("workflow descriptor identity is invalid")
    if not isinstance(descriptor["sequence"], int) or descriptor["sequence"] < 1:
        raise EvidenceError("workflow descriptor route sequence is invalid")
    if descriptor["profileId"] != profile["id"] or descriptor["profileSha256"] != profile_sha256:
        raise EvidenceError("workflow descriptor profile does not match the candidate profile")
    if not isinstance(descriptor["capabilities"], list) or any(not isinstance(item, str) for item in descriptor["capabilities"]):
        raise EvidenceError("workflow descriptor capabilities are invalid")
    if len(set(descriptor["capabilities"])) != len(descriptor["capabilities"]):
        raise EvidenceError("workflow descriptor capabilities contain duplicates")
    declared = profile.get("hostCapabilities")
    if not isinstance(declared, list) or any(not isinstance(item, str) for item in declared):
        raise EvidenceError("candidate profile host capabilities are invalid")
    undeclared = set(descriptor["capabilities"]) - set(declared)
    if undeclared:
        raise EvidenceError(f"workflow descriptor contains undeclared capabilities {','.join(sorted(undeclared))}")
    if not isinstance(descriptor["assignments"], dict) or any(not isinstance(key, str) or not isinstance(value, str) or not value for key, value in descriptor["assignments"].items()):
        raise EvidenceError("workflow descriptor assignments are invalid")
    coordinator = descriptor["coordinator"]
    assignments = descriptor["assignments"]
    if route == "lightweight-engineering":
        if descriptor["capabilities"] or set(assignments) != {"intake", "route", "build", "verify"} or any(owner != coordinator for owner in assignments.values()):
            raise EvidenceError("lightweight workflow contains delegated orchestration")
    else:
        owners = {assignments.get("build"), assignments.get("review")}
        if "subagents" not in descriptor["capabilities"] or set(assignments) != {"shape", "build", "verify", "review", "delivery"} or coordinator in owners or len(owners) != 2:
            raise EvidenceError("Feature workflow lacks independent implementation and review ownership")
    return descriptor


def validate_receipt(root: Path, path: Path, route: str, revision: str, profile_id: str, profile_sha256: str, descriptor, record_entries):
    receipt = load_json(path)
    if not isinstance(receipt, dict) or receipt.get("version") != 1:
        raise EvidenceError("workflow receipt version is invalid")
    if receipt.get("profileId") != profile_id or receipt.get("profileSha256") != profile_sha256:
        raise EvidenceError("workflow receipt profile does not match the candidate profile")
    if receipt.get("repositoryHead") != revision:
        raise EvidenceError("workflow receipt belongs to a stale repository revision")
    verdict = receipt.get("verdict")
    if not isinstance(verdict, dict) or verdict.get("passed") is not True:
        raise EvidenceError("workflow receipt does not contain a passing verdict")
    if verdict.get("profileId") != profile_id or verdict.get("profileSha256") != profile_sha256:
        raise EvidenceError("workflow verdict profile does not match the candidate profile")
    if verdict.get("repositoryHead") != revision:
        raise EvidenceError("workflow verdict belongs to a stale repository revision")
    assignment_items = verdict.get("assignments")
    if not isinstance(assignment_items, list):
        raise EvidenceError("workflow receipt assignments are invalid")
    assignment_verdicts = {}
    for item in assignment_items:
        if not isinstance(item, dict) or not isinstance(item.get("stageId"), str):
            raise EvidenceError("workflow receipt assignment is invalid")
        stage = item["stageId"]
        if stage in assignment_verdicts:
            raise EvidenceError(f"workflow receipt has duplicate assignment {stage}")
        assignment_verdicts[stage] = item
    if set(assignment_verdicts) != set(descriptor["assignments"]):
        raise EvidenceError("workflow receipt assignments do not exactly match the active route")
    for stage, owner in descriptor["assignments"].items():
        if assignment_verdicts[stage] != {"stageId": stage, "state": "valid", "owner": owner}:
            raise EvidenceError(f"workflow receipt assignment does not match the active route for {stage}")
    gates = verdict.get("gates")
    if not isinstance(gates, list) or any(not isinstance(gate, dict) or gate.get("state") != "resolved" for gate in gates):
        raise EvidenceError("workflow receipt has an unresolved gate")
    requirements = verdict.get("requirements")
    if not isinstance(requirements, list):
        raise EvidenceError("workflow receipt requirements are invalid")
    states = {}
    record_paths = {}
    for item in requirements:
        if not isinstance(item, dict) or not isinstance(item.get("requirementId"), str):
            raise EvidenceError("workflow receipt requirement is invalid")
        requirement = item["requirementId"]
        if requirement in states:
            raise EvidenceError(f"workflow receipt has duplicate requirement {requirement}")
        states[requirement] = item.get("state")
        record_paths[requirement] = item.get("recordPath")
    expected = EXPECTED_REQUIREMENTS[route]
    if set(states) != expected:
        missing = expected - states.keys()
        extra = states.keys() - expected
        detail = ",".join(sorted(missing or extra))
        label = "missing" if missing else "extra"
        raise EvidenceError(f"workflow receipt has {label} requirements {detail}")
    bad = sorted(requirement for requirement in expected if states[requirement] != "satisfied")
    if bad:
        raise EvidenceError(f"workflow receipt has incomplete requirements {','.join(bad)}")
    if not isinstance(record_entries, list):
        raise EvidenceError("manifest.workflow.records is invalid")
    records = {}
    referenced = []
    for entry in record_entries:
        requirement = entry.get("requirementId") if isinstance(entry, dict) else None
        if not isinstance(requirement, str):
            raise EvidenceError("workflow record requirement ID is invalid")
        if requirement in records:
            raise EvidenceError(f"manifest.workflow.records has duplicate requirement {requirement}")
        records[requirement] = entry
    if set(records) != expected:
        raise EvidenceError("manifest.workflow.records does not exactly match route requirements")
    for requirement in sorted(expected):
        record_path, evidence_path, record = validate_record(root, requirement, records[requirement], revision, profile_id, profile_sha256)
        expected_path = records[requirement]["record"]["path"]
        literal_path = f"workflow/records/{descriptor['sequence']:06d}/{requirement}.json"
        if expected_path != literal_path:
            raise EvidenceError(f"workflow record path is not scoped to route sequence for {requirement}")
        if record_paths[requirement] != expected_path:
            raise EvidenceError(f"workflow receipt record path mismatch for {requirement}")
        if descriptor["assignments"].get(record["stageId"]) != record["producer"]:
            raise EvidenceError(f"workflow record producer does not match stage owner for {requirement}")
        referenced.extend([record_path, evidence_path])
    return gates, referenced


def validate_product(path: Path, route: str):
    proof = load_json(path)
    if not isinstance(proof, dict) or proof.get("passed") is not True:
        raise EvidenceError("product proof did not pass")
    if route == "lightweight-engineering":
        exact(proof, {"version", "passed", "changedPaths", "tokenChange", "checks"}, "productProof")
        if proof["version"] != 1 or proof["changedPaths"] != ["README.md"]:
            raise EvidenceError("lightweight product proof changed unexpected paths")
        if proof["tokenChange"] != {"before": "dependancies", "after": "dependencies", "count": 1}:
            raise EvidenceError("lightweight product proof is not the literal requested token change")
    else:
        exact(proof, {"version", "passed", "changedPaths", "legacyStdoutSha256Before", "legacyStdoutSha256After", "jsonValue", "expectedJsonValue", "checks"}, "productProof")
        if proof["version"] != 1 or proof["changedPaths"] != ["status.mjs"] or proof["legacyStdoutSha256Before"] != proof["legacyStdoutSha256After"]:
            raise EvidenceError("Feature product proof changed legacy text output")
        if proof["jsonValue"] != {"status": "ready"} or proof["expectedJsonValue"] != {"status": "ready"}:
            raise EvidenceError("Feature product proof JSON does not equal the literal expected object")
    if not isinstance(proof["checks"], list) or not proof["checks"] or any(not isinstance(item, str) or not item for item in proof["checks"]):
        raise EvidenceError("product proof checks are invalid")


def score(journey: Path, candidate_root: Path, expected_revision: str | None):
    manifest_path = journey / "manifest.json"
    manifest = exact(load_json(manifest_path), {"schemaVersion", "journeyId", "route", "provenance", "candidate", "prompt", "captures", "workflow", "productProof", "sanitization"}, "manifest")
    if manifest["schemaVersion"] != 1:
        raise EvidenceError("manifest.schemaVersion must be 1")
    journey_id = text(manifest["journeyId"], "manifest.journeyId", IDENTIFIER)
    route = manifest["route"]
    if route not in EXPECTED_REQUIREMENTS:
        raise EvidenceError("manifest.route is invalid")
    if manifest["provenance"] not in {"retained-fixture", "live"}:
        raise EvidenceError("manifest.provenance is invalid")
    candidate = exact(manifest["candidate"], {"repositoryRevision", "artifacts"}, "manifest.candidate")
    revision = text(candidate["repositoryRevision"], "manifest.candidate.repositoryRevision", REVISION)
    if expected_revision is not None and revision != expected_revision:
        raise EvidenceError(f"candidate revision mismatch: expected {expected_revision}, got {revision}")
    if not isinstance(candidate["artifacts"], list) or not candidate["artifacts"]:
        raise EvidenceError("manifest.candidate.artifacts must not be empty")
    artifact_names = [artifact.get("path") if isinstance(artifact, dict) else None for artifact in candidate["artifacts"]]
    if artifact_names != candidate_artifact_paths(route):
        raise EvidenceError("manifest.candidate.artifacts does not cover the required candidate files")
    is_git_candidate = git_candidate(candidate_root)
    for index, artifact in enumerate(candidate["artifacts"]):
        raw = exact(artifact, {"path", "sha256"}, f"manifest.candidate.artifacts[{index}]")
        path = safe_path(candidate_root, raw["path"], f"manifest.candidate.artifacts[{index}].path")
        expected = text(raw["sha256"], f"manifest.candidate.artifacts[{index}].sha256", SHA256)
        if not path.is_file() or digest(path) != expected:
            raise EvidenceError(f"candidate artifact mismatch for {raw['path']}")
        if is_git_candidate and revision_blob(candidate_root, revision, raw["path"]) != expected:
            raise EvidenceError(f"candidate revision artifact mismatch for {raw['path']}")
    profile = load_json(candidate_root / profile_path(route))
    profile_id = text(profile.get("id") if isinstance(profile, dict) else None, "candidate profile id")
    if profile.get("route") != route:
        raise EvidenceError("candidate profile route does not match manifest route")
    profile_sha256 = digest(candidate_root / profile_path(route))
    referenced = [manifest_path]
    prompt_path = reference(journey, manifest["prompt"], "manifest.prompt")
    referenced.append(prompt_path)
    prompt = prompt_path.read_text()
    for pattern in ROUTE_HINTS:
        if pattern.search(prompt):
            raise EvidenceError(f"prompt leaks route guidance matching {pattern.pattern}")
    captures = manifest["captures"]
    if not isinstance(captures, dict) or set(captures) != REQUIRED_CAPTURES:
        raise EvidenceError("manifest.captures has unknown or missing fields")
    referenced.extend(reference(journey, captures[name], f"manifest.captures.{name}") for name in sorted(captures))
    workflow = exact(manifest["workflow"], {"repositoryRevision", "descriptor", "receipt", "records"}, "manifest.workflow")
    workflow_revision = text(workflow["repositoryRevision"], "manifest.workflow.repositoryRevision", REVISION)
    descriptor_path = reference(journey, workflow["descriptor"], "manifest.workflow.descriptor")
    descriptor = validate_descriptor(descriptor_path, route, profile, profile_sha256)
    receipt_path = reference(journey, workflow["receipt"], "manifest.workflow.receipt")
    product_path = reference(journey, manifest["productProof"], "manifest.productProof")
    sanitation_path = reference(journey, manifest["sanitization"], "manifest.sanitization")
    referenced.extend([receipt_path, product_path, sanitation_path])
    sanitation = exact(load_json(sanitation_path), {"version", "passed", "removedFields", "notes"}, "sanitization")
    if sanitation["version"] != 1 or sanitation["passed"] is not True or not isinstance(sanitation["removedFields"], list) or not isinstance(sanitation["notes"], str):
        raise EvidenceError("sanitization report is invalid")
    gates, workflow_paths = validate_receipt(journey, receipt_path, route, workflow_revision, profile_id, profile_sha256, descriptor, workflow["records"])
    referenced.extend([descriptor_path, *workflow_paths])
    scan_safety(referenced)
    validate_product(product_path, route)
    return {
        "journeyId": journey_id,
        "candidateRevision": revision,
        "workflowRevision": workflow_revision,
        "route": route,
        "gateStatus": "resolved" if gates else "not-required",
        "productResult": "pass",
        "verdict": "PASS",
    }


def capture(args):
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    command = args.command
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        raise EvidenceError("capture requires a command after --")
    started = time.monotonic()
    timed_out = False
    stdout_path = output / "stdout.txt"
    stderr_path = output / "stderr.txt"
    with stdout_path.open("w") as stdout, stderr_path.open("w") as stderr:
        process = subprocess.Popen(command, cwd=args.cwd, text=True, stdout=stdout, stderr=stderr, start_new_session=True)
        try:
            exit_code = process.wait(timeout=args.timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
            exit_code = 124
    elapsed = time.monotonic() - started
    (output / "command.json").write_text(json.dumps({"argv": command, "timeoutSeconds": args.timeout}, sort_keys=True, indent=2) + "\n")
    (output / "exit.json").write_text(json.dumps({"exitCode": exit_code, "timedOut": timed_out, "elapsedSeconds": round(elapsed, 6)}, sort_keys=True, indent=2) + "\n")
    print(f"captured={output} exit={exit_code} timed_out={'yes' if timed_out else 'no'} elapsed_seconds={elapsed:.3f}")
    return exit_code


def write_json(path: Path, value):
    path.write_text(json.dumps(value, sort_keys=True, indent=2) + "\n")


def ref(path: Path, root: Path):
    return {"path": path.relative_to(root).as_posix(), "sha256": digest(path)}


def build_fixture(args):
    candidate_root = Path(args.candidate_root).resolve()
    fixture_root = candidate_root / "verification" / "verify-temari" / "fixtures" / ("organic-lightweight" if args.route == "lightweight-engineering" else "organic-feature")
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    prompt_path = output / "prompt.txt"
    prompt_path.write_bytes((fixture_root / "prompt.txt").read_bytes())
    capture_dir = output / "captures"
    capture_dir.mkdir()
    files = {
        "command": capture_dir / "command.json",
        "jsonl": capture_dir / "events.jsonl",
        "stdout": capture_dir / "stdout.txt",
        "stderr": capture_dir / "stderr.txt",
        "exit": capture_dir / "exit.json",
        "finalResponse": capture_dir / "final-response.txt",
        "initialTree": capture_dir / "initial-tree.txt",
        "finalTree": capture_dir / "final-tree.txt",
        "binaryDiff": capture_dir / "binary-diff.patch",
    }
    write_json(files["command"], {"fixture": fixture_root.name, "mode": "deterministic-replay"})
    files["jsonl"].write_text(json.dumps({"type": "route", "route": args.route}, sort_keys=True) + "\n")
    files["stdout"].write_text(f"route={args.route}\n")
    files["stderr"].write_text("")
    write_json(files["exit"], {"exitCode": 0, "timedOut": False})
    files["finalResponse"].write_text("Fixture replay completed. This is not a live model transcript.\n")
    initial_files = sorted(path.relative_to(fixture_root / "initial").as_posix() for path in (fixture_root / "initial").rglob("*") if path.is_file())
    final_files = sorted(path.relative_to(fixture_root / "expected").as_posix() for path in (fixture_root / "expected").rglob("*") if path.is_file() and not path.name.endswith(".stdout.txt"))
    files["initialTree"].write_text("\n".join(initial_files) + "\n")
    files["finalTree"].write_text("\n".join(final_files) + "\n")
    diff_lines = []
    for relative in sorted(set(initial_files) | set(final_files)):
        before_path = fixture_root / "initial" / relative
        after_path = fixture_root / "expected" / relative
        before = before_path.read_text().splitlines(keepends=True) if before_path.is_file() else []
        after = after_path.read_text().splitlines(keepends=True) if after_path.is_file() else []
        diff_lines.extend(difflib.unified_diff(before, after, fromfile=f"a/{relative}", tofile=f"b/{relative}"))
    files["binaryDiff"].write_text("".join(diff_lines))
    receipt_source = Path(args.receipt).resolve()
    receipt = load_json(receipt_source)
    workflow_dir = output / "workflow"
    route_paths = sorted((receipt_source.parent / "events" / "routes").glob("*.json"))
    if not route_paths:
        raise EvidenceError("workflow run has no route events")
    route = load_json(route_paths[-1])
    sequence = route["sequence"]
    records_dir = workflow_dir / "records" / f"{sequence:06d}"
    evidence_dir = workflow_dir / "evidence"
    records_dir.mkdir(parents=True)
    evidence_dir.mkdir()
    run = load_json(receipt_source.parent / "run.json")
    descriptor_path = workflow_dir / "descriptor.json"
    write_json(descriptor_path, {"version": route["version"], "sequence": sequence, "profileId": route["profileId"], "profileSha256": route["profileSha256"], "coordinator": run["coordinator"], "capabilities": route["capabilities"], "assignments": route["assignments"]})
    workflow_records = []
    for item in receipt["verdict"]["requirements"]:
        requirement = item["requirementId"]
        source_record = Path(item["recordPath"])
        if not source_record.is_absolute():
            source_record = receipt_source.parent / source_record
        record = load_json(source_record)
        source_evidence = receipt_source.parent / record["evidencePath"]
        evidence_path = evidence_dir / f"{requirement}.evidence"
        evidence_path.write_bytes(source_evidence.read_bytes())
        record_path = records_dir / f"{requirement}.json"
        record["evidencePath"] = evidence_path.relative_to(output).as_posix()
        write_json(record_path, record)
        item["recordPath"] = record_path.relative_to(output).as_posix()
        workflow_records.append({"requirementId": requirement, "record": ref(record_path, output), "evidence": ref(evidence_path, output)})
    receipt_path = workflow_dir / "receipt.json"
    write_json(receipt_path, receipt)
    product_path = output / "product-proof.json"
    if args.route == "lightweight-engineering":
        before = (fixture_root / "initial" / "README.md").read_text()
        after = (fixture_root / "expected" / "README.md").read_text()
        passed = before.count("dependancies") == 1 and after == before.replace("dependancies", "dependencies")
        product = {"version": 1, "passed": passed, "changedPaths": ["README.md"], "tokenChange": {"before": "dependancies", "after": "dependencies", "count": 1}, "checks": ["exact one-token replacement", "single changed path"]}
    else:
        command = fixture_root / "expected" / "status.mjs"
        legacy = subprocess.run(["node", str(command)], text=True, capture_output=True, check=True).stdout
        structured = subprocess.run(["node", str(command), "--json"], text=True, capture_output=True, check=True).stdout
        expected_legacy = (fixture_root / "expected" / "legacy.stdout.txt").read_text()
        expected_json = json.loads((fixture_root / "expected" / "json.stdout.txt").read_text())
        product = {"version": 1, "passed": legacy == expected_legacy and json.loads(structured) == expected_json, "changedPaths": ["status.mjs"], "legacyStdoutSha256Before": hashlib.sha256(expected_legacy.encode()).hexdigest(), "legacyStdoutSha256After": hashlib.sha256(legacy.encode()).hexdigest(), "jsonValue": json.loads(structured), "expectedJsonValue": expected_json, "checks": ["single product path", "legacy output byte equality", "literal parsed JSON equality"]}
    write_json(product_path, product)
    sanitation_path = output / "sanitization.json"
    write_json(sanitation_path, {"version": 1, "passed": True, "removedFields": ["absolute command cwd", "account identifiers", "transient model output"], "notes": "Retained fixture preserves only deterministic routing and product assertions."})
    artifact_paths = candidate_artifact_paths(args.route)
    manifest = {
        "schemaVersion": 1,
        "journeyId": args.journey_id,
        "route": args.route,
        "provenance": "retained-fixture",
        "candidate": {"repositoryRevision": args.revision, "artifacts": [{"path": value, "sha256": digest(candidate_root / value)} for value in artifact_paths]},
        "prompt": ref(prompt_path, output),
        "captures": {name: ref(path, output) for name, path in files.items()},
        "workflow": {"repositoryRevision": receipt["repositoryHead"], "descriptor": ref(descriptor_path, output), "receipt": ref(receipt_path, output), "records": workflow_records},
        "productProof": ref(product_path, output),
        "sanitization": ref(sanitation_path, output),
    }
    write_json(output / "manifest.json", manifest)
    result = score(output, candidate_root, args.revision)
    print(" ".join(f"{key}={value}" for key, value in result.items()))
    return 0


def parser():
    root = argparse.ArgumentParser(description="Capture and score Temari routing journey evidence")
    commands = root.add_subparsers(dest="command_name", required=True)
    score_command = commands.add_parser("score")
    score_command.add_argument("journey")
    score_command.add_argument("--candidate-root", required=True)
    score_command.add_argument("--expected-revision")
    score_command.add_argument("--json", action="store_true")
    capture_command = commands.add_parser("capture")
    capture_command.add_argument("--output", required=True)
    capture_command.add_argument("--cwd", required=True)
    capture_command.add_argument("--timeout", required=True, type=float)
    capture_command.add_argument("command", nargs=argparse.REMAINDER)
    fixture_command = commands.add_parser("build-fixture")
    fixture_command.add_argument("--output", required=True)
    fixture_command.add_argument("--candidate-root", required=True)
    fixture_command.add_argument("--revision", required=True)
    fixture_command.add_argument("--route", choices=sorted(EXPECTED_REQUIREMENTS), required=True)
    fixture_command.add_argument("--journey-id", required=True)
    fixture_command.add_argument("--receipt", required=True)
    return root


def main():
    args = parser().parse_args()
    try:
        if args.command_name == "capture":
            return capture(args)
        if args.command_name == "build-fixture":
            return build_fixture(args)
        result = score(Path(args.journey).resolve(), Path(args.candidate_root).resolve(), args.expected_revision)
        if args.json:
            print(json.dumps(result, sort_keys=True))
        else:
            print(" ".join(f"{key}={value}" for key, value in result.items()))
        return 0
    except EvidenceError as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
