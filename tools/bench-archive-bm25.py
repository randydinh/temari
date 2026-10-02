#!/usr/bin/env python3
"""Opt-in, local-only, actual-Registrar BM25 scale diagnostic.

This is deliberately outside the normal test target: 1,000 individual text
extractions and repeated fresh FTS5 builds are unsuitable for routine CI.
The output contains only synthetic corpus metadata and aggregate timings.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import statistics
import subprocess
import sys
import tempfile
import time


ROOT = Path(__file__).resolve().parent.parent
REGISTRAR = ROOT / "packages/workflow-runtime/registrar/src"
TARGET_TERMS = ("cobaltphasebeacon", "heliorelay")
CAPTURE_LIMITS = {"entries": 1000, "file_bytes": 8192, "total_bytes": 8_388_608, "text_bytes": 8192}


def source_bytes(number: int) -> bytes:
    """A fixed, unique, small plain-text body; only document zero has the target."""
    head = f"Synthetic engineering note {number:04d}.\n"
    body = ("The local archive keeps a source revision and an evidence pointer. "
            "The operator inspects the selected record before a decision.\n") * 4
    target = "Cobaltphasebeacon heliorelay is the selected verification marker.\n" if number == 0 else ""
    return (head + target + body).encode("utf-8")


def run_cli(python: Path, workspace: Path, family: str, *arguments: str,
            expect_invalid: bool = False, timeout: int = 600) -> dict:
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(REGISTRAR)
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    environment.pop("TYPESAFE_API_KEY", None)
    command = [str(python), "-m", "knowledge_agent.cli", family,
               "--workspace", str(workspace), *arguments]
    completed = subprocess.run(command, text=True, capture_output=True,
                               timeout=timeout, env=environment, check=False)
    if len(completed.stdout.encode()) > 1_048_576:
        raise RuntimeError("Registrar response exceeds one MiB")
    try:
        response = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Registrar returned non-JSON, exit {completed.returncode}: "
                           f"{completed.stderr[-500:]}") from exc
    if expect_invalid:
        if completed.returncode != 2 or response.get("status") != "invalid":
            raise RuntimeError(f"Expected bounded refusal, got exit {completed.returncode}")
    elif completed.returncode != 0:
        raise RuntimeError(f"Registrar {arguments[0] if arguments else family} failed: "
                           f"{response.get('error', completed.stderr[-300:])}")
    return response


def inspect_all(python: Path, workspace: Path, receipt: dict,
                original_hashes: dict[str, str]) -> tuple[int, int]:
    """Independently check retained originals and count FTS-selected bytes."""
    offset = 0
    seen: set[str] = set()
    selected_bytes = 0
    while True:
        page = run_cli(python, workspace, "archive", "inspect", receipt["source_id"],
                       receipt["generation"], "--manifest-sha256", receipt["manifest_sha256"],
                       "--offset", str(offset), "--limit", "100", "--max-bytes", "1048576")
        if (page.get("integrity") != "verified" or page.get("preservation") != "complete-admitted"
                or page.get("manifest_sha256") != receipt["manifest_sha256"]):
            raise RuntimeError("Pinned archive inspection failed")
        for item in page["documents"]:
            path = item["path"]
            if path in seen or item["status"] != "captured" or not item["representation"]:
                raise RuntimeError("Archive selection is duplicate or lacks text")
            if item["original"]["sha256"] != original_hashes[path]:
                raise RuntimeError("Original hash differs from synthetic fixture")
            seen.add(path)
            selected_bytes += item["representation"]["bytes"] + len(path.encode("utf-8"))
        next_offset = page["next_offset"]
        if next_offset is None:
            break
        if next_offset <= offset:
            raise RuntimeError("Archive inspection did not advance")
        offset = next_offset
    if seen != set(original_hashes):
        raise RuntimeError("Archive inspection omitted a synthetic original")
    return len(seen), selected_bytes


def validate_discovery(python: Path, workspace: Path, result: dict,
                       selected: list[dict], expected: dict, document_count: int,
                       sqlite_version: str) -> None:
    by_id = {item["source_id"]: item for item in selected}
    if (result.get("route") != "archive-bm25" or result.get("ranker") != "sqlite-fts5-bm25-v1"
            or result.get("indexed_documents") != document_count
            or result.get("sqlite_version") != sqlite_version
            or len(result.get("snapshots", [])) != len(selected)):
        raise RuntimeError("BM25 receipt does not match the selected scope")
    if result.get("gaps") or not result.get("documents"):
        raise RuntimeError("BM25 fixture yielded a gap or no candidate")
    for snapshot in result["snapshots"]:
        pin = by_id[snapshot["source_id"]]
        if ((snapshot["generation"], snapshot["manifest_sha256"])
                != (pin["generation"], pin["manifest_sha256"])):
            raise RuntimeError("BM25 snapshot pin changed")
    top = result["documents"][0]
    if (top["source_id"], top["path"], top["sha256"]) != (
            expected["source_id"], expected["path"], expected["sha256"]):
        raise RuntimeError("BM25 top citation changed")
    if (top["snapshot_generation"] != expected["generation"]
            or top["manifest_sha256"] != expected["manifest_sha256"]):
        raise RuntimeError("BM25 citation lacks the pinned generation")
    read = run_cli(python, workspace, "archive", "read", top["source_id"],
                   top["snapshot_generation"], top["path"], "--manifest-sha256",
                   top["manifest_sha256"], "--max-chars", "4096", "--max-bytes", "16000")
    citation = read["record"]["citations"][0]
    read_pin = (read.get("source_id"), read.get("generation"),
                read.get("manifest_sha256"), read.get("path"))
    top_pin = (top["source_id"], top["snapshot_generation"],
               top["manifest_sha256"], top["path"])
    citation_pin = (citation.get("source_id"), citation.get("snapshot_generation"),
                    citation.get("manifest_sha256"), citation.get("path"))
    body = read["record"]["body"]
    if (read.get("integrity") != "verified" or read.get("evidence") != "archived-snapshot"
            or read_pin != top_pin or citation_pin != top_pin
            or read.get("offset") != 0 or citation.get("text_start") != 0
            or citation.get("coordinate_space") != "unicode-codepoints"
            or citation.get("text_end") != len(citation["quote"])
            or len(body) != citation["text_end"] - citation["text_start"]
            or body != citation["quote"]
            or citation["original_sha256"] != top["sha256"]
            or citation["sha256"] != top["sha256"]
            or citation["representation_sha256"] != top["representation_sha256"]
            or read["representation"]["sha256"] != top["representation_sha256"]
            or not all(term in citation["quote"].casefold() for term in TARGET_TERMS)):
        raise RuntimeError("Pinned top citation did not survive an independent archive read")


def nearest_rank_p95(values: list[float]) -> float:
    return sorted(values)[math.ceil(0.95 * len(values)) - 1]


def parse_counts(raw: str) -> list[int]:
    try:
        counts = [int(piece) for piece in raw.split(",")]
    except ValueError as exc:
        raise argparse.ArgumentTypeError("counts must be three integers") from exc
    if len(counts) != 3 or counts != sorted(set(counts)) or not 1 <= counts[0] or counts[-1] > 1000:
        raise argparse.ArgumentTypeError("counts must be three increasing values through 1000")
    return counts


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python", type=Path, default=Path(sys.executable),
                        help="Python with pinned Registrar dependencies")
    parser.add_argument("--counts", type=parse_counts, default=[100, 500, 1000])
    parser.add_argument("--repetitions", type=int, default=7)
    parser.add_argument("--warmup", type=int, default=1)
    parser.add_argument("--output", type=Path, required=True,
                        help="New JSON report path outside the repository")
    args = parser.parse_args()
    if not 1 <= args.repetitions <= 30 or not 0 <= args.warmup <= 5:
        parser.error("repetitions must be 1-30 and warmup 0-5")
    # Keep the venv executable path: resolving the final symlink bypasses its
    # site-packages on some Python installations.
    python = Path(os.path.abspath(args.python))
    if not python.is_file():
        parser.error("Python executable is missing")
    output = args.output.resolve()
    if ROOT == output or ROOT in output.parents or output.exists():
        parser.error("output must be a new file outside the repository")
    output.parent.mkdir(parents=True, exist_ok=True)
    identity = subprocess.run(
        [str(python), "-c", "import json,platform,sqlite3; "
         "print(json.dumps({'python':platform.python_version(),'sqlite':sqlite3.sqlite_version}))"],
        text=True, capture_output=True, check=True, timeout=15)
    interpreter = json.loads(identity.stdout)
    with tempfile.TemporaryDirectory(prefix="temari-bm25-scale-") as directory:
        root = Path(directory)
        workspace = root / "state"
        selected: list[dict] = []
        expected: dict | None = None
        measured: list[dict] = []
        previous = 0
        for count in args.counts:
            source_root = root / f"source-{count:04d}"
            source_root.mkdir()
            hashes = {}
            for number in range(previous, count):
                name = f"doc-{number:04d}.txt"
                raw = source_bytes(number)
                (source_root / name).write_bytes(raw)
                hashes[name] = hashlib.sha256(raw).hexdigest()
            source = run_cli(python, workspace, "sources", "add", str(source_root),
                             "--label", "Synthetic local BM25 scale")
            source_id = source["id"]
            sharing = run_cli(python, workspace, "sources", "set-sharing", source_id, "local-only")
            if sharing.get("sharing") != "local-only":
                raise RuntimeError("Synthetic source was not marked local-only")
            receipt = run_cli(python, workspace, "archive", "capture", source_id,
                              "--request-key", f"bm25-scale-{count}-v1",
                              "--limits", json.dumps(CAPTURE_LIMITS, separators=(",", ":")))
            if (receipt.get("preservation") != "complete-admitted"
                    or receipt.get("counts", {}).get("captured") != count - previous):
                raise RuntimeError("Synthetic capture was incomplete")
            docs, byte_count = inspect_all(python, workspace, receipt, hashes)
            if docs != count - previous:
                raise RuntimeError("Archive document count mismatch")
            selected.append({"source_id": source_id, "generation": receipt["generation"],
                             "manifest_sha256": receipt["manifest_sha256"],
                             "documents": docs, "selected_bytes": byte_count})
            if previous == 0:
                expected = {"source_id": source_id, "path": "doc-0000.txt",
                            "sha256": hashes["doc-0000.txt"],
                            "generation": receipt["generation"],
                            "manifest_sha256": receipt["manifest_sha256"]}
            assert expected is not None
            snapshots = {item["source_id"]: item["generation"] for item in selected}
            arguments = ["discover", " ".join(TARGET_TERMS)]
            for item in selected:
                arguments.extend(["--source", item["source_id"]])
            arguments.extend(["--snapshots", json.dumps(snapshots, separators=(",", ":")),
                              "--mode", "bm25", "--limit", "3", "--max-bytes", "16000"])
            timings = []
            index_digest: str | None = None
            for iteration in range(args.warmup + args.repetitions):
                started = time.perf_counter_ns()
                result = run_cli(python, workspace, "archive", *arguments)
                elapsed = (time.perf_counter_ns() - started) / 1_000_000
                validate_discovery(python, workspace, result, selected, expected, count,
                                   interpreter["sqlite"])
                current_digest = result.get("index_digest")
                if (not isinstance(current_digest, str) or len(current_digest) != 64
                        or any(character not in "0123456789abcdef" for character in current_digest)):
                    raise RuntimeError("BM25 index digest is missing or malformed")
                if index_digest is None:
                    index_digest = current_digest
                elif current_digest != index_digest:
                    raise RuntimeError("BM25 selected index changed between repeated discoveries")
                if iteration >= args.warmup:
                    timings.append(round(elapsed, 3))
            measured.append({"documents": count, "sources": len(selected),
                             "selected_text_and_path_bytes": sum(item["selected_bytes"] for item in selected),
                             "samples_ms": timings,
                             "median_ms": round(statistics.median(timings), 3),
                             "p95_nearest_rank_ms": round(nearest_rank_p95(timings), 3),
                             "verified_top_citation": True,
                             "index_digest": index_digest})
            previous = count
        # Refuse a query over the implemented 32-term cap through the actual CLI.
        refusal = run_cli(python, workspace, "archive", "discover",
                          " ".join(f"boundaryterm{number:02d}" for number in range(33)),
                          "--source", selected[0]["source_id"],
                          "--snapshots", json.dumps({selected[0]["source_id"]: selected[0]["generation"]}),
                          "--mode", "bm25", expect_invalid=True)
        if "too many terms" not in refusal.get("error", ""):
            raise RuntimeError("BM25 did not report the expected 32-term boundary")
        report = {"schema": 1, "kind": "local-registrar-bm25-scale-diagnostic",
                  "fixture": "deterministic-small-text-v1", "sharing": "local-only",
                  "host": {"system": platform.system(), "release": platform.release(),
                           "machine": platform.machine(), "cpu_count": os.cpu_count()},
                  "python": interpreter["python"], "sqlite": interpreter["sqlite"],
                  "registrar_source_archive_sha256": hashlib.sha256(
                      (REGISTRAR / "knowledge_agent/source_archive.py").read_bytes()).hexdigest(),
                  "capture_limits": CAPTURE_LIMITS,
                  "query_terms": len(TARGET_TERMS), "discovery_limit": 3,
                  "discovery_max_bytes": 16000, "warmup": args.warmup,
                  "repetitions": args.repetitions, "latency_scope": "fresh CLI process plus pinned discovery; read validation excluded",
                  "p95_method": "nearest-rank", "measurements": measured,
                  "bounded_refusal": {"kind": "33-unique-term-query", "status": "invalid",
                                      "expected_cap": 32}}
    with output.open("x", encoding="utf-8") as stream:
        json.dump(report, stream, indent=2, sort_keys=True)
        stream.write("\n")
    print(json.dumps({"report": str(output), "measurements": len(measured),
                      "verified": all(item["verified_top_citation"] for item in measured),
                      "refusal": report["bounded_refusal"]["status"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
