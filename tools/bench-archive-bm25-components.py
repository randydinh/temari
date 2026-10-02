#!/usr/bin/env python3
"""Opt-in actual-Registrar BM25 cost diagnostic on one local-only source.

Creates three pinned generations of the same synthetic source. Fresh CLI
discovery, in-process discovery, and the wrapped BM25 rank helper are measured
separately. No timing threshold or production implementation change is made.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import sqlite3
import statistics
import sys
import tempfile
import time


ROOT = Path(__file__).resolve().parent.parent
BASELINE = Path(__file__).resolve().with_name("bench-archive-bm25.py")
REGISTRAR = ROOT / "packages/workflow-runtime/registrar/src"
sys.dont_write_bytecode = True
sys.path.insert(0, str(REGISTRAR))

spec = importlib.util.spec_from_file_location("temari_bm25_scale_helpers", BASELINE)
if spec is None or spec.loader is None:
    raise RuntimeError("BM25 scale helpers are unavailable")
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)

from knowledge_agent.source_registry import SourceRegistry  # noqa: E402
from knowledge_agent import source_archive  # noqa: E402


def parse_counts(raw: str) -> list[int]:
    try:
        counts = [int(value) for value in raw.split(",")]
    except ValueError as exc:
        raise argparse.ArgumentTypeError("counts must be three integers") from exc
    if len(counts) != 3 or counts != sorted(set(counts)) or not 1 <= counts[0] or counts[-1] > 1000:
        raise argparse.ArgumentTypeError("counts must be three increasing values through 1000")
    return counts


def digest_check(value: object, previous: str | None) -> str:
    if (not isinstance(value, str) or len(value) != 64
            or any(character not in "0123456789abcdef" for character in value)):
        raise RuntimeError("BM25 index digest is missing or malformed")
    if previous is not None and value != previous:
        raise RuntimeError("BM25 selected index drifted across measurement routes")
    return value


def rank_timed_discovery(registry: SourceRegistry, source_id: str, generation: str,
                         query: str) -> tuple[dict, float, float]:
    """Instrument this process only and restore the production helper on exit."""
    original = source_archive._bm25_rank
    rank_durations: list[int] = []

    def timed_rank(rows: list, tokens: list):
        started = time.perf_counter_ns()
        try:
            return original(rows, tokens)
        finally:
            rank_durations.append(time.perf_counter_ns() - started)

    source_archive._bm25_rank = timed_rank
    try:
        started = time.perf_counter_ns()
        result = registry.discover_snapshot(
            query, source_ids=[source_id], snapshot_generations={source_id: generation},
            limit=3, max_bytes=16000, mode="bm25")
        total_ns = time.perf_counter_ns() - started
    finally:
        source_archive._bm25_rank = original
    if len(rank_durations) != 1 or rank_durations[0] > total_ns:
        raise RuntimeError("BM25 rank-helper timing was not paired with discovery")
    return result, total_ns / 1_000_000, rank_durations[0] / 1_000_000


def summarize(values: list[float]) -> dict:
    return {"samples_ms": [round(value, 3) for value in values],
            "median_ms": round(statistics.median(values), 3),
            "p95_nearest_rank_ms": round(sorted(values)[math.ceil(0.95 * len(values)) - 1], 3)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--counts", type=parse_counts, default=[100, 500, 1000])
    parser.add_argument("--repetitions", type=int, default=7)
    parser.add_argument("--warmup", type=int, default=1)
    parser.add_argument("--output", type=Path, required=True,
                        help="New private JSON report path outside the repository")
    args = parser.parse_args()
    if not 1 <= args.repetitions <= 30 or not 0 <= args.warmup <= 5:
        parser.error("repetitions must be 1-30 and warmup 0-5")
    output = args.output.resolve()
    if ROOT == output or ROOT in output.parents or output.exists():
        parser.error("output must be a new file outside the repository")
    output.parent.mkdir(parents=True, exist_ok=True)

    # The same interpreter must run both subprocess and in-process routes.
    python = Path(os.path.abspath(sys.executable))
    os.environ.pop("TYPESAFE_API_KEY", None)
    query = " ".join(helpers.TARGET_TERMS)
    measurements: list[dict] = []
    with tempfile.TemporaryDirectory(prefix="temari-bm25-components-") as directory:
        root = Path(directory)
        source_root = root / "source"
        source_root.mkdir()
        workspace = root / "state"
        source = helpers.run_cli(python, workspace, "sources", "add", str(source_root),
                                 "--label", "Synthetic local BM25 component diagnostic")
        source_id = source["id"]
        sharing = helpers.run_cli(python, workspace, "sources", "set-sharing", source_id, "local-only")
        if sharing.get("sharing") != "local-only":
            raise RuntimeError("Synthetic source is not local-only")
        hashes: dict[str, str] = {}
        captures: list[dict] = []
        previous = 0
        for count in args.counts:
            for number in range(previous, count):
                name = f"doc-{number:04d}.txt"
                raw = helpers.source_bytes(number)
                (source_root / name).write_bytes(raw)
                hashes[name] = hashlib.sha256(raw).hexdigest()
            receipt = helpers.run_cli(
                python, workspace, "archive", "capture", source_id,
                "--request-key", f"bm25-components-{count}-v1", "--limits",
                json.dumps(helpers.CAPTURE_LIMITS, separators=(",", ":")))
            if (receipt.get("preservation") != "complete-admitted"
                    or receipt.get("counts", {}).get("captured") != count):
                raise RuntimeError("Synthetic generation capture was incomplete")
            inspected, selected_bytes = helpers.inspect_all(python, workspace, receipt, hashes)
            if inspected != count:
                raise RuntimeError("Pinned generation inventory count differs")
            captures.append({"documents": count, "selected_text_and_path_bytes": selected_bytes,
                             "source_id": source_id, "generation": receipt["generation"],
                             "manifest_sha256": receipt["manifest_sha256"],
                             "target_original_sha256": hashes["doc-0000.txt"]})
            previous = count

        # Finish all extraction and inspection before timing any discovery.
        registry = SourceRegistry(workspace)
        for capture in captures:
            count = capture["documents"]
            generation = capture["generation"]
            selected = [capture]
            expected = {"source_id": source_id, "path": "doc-0000.txt",
                        "sha256": capture["target_original_sha256"],
                        "generation": generation,
                        "manifest_sha256": capture["manifest_sha256"]}
            snapshots = json.dumps({source_id: generation}, separators=(",", ":"))
            arguments = ("discover", query, "--source", source_id,
                         "--snapshots", snapshots, "--mode", "bm25",
                         "--limit", "3", "--max-bytes", "16000")
            index_digest: str | None = None
            cli_samples: list[float] = []
            in_process_samples: list[float] = []
            rank_samples: list[float] = []
            residual_samples: list[float] = []
            for iteration in range(args.warmup + args.repetitions):
                started = time.perf_counter_ns()
                cli = helpers.run_cli(python, workspace, "archive", *arguments)
                cli_ms = (time.perf_counter_ns() - started) / 1_000_000
                helpers.validate_discovery(python, workspace, cli, selected, expected,
                                           count, sqlite3.sqlite_version)
                index_digest = digest_check(cli.get("index_digest"), index_digest)
                if iteration >= args.warmup:
                    cli_samples.append(cli_ms)
            for iteration in range(args.warmup + args.repetitions):
                result, total_ms, rank_ms = rank_timed_discovery(
                    registry, source_id, generation, query)
                helpers.validate_discovery(python, workspace, result, selected, expected,
                                           count, sqlite3.sqlite_version)
                index_digest = digest_check(result.get("index_digest"), index_digest)
                if iteration >= args.warmup:
                    in_process_samples.append(total_ms)
                    rank_samples.append(rank_ms)
                    residual_samples.append(total_ms - rank_ms)
            measurements.append({"documents": count,
                                 "selected_text_and_path_bytes": capture["selected_text_and_path_bytes"],
                                 "fresh_cli_total": summarize(cli_samples),
                                 "in_process_discovery": summarize(in_process_samples),
                                 "bm25_rank_helper": summarize(rank_samples),
                                 "paired_residual": summarize(residual_samples),
                                 "index_digest": index_digest,
                                 "independent_top_citations_verified": 2 * (args.warmup + args.repetitions)})
        final_sources = helpers.run_cli(python, workspace, "sources", "list")["sources"]
        if len(final_sources) != 1 or final_sources[0]["id"] != source_id or final_sources[0].get("sharing") != "local-only":
            raise RuntimeError("Registered source scope or sharing changed")
        report = {"schema": 1, "kind": "local-registrar-bm25-component-diagnostic",
                  "fixture": "deterministic-small-text-v1", "sharing": "local-only",
                  "host": {"system": platform.system(), "release": platform.release(),
                           "machine": platform.machine(), "cpu_count": os.cpu_count()},
                  "python": platform.python_version(), "sqlite": sqlite3.sqlite_version,
                  "registrar_source_archive_sha256": hashlib.sha256(
                      (REGISTRAR / "knowledge_agent/source_archive.py").read_bytes()).hexdigest(),
                  "baseline_helper_sha256": hashlib.sha256(BASELINE.read_bytes()).hexdigest(),
                  "capture_limits": helpers.CAPTURE_LIMITS, "source_count": 1,
                  "query_terms": len(helpers.TARGET_TERMS), "discovery_limit": 3,
                  "discovery_max_bytes": 16000, "warmup": args.warmup,
                  "repetitions": args.repetitions, "p95_method": "nearest-rank",
                  "timing": {"fresh_cli": "new process including startup and pinned discovery",
                             "in_process": "SourceRegistry.discover_snapshot call",
                             "rank_helper": "process-local wrapper of source_archive._bm25_rank",
                             "paired_residual": "in-process discovery minus rank helper; other overhead, not pure validation",
                             "capture_and_citation_reads_included": False},
                  "measurements": measurements}
    with output.open("x", encoding="utf-8") as stream:
        json.dump(report, stream, indent=2, sort_keys=True)
        stream.write("\n")
    print(json.dumps({"report": str(output), "sizes": [row["documents"] for row in measurements],
                      "citations_verified": sum(row["independent_top_citations_verified"]
                                                for row in measurements)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
