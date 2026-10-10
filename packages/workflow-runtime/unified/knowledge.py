"""Bounded recipient actions over the bundled Registrar; no external source intake."""
import json
from pathlib import Path
import sys
from knowledge_agent.source_registry import SourceRegistry
from knowledge_agent.consumer_access import ConsumerGateway, ConsumerScope

request = json.loads(sys.argv[1])
registry = SourceRegistry(Path(request['workspace']))
if request['action'] == 'seed':
    root = str(Path(request['root']).resolve(strict=True))
    matches = [s for s in registry.list() if s.get('root') == root]
    if len(matches) > 1:
        raise ValueError('Ambiguous starter library registration')
    source = matches[0] if matches else registry.add(root, label='Temari public starter library')
    registry.set_sharing(source['id'], 'local-only')
    registry.refresh(source['id'])
    result = {'sourceId': source['id']}
elif request['action'] == 'mcp':
    import asyncio
    from mcp import Client, StdioServerParameters

    async def check():
        args = ['-I', '-B', '-m', 'knowledge_agent.cli', 'mcp', 'serve',
                '--workspace', request['workspace'], '--profile', 'source-read-only']
        for source_id in request['sourceIds']:
            args.extend(['--allow-source', source_id])
        parameters = StdioServerParameters(command=sys.executable, args=args)
        async with asyncio.timeout(30), Client(parameters, read_timeout_seconds=25) as client:
            tools = await client.list_tools()
            status = await client.call_tool('knowledge_status')
            found = await client.call_tool('knowledge_discover', {'query': 'Temari', 'source_ids': request['sourceIds']})
            if status.is_error or found.is_error or found.structured_content.get('status') != 'complete':
                raise ValueError('Knowledge MCP readiness failed')
            return {'status': 'complete', 'connected': True, 'protocol': client.protocol_version,
                    'tools': sorted(tool.name for tool in tools.tools), 'query_result': found.structured_content}
    result = asyncio.run(check())
else:
    gateway = ConsumerGateway(registry, ConsumerScope.create(request['sourceIds']))
    if request['action'] == 'search':
        result = gateway.discover(request['query'], limit=8, max_bytes=24000, mode='exact')
    elif request['action'] == 'read':
        result = gateway.read(request['sourceId'], request['path'], max_chars=8000,
                              expected_generation=request.get('generation'),
                              expected_sha256=request.get('sha256'))
    else:
        raise ValueError('Unsupported library action')
print(json.dumps(result))
