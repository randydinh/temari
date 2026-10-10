"""Build the tracked P-stack capability graph from bundled source files."""

from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).with_name("graph.json")
SKILLS = ROOT / "packages/workflow-runtime/assets/v4.1/skills"
PLAYBOOKS = SKILLS / "poteto-mode/playbooks"

TEMARI_ENTRY_SKILLS = {"temari", "closeout", "merge-reconciliation"}
TEMARI_PROGRAM_POLICY_PLAYBOOKS = {
    "autonomous-run",
    "orchestrate",
    "autopilot-full",
    "autopilot-stack",
    "multi-phase-plan",
}
TEMARI_LIFECYCLE_SELECTION_PLAYBOOKS = {"session-pickup", "pause-safely"}
OPTIONAL_SKILLS = {"make-bot-ui", "setup-pstack", "automate-me", "reflect", "bro"}


def relative(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def description(source: str) -> str:
    header = source.split("---", 2)[1]
    lines = header.splitlines()
    for index, line in enumerate(lines):
        if not line.startswith("description:"):
            continue
        value = line.partition(":")[2].strip()
        if value in {">-", "|"}:
            return " ".join(
                part.strip()
                for part in lines[index + 1 :]
                if part.startswith("  ") and part.strip()
            )
        return value.strip('"')
    raise ValueError("missing description")


nodes: dict[str, dict] = {}
edges: dict[tuple[str, str, str, str], dict] = {}


def node(identifier: str, kind: str, label: str, **fields: object) -> None:
    if identifier in nodes:
        raise ValueError(f"duplicate node {identifier}")
    nodes[identifier] = {"id": identifier, "kind": kind, "label": label, **fields}


def edge(source: str, target: str, relation: str, basis: str, evidence: str) -> None:
    key = (source, target, relation, basis)
    edges[key] = {
        "from": source,
        "to": target,
        "relation": relation,
        "basis": basis,
        "evidence": evidence,
    }


for identifier, label in (
    ("temari", "Temari"),
    ("poteto", "Poteto"),
    ("runtime", "Temari runtime"),
    ("host", "Host adapter"),
):
    node(f"owner:{identifier}", "owner", label)

node(
    "component:archon",
    "harness",
    "Managed Archon",
    source="libs/archon-harness/src/lib/archon-harness.ts",
)
node(
    "component:execution-harness",
    "contract",
    "ExecutionHarness port",
    source="libs/contracts/src/lib/execution-harness.ts",
)
node(
    "component:orch-store",
    "legacy-runtime",
    "Orchestrate plain-file store",
    source="packages/workflow-runtime/assets/v4.1/skills/poteto-mode/scripts/orch/store.ts",
)
node(
    "component:pstack-v4.1",
    "bundle",
    "Bundled P-stack v4.1 catalog",
    source="packages/workflow-runtime/assets/v4.1/UPSTREAM.md",
)
for identifier, label, url in (
    ("third-party", "Third-party MCP marketplace", "https://github.com/cursor/plugins/tree/main/third_party"),
    ("ralph-loop", "Ralph Loop", "https://github.com/cursor/plugins/tree/main/ralph-loop"),
    ("benny", "Benny automation pack", "https://github.com/cursor/plugins/tree/main/pstack/automations/benny"),
    ("overnight-guide", "P-stack overnight guide", "https://github.com/cursor/plugins/blob/main/pstack/docs/guide/07-overnight.md"),
):
    node(f"external:{identifier}", "external", label, upstream=url)

public_root = ROOT / "packages/workflow-runtime/public"
policy = json.loads((public_root / "policy.json").read_text())
if set(policy["entries"]) != {"temari", "poteto-mode", "closeout"}:
    raise ValueError("reviewed public policy entries changed")
public_skill_files = sorted((public_root / "skills").glob("*/SKILL.md"))
if {path.parent.name for path in public_skill_files} != {
    "temari", "poteto-mode", "closeout", "qa-review-verification", "temari-knowledge", "qa-triage"
}:
    raise ValueError("reviewed public skill inventory changed")
node("public:policy", "admission", "Public admission policy", source=relative(public_root / "policy.json"))
method_guide = public_root / "skills/temari/references/method-library.md"
node("public:method-guide", "reference", "Installed P-stack method loading", source=relative(method_guide))
node("public:method-library", "bundle", "Complete portable P-stack method library", source="tools/pstack-method-library.mjs")
edge("public:method-guide", "public:method-library", "loads_internal_method", "documented", relative(method_guide))
edge("public:method-library", "component:pstack-v4.1", "packages_portable_inventory", "documented", "tools/pstack-method-library.mjs")
edge("public:policy", "public:method-library", "retains_execution_admission", "documented", relative(method_guide))
for entry_name in ("temari", "poteto-mode", "closeout"):
    entry_path = public_root / "skills" / entry_name / "SKILL.md"
    node(f"public-entry:{entry_name}", "public-entry", entry_name, source=relative(entry_path))
    edge("public:policy", f"public-entry:{entry_name}", "declares_entry", "documented", relative(public_root / "policy.json"))
    edge(f"public-entry:{entry_name}", f"skill:{entry_name}", "adapts_source_skill", "documented", relative(entry_path))
    edge(f"public-entry:{entry_name}", "public:method-guide", "references_method_library", "source_reference", relative(entry_path))
qa_public = public_root / "skills/qa-review-verification/SKILL.md"
node("public-skill:qa-review-verification", "public-skill", "QA verification", source=relative(qa_public))
edge("public-entry:temari", "public-skill:qa-review-verification", "invokes_supporting_skill", "documented", relative(public_root / "skills/temari/SKILL.md"))
triage_public = public_root / "skills/qa-triage/SKILL.md"
triage_playbook = public_root / "skills/qa-triage/references/issue-triage-v1.md"
triage_note = public_root / "skills/qa-triage/assets/triage-note.md"
acceptance_public = public_root / "qa/ticket-acceptance-v1.md"
node("public-skill:qa-triage", "public-skill", "QA Triage", source=relative(triage_public))
node("public-playbook:issue-triage-v1", "public-playbook", "Issue triage v1", source=relative(triage_playbook))
node("public-template:triage-note", "template", "Compact triage handoff", source=relative(triage_note))
node("public-playbook:ticket-acceptance-v1", "public-playbook", "Ticket acceptance QA v1", source=relative(acceptance_public))
for entry_name in ("temari", "poteto-mode"):
    edge(f"public-entry:{entry_name}", "public-skill:qa-triage", "invokes_supporting_skill", "documented", relative(public_root / "skills" / entry_name / "SKILL.md"))
edge("public-skill:qa-triage", "public-playbook:issue-triage-v1", "uses_playbook", "source_reference", relative(triage_public))
edge("public-playbook:issue-triage-v1", "public-template:triage-note", "produces_handoff", "source_reference", relative(triage_playbook))
edge("public-playbook:ticket-acceptance-v1", "public-skill:qa-triage", "optional_failure_analysis", "source_reference", relative(acceptance_public))
edge("public-skill:qa-triage", "public-skill:qa-review-verification", "hands_off_reporting", "source_reference", relative(triage_public))
edge("public-skill:qa-triage", "owner:temari", "intent_authority_lifecycle", "documented", relative(triage_public))
edge("public-skill:qa-triage", "owner:poteto", "hands_off_authorized_repair", "documented", relative(triage_public))

knowledge_public = public_root / "skills/temari-knowledge/SKILL.md"
node("public-skill:temari-knowledge", "public-skill", "Temari Knowledge", source=relative(knowledge_public))

skill_files = sorted(SKILLS.glob("*/SKILL.md"))
playbook_files = sorted(PLAYBOOKS.glob("*.md"))
if len(skill_files) != 53 or len(playbook_files) != 24:
    raise ValueError(
        f"reviewed inventory changed: {len(skill_files)} skills, {len(playbook_files)} playbooks"
    )

for path in skill_files:
    name = path.parent.name
    source = relative(path)
    kind = "principle" if name.startswith("principle-") else "skill"
    node(f"{kind}:{name}", kind, name, source=source, description=description(path.read_text()))
    edge(f"{kind}:{name}", "component:pstack-v4.1", "bundled_in", "documented", source)
    if name in TEMARI_ENTRY_SKILLS:
        edge(f"{kind}:{name}", "owner:temari", "current_entry", "documented", source)
    elif name == "poteto-mode":
        edge(f"{kind}:{name}", "owner:poteto", "current_entry", "documented", source)
    if name == "recall":
        edge(f"{kind}:{name}", "owner:temari", "lifecycle_candidate", "review_recommendation", "docs/pstack-audit/index.md")
    if name in OPTIONAL_SKILLS:
        edge(f"{kind}:{name}", "owner:host", "optional_capability", "review_recommendation", "docs/pstack-audit/index.md")

for path in playbook_files:
    name = path.stem
    source = relative(path)
    text = path.read_text()
    title = text.splitlines()[0].lstrip("# ").strip()
    node(f"playbook:{name}", "playbook", title, source=source)
    edge(f"skill:poteto-mode", f"playbook:{name}", "routes_to", "documented", relative(SKILLS / "poteto-mode/SKILL.md"))
    edge(f"playbook:{name}", "owner:poteto", "current_method_catalog", "documented", relative(SKILLS / "poteto-mode/SKILL.md"))
    if name in TEMARI_PROGRAM_POLICY_PLAYBOOKS:
        edge(f"playbook:{name}", "owner:temari", "program_policy", "documented", "docs/decisions/2026-09-30-temari-program-ownership.md")
    if name in TEMARI_LIFECYCLE_SELECTION_PLAYBOOKS:
        edge(f"playbook:{name}", "owner:temari", "lifecycle_selection", "documented", relative(SKILLS / "temari/SKILL.md"))
    if name in {"babysit", "shipping", "worktree-cleanup", "opening-a-pr"}:
        edge(f"playbook:{name}", "owner:host", "mechanical_execution", "review_recommendation", "docs/pstack-audit/index.md")

# Source-linked relationships are limited to literal references in bundled
# source. They are separate from the recommendations above.
all_paths = skill_files + playbook_files
for path in all_paths:
    name = path.parent.name if path.name == "SKILL.md" else path.stem
    origin = (
        ("principle:" if name.startswith("principle-") else "skill:")
        if path.name == "SKILL.md"
        else "playbook:"
    ) + name
    source = relative(path)
    content = path.read_text()
    for target_name in set(re.findall(r"\b(principle-[a-z0-9-]+)\b", content)):
        target = f"principle:{target_name}"
        if target in nodes and target != origin:
            edge(origin, target, "invokes_principle", "source_reference", source)
    for target_name in set(re.findall(r"([a-z][a-z0-9-]+)/SKILL\.md", content)):
        target = f"skill:{target_name}"
        if target in nodes and target != origin:
            edge(origin, target, "references_skill", "source_reference", source)
    if path.parent == PLAYBOOKS:
        for target_name in set(re.findall(r"playbooks/([a-z][a-z0-9-]+)\.md", content)):
            target = f"playbook:{target_name}"
            if target in nodes and target != origin:
                edge(origin, target, "references_playbook", "source_reference", source)

edge("owner:temari", "skill:poteto-mode", "routes_engineering_to", "documented", relative(SKILLS / "temari/SKILL.md"))
edge("owner:runtime", "component:execution-harness", "selects", "documented", "docs/decisions/2026-09-22-archon-harness.md")
edge("component:archon", "component:execution-harness", "implements", "documented", "docs/decisions/2026-09-22-archon-harness.md")
edge("playbook:orchestrate", "component:orch-store", "legacy_resume_uses", "documented", relative(PLAYBOOKS / "orchestrate.md"))
edge("component:orch-store", "owner:runtime", "overlaps", "review_recommendation", "docs/pstack-audit/index.md")
edge("external:ralph-loop", "playbook:autonomous-run", "separate_loop_mechanism", "documented", "docs/pstack-audit/index.md")
overnight_source = "https://github.com/cursor/plugins/blob/main/pstack/docs/guide/07-overnight.md"
for target, relation in (
    ("skill:figure-it-out", "plans_overnight_task"),
    ("playbook:autonomous-run", "drives_one_task_to_predicate"),
    ("playbook:autopilot-full", "handles_independent_pr_queue"),
    ("playbook:autopilot-stack", "handles_reviewed_stack"),
    ("playbook:orchestrate", "handles_multi_day_program"),
):
    edge("external:overnight-guide", target, relation, "documented", overnight_source)
edge("external:third-party", "skill:why", "optional_evidence_provider", "documented", relative(SKILLS / "why/SKILL.md"))
edge("external:benny", "skill:poteto-mode", "uses_shared_skills", "documented", "docs/pstack-audit/index.md")

for item in edges.values():
    if item["from"] not in nodes or item["to"] not in nodes:
        raise ValueError(f"dangling edge: {item}")
    if item["basis"] not in {"documented", "source_reference", "review_recommendation"}:
        raise ValueError(f"invalid edge basis: {item}")
    evidence = item["evidence"]
    if not evidence.startswith("https://") and not (ROOT / evidence).is_file():
        raise ValueError(f"missing edge evidence: {evidence}")
for item in nodes.values():
    source = item.get("source")
    if source and not (ROOT / source).is_file():
        raise ValueError(f"missing source: {source}")

index = OUT.with_name("index.md")
for target in re.findall(r"\[[^\]]*\]\(([^)]+)\)", index.read_text()):
    path = target.partition("#")[0]
    if not path or "://" in path:
        continue
    if not (index.parent / path).is_file():
        raise ValueError(f"missing local Markdown link: {target}")

graph = {
    "schemaVersion": 1,
    "scope": "Temari public entries and v4.1 bundled P-stack skills and playbooks, with adjacent ownership boundaries",
    "reviewedAt": "2026-10-10",
    "evidenceRule": "documented and source_reference edges describe checked source; review_recommendation edges are proposals, not current behavior",
    "nodes": sorted(nodes.values(), key=lambda item: item["id"]),
    "edges": sorted(edges.values(), key=lambda item: (item["from"], item["relation"], item["to"], item["basis"])),
}
OUT.write_text(json.dumps(graph, indent=2, ensure_ascii=False) + "\n")
print(f"{len(graph['nodes'])} nodes, {len(graph['edges'])} edges -> {relative(OUT)}")
