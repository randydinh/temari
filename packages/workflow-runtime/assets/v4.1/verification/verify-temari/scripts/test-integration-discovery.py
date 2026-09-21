#!/usr/bin/env python3

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
CHECKER = REPO_ROOT / "skills/temari/scripts/check-integration-inventory.py"
SESSION_SCOPE = "test-session"


def base_receipt():
    observation_names = (
        "current-tool-surface",
        "mcp-resources",
        "host-registrations",
        "project-config",
        "project-integration-code",
        "internal-docs",
        "official-provider-docs",
        "connector-catalog",
    )
    return {
        "schema_version": 1,
        "session_scope": SESSION_SCOPE,
        "service": "Example",
        "need": "Read bounded events",
        "requested_interfaces": ["mcp", "api"],
        "user_claims": ["An MCP server already exists."],
        "observations": {
            name: {"state": "checked", "evidence": f"Checked {name}."}
            for name in observation_names
        },
        "candidates": [],
        "gaps": [],
    }


def candidate(name, suitability, configured, exposed="absent", authenticated="unknown", verified="unknown"):
    return {
        "name": name,
        "kind": "mcp",
        "source": "test",
        "suitability": suitability,
        "suitability_evidence": f"{name} suitability checked.",
        "configured": configured,
        "exposed": exposed,
        "authenticated": authenticated,
        "verified": verified,
    }


class IntegrationDiscoveryTests(unittest.TestCase):
    def run_checker(self, receipt, *extra_args, cwd="/"):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipt.json"
            path.write_text(json.dumps(receipt), encoding="utf-8")
            result = subprocess.run(
                [
                    sys.executable,
                    str(CHECKER),
                    "--session-scope",
                    SESSION_SCOPE,
                    *extra_args,
                    str(path),
                ],
                cwd=cwd,
                capture_output=True,
                text=True,
                check=False,
            )
        payload = json.loads(result.stdout) if result.stdout.strip() else None
        return result, payload

    def test_reuses_only_exposed_verified_suitable_provider(self):
        receipt = base_receipt()
        receipt["candidates"] = [candidate("existing", "suitable", "present", "present", "present", "present")]
        result, payload = self.run_checker(receipt, "--require-action", "reuse")
        self.assertEqual(0, result.returncode)
        self.assertEqual({"action": "reuse", "provider": "existing"}, {key: payload[key] for key in ("action", "provider")})

    def test_connects_configured_provider_before_install_or_build(self):
        receipt = base_receipt()
        receipt["candidates"] = [candidate("existing", "suitable", "present")]
        result, payload = self.run_checker(receipt)
        self.assertEqual(0, result.returncode)
        self.assertEqual("connect", payload["action"])

    def test_installs_suitable_candidate_when_configured_candidate_is_unsuitable(self):
        receipt = base_receipt()
        receipt["candidates"] = [
            candidate("legacy", "unsuitable", "present", "present", "present", "present"),
            candidate("vendor", "suitable", "absent"),
        ]
        result, payload = self.run_checker(receipt)
        self.assertEqual(0, result.returncode)
        self.assertEqual({"action": "install", "provider": "vendor"}, {key: payload[key] for key in ("action", "provider")})

    def test_unknown_suitability_blocks_escalation(self):
        receipt = base_receipt()
        receipt["candidates"] = [candidate("unknown-provider", "unknown", "present")]
        result, payload = self.run_checker(receipt)
        self.assertEqual(0, result.returncode)
        self.assertEqual("blocked", payload["action"])

    def test_unavailable_surface_blocks_escalation(self):
        receipt = base_receipt()
        receipt["observations"]["host-registrations"] = {"state": "unavailable", "evidence": "Host has no listing API."}
        result, payload = self.run_checker(receipt)
        self.assertEqual(0, result.returncode)
        self.assertEqual("blocked", payload["action"])

    def test_builds_only_after_complete_unsuitable_census(self):
        receipt = base_receipt()
        receipt["candidates"] = [candidate("legacy", "unsuitable", "present", "present", "present", "present")]
        result, payload = self.run_checker(receipt, "--require-action", "build")
        self.assertEqual(0, result.returncode)
        self.assertEqual("build", payload["action"])

    def test_required_action_rejects_premature_build(self):
        receipt = base_receipt()
        receipt["candidates"] = [candidate("existing", "suitable", "present")]
        result, payload = self.run_checker(receipt, "--require-action", "build")
        self.assertEqual(1, result.returncode)
        self.assertEqual("connect", payload["action"])
        self.assertIn("required action build but policy derived connect", result.stderr)

    def test_stale_session_and_lifecycle_contradictions_fail(self):
        stale = base_receipt()
        stale["session_scope"] = "old-session"
        stale_result, _ = self.run_checker(stale)
        self.assertEqual(1, stale_result.returncode)
        self.assertIn("session_scope does not match", stale_result.stderr)

        contradictory = base_receipt()
        contradictory["candidates"] = [candidate("broken", "suitable", "absent", "present")]
        contradictory_result, _ = self.run_checker(contradictory)
        self.assertEqual(1, contradictory_result.returncode)
        self.assertIn("exposed present requires configured present", contradictory_result.stderr)

    def test_missing_observation_fails(self):
        receipt = base_receipt()
        del receipt["observations"]["official-provider-docs"]
        result, _ = self.run_checker(receipt)
        self.assertEqual(1, result.returncode)
        self.assertIn("observations.official-provider-docs is required", result.stderr)


if __name__ == "__main__":
    unittest.main()
