"""Source workspace CLI with backwards-compatible single-collection commands."""
import argparse
import json
from pathlib import Path
import sqlite3
import sys

from knowledge_agent.source_registry import SourceRegistry


def main():
    if len(sys.argv) > 1 and sys.argv[1] == 'archive':
        from knowledge_agent.archive_cli import main as archive_main
        return archive_main(sys.argv[2:])
    if len(sys.argv) > 1 and sys.argv[1] == 'mcp':
        from knowledge_agent.mcp_server import main as mcp_main
        return mcp_main(sys.argv[2:])
    if len(sys.argv) < 2 or sys.argv[1] != 'sources':
        from knowledge_agent.knowledge import main as legacy_main
        return legacy_main()
    parser = argparse.ArgumentParser(description='Manage local source roots and verified lexical search')
    parser.add_argument('--workspace', type=Path, default=Path('.knowledge-agent'))
    commands = parser.add_subparsers(dest='command', required=True)
    add = commands.add_parser('add')
    add.add_argument('path', type=Path)
    add.add_argument('--label')
    add.add_argument('--exclude', action='append', default=[])
    add.add_argument('--no-recursive', action='store_true')
    testmo = commands.add_parser('add-testmo')
    testmo.add_argument('--instance', required=True)
    testmo.add_argument('--project-id', required=True, type=int)
    testmo.add_argument('--repository-id', required=True, type=int)
    testmo.add_argument('--folder-id', required=True, type=int)
    testmo.add_argument('--credential-file', required=True, type=Path)
    testmo.add_argument('--label', default='Testmo snapshot')
    testmo.add_argument('--custom-field', action='append', default=[])
    remote = commands.add_parser('add-remote', help='Register selected Shortcut/Notion objects using public profile metadata and an existing host grant')
    remote.add_argument('configuration', type=Path, help='JSON kind, selection, credential_profile, grant_file, optional label; no secrets')
    commands.add_parser('list')
    sharing = commands.add_parser('set-sharing')
    sharing.add_argument('source_id')
    sharing.add_argument('mode')
    for name in ('refresh', 'inventory', 'disable', 'enable'):
        command = commands.add_parser(name)
        command.add_argument('source_id')
    relink = commands.add_parser('relink')
    relink.add_argument('source_id')
    relink.add_argument('path', type=Path)
    search = commands.add_parser('search')
    search.add_argument('query')
    search.add_argument('--source', action='append')
    search.add_argument('--limit', type=int, default=5)
    search.add_argument('--max-bytes', type=int, default=16000)
    discovery = commands.add_parser('discover')
    discovery.add_argument('query')
    discovery.add_argument('--source', action='append')
    discovery.add_argument('--variant', action='append', default=[])
    discovery.add_argument('--limit', type=int, default=20)
    discovery.add_argument('--max-bytes', type=int, default=16000)
    discovery.add_argument('--cursor')
    discovery.add_argument('--mode',choices=['exact','semantic','relationship'],default='exact')
    provider = commands.add_parser('retrieval-provider')
    provider.add_argument('file',type=Path,help='Local Python path and pinned NumPy/Graphify versions')
    read = commands.add_parser('read')
    read.add_argument('source_id')
    read.add_argument('path')
    read.add_argument('--offset', type=int, default=0)
    read.add_argument('--max-chars', type=int, default=8000)
    read.add_argument('--max-bytes', type=int, default=16000)
    read.add_argument('--expected-generation')
    read.add_argument('--expected-sha256')
    read.add_argument('--section')
    outline = commands.add_parser('outline')
    outline.add_argument('source_id')
    outline.add_argument('path')
    outline.add_argument('--offset', type=int, default=0)
    outline.add_argument('--limit', type=int, default=50)
    outline.add_argument('--max-bytes', type=int, default=16000)
    outline.add_argument('--expected-generation')
    policy = commands.add_parser('evidence-policy')
    policy.add_argument('file', type=Path)
    expand = commands.add_parser('expand')
    expand.add_argument('file', type=Path, help='JSON list of document/section selections')
    expand.add_argument('--source', action='append', required=True)
    expand.add_argument('--max-bytes', type=int, default=16000)
    expand.add_argument('--max-documents', type=int, default=20)
    expand.add_argument('--context', action='append', default=[])
    expand.add_argument('--as-of')
    validate = commands.add_parser('validate-claims')
    validate.add_argument('--source', action='append', required=True)
    validate.add_argument('--context', action='append', default=[])
    validate.add_argument('--as-of')
    validate.add_argument('--max-bytes', type=int, default=16000)
    validate.add_argument('--stdin', action='store_true', required=True, help='Read bounded claim JSON from standard input')
    args = parser.parse_args(sys.argv[2:])
    try:
        registry = SourceRegistry(args.workspace)
        if args.command == 'add':
            result = registry.add(args.path, label=args.label, recursive=not args.no_recursive, exclude=args.exclude)
        elif args.command == 'add-testmo':
            result = registry.add_testmo(instance=args.instance, project_id=args.project_id,
                repository_id=args.repository_id, folder_id=args.folder_id,
                credential_file=args.credential_file, label=args.label, custom_fields=args.custom_field)
        elif args.command == 'add-remote':
            configuration = json.loads(args.configuration.read_text())
            result = registry.add_remote(**configuration)
        elif args.command == 'list':
            result = dict(sources=registry.list())
        elif args.command == 'set-sharing':
            result = registry.set_sharing(args.source_id, args.mode)
        elif args.command == 'relink':
            result = registry.relink(args.source_id, args.path)
        elif args.command == 'search':
            result = registry.search(args.query, source_ids=args.source, limit=args.limit, max_bytes=args.max_bytes)
        elif args.command == 'discover':
            result = registry.discover(args.query, source_ids=args.source, variants=args.variant,
                limit=args.limit, max_bytes=args.max_bytes, cursor=args.cursor,mode=args.mode)
        elif args.command == 'retrieval-provider':
            from knowledge_agent.providers import configure
            result = configure(registry,json.loads(args.file.read_text()))
        elif args.command == 'read':
            result = registry.read_document(args.source_id, args.path, offset=args.offset, max_chars=args.max_chars,
                max_bytes=args.max_bytes, expected_generation=args.expected_generation, expected_sha256=args.expected_sha256,
                section=args.section)
        elif args.command == 'outline':
            result = registry.outline(args.source_id, args.path, offset=args.offset, limit=args.limit,
                max_bytes=args.max_bytes, expected_generation=args.expected_generation)
        elif args.command == 'evidence-policy':
            result = registry.configure_evidence(json.loads(args.file.read_text()))
        elif args.command == 'expand':
            result = registry.expand(json.loads(args.file.read_text()), source_ids=args.source,
                max_bytes=args.max_bytes, max_documents=args.max_documents,context=args.context,as_of=args.as_of)
        elif args.command == 'validate-claims':
            raw = sys.stdin.buffer.read(1048577)
            if len(raw) > 1048576:
                raise ValueError('claim request exceeds one MiB')
            request = json.loads(raw)
            consumed = []
            if isinstance(request, dict):
                if set(request) != {'claims', 'consumed'}:
                    raise ValueError('claim envelope requires claims and consumed')
                request, consumed = request['claims'], request['consumed']
            result = registry.validate_claims(request,source_ids=args.source,consumed=consumed,
                context=args.context,as_of=args.as_of,max_bytes=args.max_bytes)
        elif args.command == 'inventory':
            result = dict(files=registry.inventory(args.source_id))
        else:
            result = getattr(registry, args.command)(args.source_id)
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result.get('status', 'complete') == 'complete' else 2
    except (ValueError, OSError, sqlite3.Error) as exc:
        print(json.dumps(dict(status='invalid', error=str(exc))))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
