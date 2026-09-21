#!/usr/bin/env python3

import argparse
import json
import sys
from pathlib import Path


REQUIRED_OBSERVATIONS = (
    "current-tool-surface",
    "mcp-resources",
    "host-registrations",
    "project-config",
    "project-integration-code",
    "internal-docs",
    "official-provider-docs",
    "connector-catalog",
)
OBSERVATION_STATES = {"checked", "not-applicable", "unavailable"}
LIFECYCLE_STATES = {"present", "absent", "unknown"}
SUITABILITY_STATES = {"suitable", "unsuitable", "unknown"}
KINDS = {"mcp", "api", "connector", "cli", "sdk", "browser"}
ACTIONS = {"reuse", "connect", "install", "build", "blocked"}


def nonempty_string(value):
    return isinstance(value, str) and bool(value.strip())


def validate(document, expected_session_scope):
    errors = []
    if not isinstance(document, dict):
        return ["receipt must be a JSON object"]

    if document.get("schema_version") != 1:
        errors.append("schema_version must be 1")
    if not nonempty_string(document.get("session_scope")):
        errors.append("session_scope must be a non-empty string")
    elif document["session_scope"] != expected_session_scope:
        errors.append("session_scope does not match the current task")
    if not nonempty_string(document.get("service")):
        errors.append("service must be a non-empty string")
    if not nonempty_string(document.get("need")):
        errors.append("need must be a non-empty string")

    interfaces = document.get("requested_interfaces")
    if not isinstance(interfaces, list) or not interfaces or not all(nonempty_string(item) for item in interfaces):
        errors.append("requested_interfaces must be a non-empty list of strings")

    claims = document.get("user_claims")
    if not isinstance(claims, list) or not all(nonempty_string(item) for item in claims):
        errors.append("user_claims must be a list of non-empty strings")

    observations = document.get("observations")
    if not isinstance(observations, dict):
        errors.append("observations must be an object")
        observations = {}
    for name in REQUIRED_OBSERVATIONS:
        observation = observations.get(name)
        if not isinstance(observation, dict):
            errors.append(f"observations.{name} is required")
            continue
        if observation.get("state") not in OBSERVATION_STATES:
            errors.append(f"observations.{name}.state must be checked, not-applicable, or unavailable")
        if not nonempty_string(observation.get("evidence")):
            errors.append(f"observations.{name}.evidence must be a non-empty string")

    candidates = document.get("candidates")
    if not isinstance(candidates, list):
        errors.append("candidates must be a list")
        candidates = []
    names = set()
    for index, candidate in enumerate(candidates):
        prefix = f"candidates[{index}]"
        if not isinstance(candidate, dict):
            errors.append(f"{prefix} must be an object")
            continue
        name = candidate.get("name")
        if not nonempty_string(name):
            errors.append(f"{prefix}.name must be a non-empty string")
        elif name in names:
            errors.append(f"{prefix}.name duplicates {name!r}")
        else:
            names.add(name)
        if candidate.get("kind") not in KINDS:
            errors.append(f"{prefix}.kind must be one of {sorted(KINDS)}")
        if not nonempty_string(candidate.get("source")):
            errors.append(f"{prefix}.source must be a non-empty string")
        if candidate.get("suitability") not in SUITABILITY_STATES:
            errors.append(f"{prefix}.suitability must be suitable, unsuitable, or unknown")
        if not nonempty_string(candidate.get("suitability_evidence")):
            errors.append(f"{prefix}.suitability_evidence must be a non-empty string")
        for field in ("configured", "exposed", "authenticated", "verified"):
            if candidate.get(field) not in LIFECYCLE_STATES:
                errors.append(f"{prefix}.{field} must be present, absent, or unknown")
        if candidate.get("exposed") == "present" and candidate.get("configured") != "present":
            errors.append(f"{prefix}.exposed present requires configured present")
        if candidate.get("verified") == "present" and candidate.get("exposed") != "present":
            errors.append(f"{prefix}.verified present requires exposed present")

    gaps = document.get("gaps")
    if not isinstance(gaps, list) or not all(nonempty_string(item) for item in gaps):
        errors.append("gaps must be a list of non-empty strings")

    return errors


def derive_action(document):
    candidates = [candidate for candidate in document["candidates"] if isinstance(candidate, dict)]
    suitable = [candidate for candidate in candidates if candidate["suitability"] == "suitable"]

    reusable = sorted(
        (
            candidate
            for candidate in suitable
            if candidate["configured"] == "present"
            and candidate["exposed"] == "present"
            and candidate["verified"] == "present"
        ),
        key=lambda candidate: candidate["name"],
    )
    if reusable:
        return "reuse", reusable[0]["name"], "A suitable provider is exposed and live-verified."

    unavailable = sorted(
        name
        for name, observation in document["observations"].items()
        if observation["state"] == "unavailable"
    )
    if unavailable:
        return "blocked", None, f"Required discovery surfaces are unavailable: {', '.join(unavailable)}."

    connectable = sorted(
        (candidate for candidate in suitable if candidate["configured"] == "present"),
        key=lambda candidate: candidate["name"],
    )
    if connectable:
        return "connect", connectable[0]["name"], "A suitable configured provider still needs current-session connection or verification."

    unresolved = sorted(
        candidate["name"]
        for candidate in candidates
        if candidate["suitability"] == "unknown"
        or (candidate["suitability"] == "suitable" and candidate["configured"] == "unknown")
    )
    if unresolved:
        return "blocked", None, f"Provider suitability or configuration remains unresolved: {', '.join(unresolved)}."

    installable = sorted(
        (candidate for candidate in suitable if candidate["configured"] == "absent"),
        key=lambda candidate: candidate["name"],
    )
    if installable:
        return "install", installable[0]["name"], "A suitable supported provider is not configured."

    return "build", None, "The complete census found no suitable existing or installable provider."


def main():
    parser = argparse.ArgumentParser(description="Derive the permitted Temari integration action from discovery evidence.")
    parser.add_argument("--session-scope", required=True)
    parser.add_argument("--require-action", choices=sorted(ACTIONS))
    parser.add_argument("receipt", type=Path)
    args = parser.parse_args()
    try:
        document = json.loads(args.receipt.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"integration inventory unreadable: {exc}", file=sys.stderr)
        return 2

    errors = validate(document, args.session_scope)
    if errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        return 1

    action, provider, reason = derive_action(document)
    result = {
        "valid": True,
        "service": document["service"],
        "action": action,
        "provider": provider,
        "reason": reason,
    }
    print(json.dumps(result, sort_keys=True))
    if args.require_action and args.require_action != action:
        print(f"error: required action {args.require_action} but policy derived {action}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
