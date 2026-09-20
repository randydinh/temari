#!/usr/bin/env python3
import hashlib
import importlib.util
import json
import os
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("journey-evidence.py")
SPEC = importlib.util.spec_from_file_location("journey_evidence", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class JourneyEvidenceTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.candidate = self.root / "candidate"
        self.journey = self.root / "journey"
        self.candidate.mkdir()
        self.journey.mkdir()
        self.revision = "a" * 40
        self.workflow_revision = "b" * 40
        self.write_journey("lightweight-engineering")

    def tearDown(self):
        self.temporary.cleanup()

    def ref(self, name, value):
        path = self.journey / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(value, (dict, list)):
            path.write_text(json.dumps(value, sort_keys=True, indent=2) + "\n")
        else:
            path.write_text(value)
        return {"path": name, "sha256": sha(path)}

    def write_journey(self, route):
        for relative in MODULE.candidate_artifact_paths(route):
            path = self.candidate / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            if relative == MODULE.profile_path(route):
                profile_id = "lightweight-engineering-v1" if route == "lightweight-engineering" else "feature-v1"
                capabilities = [] if route == "lightweight-engineering" else ["subagents", "forge"]
                path.write_text(json.dumps({"id": profile_id, "route": route, "hostCapabilities": capabilities}) + "\n")
            else:
                path.write_text(f"{relative}\n")
        profile_id = "lightweight-engineering-v1" if route == "lightweight-engineering" else "feature-v1"
        profile_sha256 = sha(self.candidate / MODULE.profile_path(route))
        prompt = "Fix the misspelling 'dependancies' in this README and check the diff.\n" if route == "lightweight-engineering" else "Add a --json flag to this command. Existing text output must remain byte-identical.\n"
        prompt_ref = self.ref("prompt.txt", prompt)
        captures = {}
        for name in MODULE.REQUIRED_CAPTURES:
            captures[name] = self.ref(f"{name}.txt", f"{name}\n")
        requirements = []
        records = []
        coordinator = "coordinator"
        assignments = {"intake": coordinator, "route": coordinator, "build": coordinator, "verify": coordinator}
        capabilities = []
        if route == "feature":
            assignments = {"shape": coordinator, "build": "implementer", "verify": coordinator, "review": "reviewer", "delivery": coordinator}
            capabilities = ["subagents"]
        for requirement in sorted(MODULE.EXPECTED_REQUIREMENTS[route]):
            stage = requirement.split(".")[1]
            evidence_ref = self.ref(f"workflow/evidence/{requirement}.evidence", f"evidence for {requirement}\n")
            record = {
                "requirementId": requirement,
                "stageId": stage,
                "producer": assignments[stage],
                "repositoryHead": self.workflow_revision,
                "profileId": profile_id,
                "profileSha256": profile_sha256,
                "evidencePath": evidence_ref["path"],
                "evidenceSha256": evidence_ref["sha256"],
            }
            record_ref = self.ref(f"workflow/records/000001/{requirement}.json", record)
            requirements.append({"requirementId": requirement, "state": "satisfied", "recordPath": record_ref["path"]})
            records.append({"requirementId": requirement, "record": record_ref, "evidence": evidence_ref})
        receipt = {
            "version": 1,
            "profileId": profile_id,
            "profileSha256": profile_sha256,
            "repositoryHead": self.workflow_revision,
            "verdict": {
                "passed": True,
                "profileId": profile_id,
                "profileSha256": profile_sha256,
                "repositoryHead": self.workflow_revision,
                "assignments": [{"stageId": stage, "state": "valid", "owner": owner} for stage, owner in assignments.items()],
                "requirements": requirements,
                "gates": [{"gateId": "operator-approval", "state": "resolved"}],
            },
        }
        receipt_ref = self.ref("receipt.json", receipt)
        descriptor_ref = self.ref("workflow/descriptor.json", {"version": 1, "sequence": 1, "profileId": profile_id, "profileSha256": profile_sha256, "coordinator": coordinator, "capabilities": capabilities, "assignments": assignments})
        if route == "lightweight-engineering":
            proof = {
                "version": 1,
                "passed": True,
                "changedPaths": ["README.md"],
                "tokenChange": {"before": "dependancies", "after": "dependencies", "count": 1},
                "checks": ["literal diff"],
            }
        else:
            proof = {
                "version": 1,
                "passed": True,
                "changedPaths": ["status.mjs"],
                "legacyStdoutSha256Before": "b" * 64,
                "legacyStdoutSha256After": "b" * 64,
                "jsonValue": {"status": "ready"},
                "expectedJsonValue": {"status": "ready"},
                "checks": ["golden bytes", "literal JSON"],
            }
        proof_ref = self.ref("product-proof.json", proof)
        sanitation_ref = self.ref("sanitization.json", {"version": 1, "passed": True, "removedFields": [], "notes": "fixture contains no account data"})
        manifest = {
            "schemaVersion": 1,
            "journeyId": "fixture-journey",
            "route": route,
            "provenance": "retained-fixture",
            "candidate": {
                "repositoryRevision": self.revision,
                "artifacts": [{"path": relative, "sha256": sha(self.candidate / relative)} for relative in MODULE.candidate_artifact_paths(route)],
            },
            "prompt": prompt_ref,
            "captures": captures,
            "workflow": {"repositoryRevision": self.workflow_revision, "descriptor": descriptor_ref, "receipt": receipt_ref, "records": records},
            "productProof": proof_ref,
            "sanitization": sanitation_ref,
        }
        (self.journey / "manifest.json").write_text(json.dumps(manifest, sort_keys=True, indent=2) + "\n")

    def score(self):
        return MODULE.score(self.journey, self.candidate, self.revision)

    def test_scores_valid_lightweight_journey(self):
        self.assertEqual(self.score()["verdict"], "PASS")

    def test_scores_valid_feature_journey(self):
        self.write_journey("feature")
        self.assertEqual(self.score()["route"], "feature")

    def test_organic_lightweight_fixture_changes_one_token(self):
        fixture = SCRIPT.parents[1] / "fixtures" / "organic-lightweight"
        before = (fixture / "initial" / "README.md").read_text()
        after = (fixture / "expected" / "README.md").read_text()
        self.assertEqual(before.count("dependancies"), 1)
        self.assertEqual(after, before.replace("dependancies", "dependencies"))
        self.assertFalse(any(pattern.search((fixture / "prompt.txt").read_text()) for pattern in MODULE.ROUTE_HINTS))
        self.assertEqual((fixture / "initial" / "AGENTS.md").read_bytes(), (fixture / "expected" / "AGENTS.md").read_bytes())

    def test_organic_feature_fixture_preserves_text_and_adds_json(self):
        fixture = SCRIPT.parents[1] / "fixtures" / "organic-feature"
        command = fixture / "expected" / "status.mjs"
        legacy = subprocess.run(["node", str(command)], text=True, capture_output=True, check=True)
        structured = subprocess.run(["node", str(command), "--json"], text=True, capture_output=True, check=True)
        self.assertEqual(legacy.stdout, (fixture / "expected" / "legacy.stdout.txt").read_text())
        self.assertEqual(json.loads(structured.stdout), {"status": "ready"})
        self.assertEqual(structured.stdout, (fixture / "expected" / "json.stdout.txt").read_text())
        self.assertFalse(any(pattern.search((fixture / "prompt.txt").read_text()) for pattern in MODULE.ROUTE_HINTS))
        self.assertEqual((fixture / "initial" / "AGENTS.md").read_bytes(), (fixture / "expected" / "AGENTS.md").read_bytes())

    def test_project_policy_invokes_temari_without_selecting_a_route(self):
        fixtures = SCRIPT.parents[1] / "fixtures"
        policies = [(fixtures / name / "initial" / "AGENTS.md").read_text() for name in ("organic-lightweight", "organic-feature")]
        self.assertEqual(policies[0], policies[1])
        self.assertIn("Use the installed Temari skill", policies[0])
        self.assertIn("does not select a route", policies[0])
        self.assertIn("outside the repository", policies[0])
        self.assertIn("do not add evidence directories or files to the product diff", policies[0])
        self.assertNotIn("lightweight-engineering", policies[0])
        self.assertNotIn("Feature", policies[0])

    def test_rejects_route_hint(self):
        (self.journey / "prompt.txt").write_text("Use the lightweight route.\n")
        manifest = json.loads((self.journey / "manifest.json").read_text())
        manifest["prompt"]["sha256"] = sha(self.journey / "prompt.txt")
        (self.journey / "manifest.json").write_text(json.dumps(manifest))
        with self.assertRaisesRegex(MODULE.EvidenceError, "leaks route guidance"):
            self.score()

    def test_rejects_stale_revision(self):
        with self.assertRaisesRegex(MODULE.EvidenceError, "candidate revision mismatch"):
            MODULE.score(self.journey, self.candidate, "b" * 40)

    def test_rejects_stale_candidate_hash(self):
        relative = MODULE.candidate_artifact_paths("lightweight-engineering")[0]
        (self.candidate / relative).write_text("changed\n")
        with self.assertRaisesRegex(MODULE.EvidenceError, "candidate artifact mismatch"):
            self.score()

    def test_rejects_unbound_git_candidate_revision(self):
        subprocess.run(["git", "init", "-q", str(self.candidate)], check=True)
        subprocess.run(["git", "-C", str(self.candidate), "add", "."], check=True)
        subprocess.run(["git", "-C", str(self.candidate), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"], check=True)
        with self.assertRaisesRegex(MODULE.EvidenceError, "candidate revision does not contain"):
            self.score()

    def test_rejects_profile_route_mismatch(self):
        path = self.candidate / MODULE.profile_path("lightweight-engineering")
        profile = json.loads(path.read_text())
        profile["route"] = "feature"
        path.write_text(json.dumps(profile) + "\n")
        manifest = json.loads((self.journey / "manifest.json").read_text())
        for artifact in manifest["candidate"]["artifacts"]:
            if artifact["path"] == MODULE.profile_path("lightweight-engineering"):
                artifact["sha256"] = sha(path)
        (self.journey / "manifest.json").write_text(json.dumps(manifest))
        with self.assertRaisesRegex(MODULE.EvidenceError, "profile route"):
            self.score()

    def test_rejects_missing_capture(self):
        (self.journey / "stdout.txt").unlink()
        with self.assertRaisesRegex(MODULE.EvidenceError, "is missing stdout.txt"):
            self.score()

    def test_rejects_missing_workflow_receipt(self):
        (self.journey / "receipt.json").unlink()
        with self.assertRaisesRegex(MODULE.EvidenceError, "is missing receipt.json"):
            self.score()

    def test_rejects_open_gate(self):
        receipt = json.loads((self.journey / "receipt.json").read_text())
        receipt["verdict"]["gates"][0]["state"] = "open"
        self.rewrite_reference("workflow.receipt", "receipt.json", receipt)
        with self.assertRaisesRegex(MODULE.EvidenceError, "unresolved gate"):
            self.score()

    def test_rejects_lightweight_over_orchestration(self):
        descriptor = json.loads((self.journey / "workflow/descriptor.json").read_text())
        descriptor["assignments"]["build"] = "worker"
        self.rewrite_reference("workflow.descriptor", "workflow/descriptor.json", descriptor)
        with self.assertRaisesRegex(MODULE.EvidenceError, "delegated orchestration"):
            self.score()

    def test_rejects_feature_under_orchestration(self):
        self.write_journey("feature")
        descriptor = json.loads((self.journey / "workflow/descriptor.json").read_text())
        descriptor["assignments"]["review"] = descriptor["coordinator"]
        self.rewrite_reference("workflow.descriptor", "workflow/descriptor.json", descriptor)
        with self.assertRaisesRegex(MODULE.EvidenceError, "lacks independent implementation and review"):
            self.score()

    def test_rejects_descriptor_for_wrong_route_event_profile(self):
        descriptor = json.loads((self.journey / "workflow/descriptor.json").read_text())
        descriptor["profileId"] = "feature-v1"
        self.rewrite_reference("workflow.descriptor", "workflow/descriptor.json", descriptor)
        with self.assertRaisesRegex(MODULE.EvidenceError, "descriptor profile"):
            self.score()

    def test_rejects_duplicate_route_capability(self):
        self.write_journey("feature")
        descriptor = json.loads((self.journey / "workflow/descriptor.json").read_text())
        descriptor["capabilities"].append("subagents")
        self.rewrite_reference("workflow.descriptor", "workflow/descriptor.json", descriptor)
        with self.assertRaisesRegex(MODULE.EvidenceError, "capabilities contain duplicates"):
            self.score()

    def test_rejects_undeclared_route_capability(self):
        self.write_journey("feature")
        descriptor = json.loads((self.journey / "workflow/descriptor.json").read_text())
        descriptor["capabilities"].append("unknown")
        self.rewrite_reference("workflow.descriptor", "workflow/descriptor.json", descriptor)
        with self.assertRaisesRegex(MODULE.EvidenceError, "undeclared capabilities unknown"):
            self.score()

    def test_rejects_record_path_outside_active_route_sequence(self):
        manifest = json.loads((self.journey / "manifest.json").read_text())
        entry = manifest["workflow"]["records"][0]
        old_path = self.journey / entry["record"]["path"]
        new_path = self.journey / "workflow/records/000002" / old_path.name
        new_path.parent.mkdir(parents=True)
        old_path.replace(new_path)
        entry["record"] = {"path": new_path.relative_to(self.journey).as_posix(), "sha256": sha(new_path)}
        receipt = json.loads((self.journey / "receipt.json").read_text())
        requirement = entry["requirementId"]
        next(item for item in receipt["verdict"]["requirements"] if item["requirementId"] == requirement)["recordPath"] = entry["record"]["path"]
        (self.journey / "receipt.json").write_text(json.dumps(receipt, sort_keys=True, indent=2) + "\n")
        manifest["workflow"]["receipt"]["sha256"] = sha(self.journey / "receipt.json")
        (self.journey / "manifest.json").write_text(json.dumps(manifest, sort_keys=True, indent=2) + "\n")
        with self.assertRaisesRegex(MODULE.EvidenceError, "not scoped to route sequence"):
            self.score()

    def test_rejects_feature_receipt_without_review_requirement(self):
        self.write_journey("feature")
        receipt = json.loads((self.journey / "receipt.json").read_text())
        receipt["verdict"]["requirements"] = [item for item in receipt["verdict"]["requirements"] if item["requirementId"] != "feature.review.ordered-commits"]
        self.rewrite_reference("workflow.receipt", "receipt.json", receipt)
        with self.assertRaisesRegex(MODULE.EvidenceError, "missing requirements feature.review.ordered-commits"):
            self.score()

    def test_rejects_record_producer_that_is_not_stage_owner(self):
        self.write_journey("feature")
        manifest = json.loads((self.journey / "manifest.json").read_text())
        entry = next(item for item in manifest["workflow"]["records"] if item["requirementId"] == "feature.build.delegated-implementation")
        record_path = self.journey / entry["record"]["path"]
        record = json.loads(record_path.read_text())
        record["producer"] = "coordinator"
        record_path.write_text(json.dumps(record, sort_keys=True, indent=2) + "\n")
        entry["record"]["sha256"] = sha(record_path)
        (self.journey / "manifest.json").write_text(json.dumps(manifest, sort_keys=True, indent=2) + "\n")
        with self.assertRaisesRegex(MODULE.EvidenceError, "producer does not match"):
            self.score()

    def test_rejects_failed_product_assertion(self):
        proof = json.loads((self.journey / "product-proof.json").read_text())
        proof["passed"] = False
        self.rewrite_reference("productProof", "product-proof.json", proof)
        with self.assertRaisesRegex(MODULE.EvidenceError, "did not pass"):
            self.score()

    def test_rejects_unsafe_retained_field(self):
        (self.journey / "stderr.txt").write_text("/Users/example/private\n")
        manifest = json.loads((self.journey / "manifest.json").read_text())
        manifest["captures"]["stderr"]["sha256"] = sha(self.journey / "stderr.txt")
        (self.journey / "manifest.json").write_text(json.dumps(manifest))
        with self.assertRaisesRegex(MODULE.EvidenceError, "unsafe retained field"):
            self.score()

    def test_rejects_tampered_evidence(self):
        (self.journey / "finalResponse.txt").write_text("tampered\n")
        with self.assertRaisesRegex(MODULE.EvidenceError, "hash mismatch"):
            self.score()

    def test_rejects_wrong_receipt_profile_id(self):
        receipt = json.loads((self.journey / "receipt.json").read_text())
        receipt["profileId"] = "feature-v1"
        self.rewrite_reference("workflow.receipt", "receipt.json", receipt)
        with self.assertRaisesRegex(MODULE.EvidenceError, "receipt profile"):
            self.score()

    def test_rejects_wrong_receipt_profile_hash(self):
        receipt = json.loads((self.journey / "receipt.json").read_text())
        receipt["profileSha256"] = "c" * 64
        self.rewrite_reference("workflow.receipt", "receipt.json", receipt)
        with self.assertRaisesRegex(MODULE.EvidenceError, "receipt profile"):
            self.score()

    def test_rejects_wrong_verdict_profile_hash(self):
        receipt = json.loads((self.journey / "receipt.json").read_text())
        receipt["verdict"]["profileSha256"] = "c" * 64
        self.rewrite_reference("workflow.receipt", "receipt.json", receipt)
        with self.assertRaisesRegex(MODULE.EvidenceError, "verdict profile"):
            self.score()

    def test_rejects_duplicate_requirement(self):
        receipt = json.loads((self.journey / "receipt.json").read_text())
        receipt["verdict"]["requirements"].append(dict(receipt["verdict"]["requirements"][0]))
        self.rewrite_reference("workflow.receipt", "receipt.json", receipt)
        with self.assertRaisesRegex(MODULE.EvidenceError, "duplicate requirement"):
            self.score()

    def test_rejects_duplicate_receipt_assignment(self):
        receipt = json.loads((self.journey / "receipt.json").read_text())
        receipt["verdict"]["assignments"].append(dict(receipt["verdict"]["assignments"][0]))
        self.rewrite_reference("workflow.receipt", "receipt.json", receipt)
        with self.assertRaisesRegex(MODULE.EvidenceError, "duplicate assignment"):
            self.score()

    def test_rejects_receipt_assignment_owner_mismatch(self):
        receipt = json.loads((self.journey / "receipt.json").read_text())
        receipt["verdict"]["assignments"][0]["owner"] = "intruder"
        self.rewrite_reference("workflow.receipt", "receipt.json", receipt)
        with self.assertRaisesRegex(MODULE.EvidenceError, "assignment does not match"):
            self.score()

    def test_rejects_extra_requirement(self):
        receipt = json.loads((self.journey / "receipt.json").read_text())
        receipt["verdict"]["requirements"].append({"requirementId": "lightweight.extra", "state": "satisfied", "recordPath": "extra.json"})
        self.rewrite_reference("workflow.receipt", "receipt.json", receipt)
        with self.assertRaisesRegex(MODULE.EvidenceError, "extra requirements"):
            self.score()

    def test_rejects_duplicate_record_requirement(self):
        manifest = json.loads((self.journey / "manifest.json").read_text())
        manifest["workflow"]["records"].append(dict(manifest["workflow"]["records"][0]))
        (self.journey / "manifest.json").write_text(json.dumps(manifest))
        with self.assertRaisesRegex(MODULE.EvidenceError, "records has duplicate requirement"):
            self.score()

    def test_capture_streams_and_kills_process_group(self):
        output = self.root / "capture"
        child_pid = self.root / "child.pid"
        code = (
            "import pathlib,subprocess,sys,time;"
            "print('started',flush=True);"
            f"p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)']);pathlib.Path({str(child_pid)!r}).write_text(str(p.pid));"
            "time.sleep(30)"
        )
        args = type("Args", (), {"output": str(output), "cwd": str(self.root), "timeout": 0.4, "command": ["--", os.sys.executable, "-c", code]})()
        result = {}
        thread = threading.Thread(target=lambda: result.setdefault("exit", MODULE.capture(args)))
        thread.start()
        for _ in range(30):
            if (output / "stdout.txt").is_file() and "started" in (output / "stdout.txt").read_text():
                break
            time.sleep(0.02)
        self.assertIn("started", (output / "stdout.txt").read_text())
        thread.join(timeout=3)
        self.assertEqual(result["exit"], 124)
        pid = int(child_pid.read_text())
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def rewrite_reference(self, field, name, value):
        (self.journey / name).write_text(json.dumps(value, sort_keys=True, indent=2) + "\n")
        manifest = json.loads((self.journey / "manifest.json").read_text())
        target = manifest
        parts = field.split(".")
        for part in parts[:-1]:
            target = target[part]
        target[parts[-1]]["sha256"] = sha(self.journey / name)
        (self.journey / "manifest.json").write_text(json.dumps(manifest, sort_keys=True, indent=2) + "\n")


if __name__ == "__main__":
    unittest.main()
