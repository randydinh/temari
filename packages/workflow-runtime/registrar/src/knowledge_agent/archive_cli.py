"""Versioned JSON operator contract for local source archives (SA-001)."""
import argparse
import json
from pathlib import Path
import signal
import sqlite3

from knowledge_agent.source_registry import SourceRegistry


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', type=Path, required=True)
    commands = parser.add_subparsers(dest='command', required=True)
    capture = commands.add_parser('capture')
    capture.add_argument('source_id')
    capture.add_argument('--request-key', required=True)
    capture.add_argument('--limits', type=json.loads, help='JSON object; bounded entries/file_bytes/total_bytes/text_bytes')
    capture.add_argument('--ocr-mode', choices=['none', 'macos-vision'], default='none')
    capture.add_argument('--pdf-worker-profile', type=Path,
                         help='Absolute JSON profile for the opt-in local Lima PDF worker')
    capture.add_argument('--pdf-worker-profile-sha256',
                         help='Expected SHA-256 of the exact local PDF profile bytes')
    generations = commands.add_parser('generations')
    generations.add_argument('source_id')
    inspect = commands.add_parser('inspect')
    audit = commands.add_parser('audit-current')
    audit_start = commands.add_parser('audit-start')
    audit_page = commands.add_parser('audit-page')
    read = commands.add_parser('read')
    recover = commands.add_parser('recover')
    for command in (inspect, read, recover, audit, audit_start, audit_page):
        command.add_argument('source_id')
        command.add_argument('generation')
    audit.add_argument('--manifest-sha256', required=True)
    audit_start.add_argument('--manifest-sha256', required=True)
    audit_page.add_argument('audit_id')
    audit_page.add_argument('--manifest-sha256', required=True)
    audit_page.add_argument('--cursor')
    audit_page.add_argument('--limit', type=int, default=20)
    audit_page.add_argument('--max-bytes', type=int, default=16000)
    for command in (read, recover):
        command.add_argument('path')
    recover.add_argument('destination', type=Path)
    for command in (inspect, read):
        command.add_argument('--manifest-sha256')
    for command in (generations, inspect, read):
        command.add_argument('--offset', type=int, default=0)
    for command in (generations, inspect):
        command.add_argument('--limit', type=int, default=20)
    read.add_argument('--max-chars', type=int, default=8000)
    read.add_argument('--cursor')
    discover = commands.add_parser('discover')
    discover.add_argument('query')
    discover.add_argument('--source', action='append', required=True)
    discover.add_argument('--snapshots', type=json.loads, required=True)
    discover.add_argument('--cursor')
    discover.add_argument('--limit', type=int, default=20)
    discover.add_argument('--mode', choices=['exact', 'bm25'], default='exact')
    export = commands.add_parser('export')
    export.add_argument('--snapshots', type=json.loads, required=True)
    export.add_argument('destination', type=Path)
    restore = commands.add_parser('import')
    restore.add_argument('bundle', type=Path)
    for command in (generations, inspect, read, discover):
        command.add_argument('--max-bytes', type=int, default=16000)
    audit.add_argument('--max-bytes', type=int, default=1024 * 1024)
    for name, argument in [('graph-publish', 'batch'), ('graph-import-okf', 'package')]:
        commands.add_parser(name).add_argument(argument, type=Path)
    for name in ('graph-read', 'graph-projection', 'graph-check', 'graph-export-okf'):
        graph = commands.add_parser(name)
        graph.add_argument('graph_id')
        graph.add_argument('--source', action='append', required=True)
        if name == 'graph-check':
            graph.add_argument('projection', type=Path)
        if name == 'graph-read':
            graph.add_argument('--limit', type=int, default=20)
            graph.add_argument('--max-bytes', type=int, default=16000)
            graph.add_argument('--cursor')
            graph.add_argument('--node-id')
    retract = commands.add_parser('graph-retract')
    retract.add_argument('graph_id')
    retract.add_argument('--source', action='append', required=True)
    retract.add_argument('--assertion', action='append', required=True)
    args = vars(parser.parse_args(argv))
    workspace, command = args.pop('workspace'), args.pop('command')
    try:
        registry = SourceRegistry(workspace)
        if command.startswith('graph-'):
            if 'source' in args:
                args['source_ids'] = args.pop('source')
            if 'assertion' in args:
                args['assertion_ids'] = args.pop('assertion')
            for key in ('batch', 'package', 'projection'):
                if key in args:
                    with args[key].open('rb') as stream:
                        raw = stream.read(32 * 1024 * 1024 + 1)
                    if len(raw) > 32 * 1024 * 1024:
                        raise ValueError('graph input exceeds byte budget')
                    args[key] = json.loads(raw)
        if command == 'discover':
            args['source_ids'] = args.pop('source')
            args['snapshot_generations'] = args.pop('snapshots')
        if command == 'export':
            args['snapshot_generations'] = args.pop('snapshots')
        if command == 'import':
            args['bundle_path'] = args.pop('bundle')
        method = dict(capture='capture_source', generations='source_generations', inspect='source_generation',
            **{'audit-current':'audit_current_source', 'audit-start':'audit_start', 'audit-page':'audit_page'},
            read='read_snapshot', discover='discover_snapshot', recover='recover_original',
            export='export_archive', **{'import':'import_archive',
            'graph-publish':'publish_graph', 'graph-read':'read_graph',
            'graph-retract':'retract_graph',
            'graph-projection':'graph_projection', 'graph-check':'check_graph_projection',
            'graph-export-okf':'export_graph_okf', 'graph-import-okf':'import_graph_okf'})[command]
        prior_term = None
        if command == 'capture':
            # Let Python unwind archive/tempfile/guest-job finally blocks during
            # the caller's graceful cancellation interval.
            def cancel_capture(_signal, _frame):
                raise SystemExit(143)
            prior_term = signal.signal(signal.SIGTERM, cancel_capture)
        try:
            result = getattr(registry, method)(**args)
        finally:
            if prior_term is not None:
                signal.signal(signal.SIGTERM, prior_term)
        print(json.dumps(result, ensure_ascii=False, separators=(',', ':')))
        return 0
    except (ValueError, OSError, sqlite3.Error, UnicodeError) as exc:
        print(json.dumps(dict(schema=1, status='invalid', error=str(exc))))
        return 2
