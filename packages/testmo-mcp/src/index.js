import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { definitions, createService } from './service.js';
import { loadWindowsToken } from './credential.js';

export function createServer(options = {}) {
  const service = createService(options);
  const server = new McpServer({ name: 'testmo', version: '0.1.0' });
  for (const [name, def] of Object.entries(definitions)) {
    if (def.write && !service.writeEnabled) continue;
    server.registerTool(
      name,
      {
        description: def.description,
        inputSchema: def.schema.shape,
        annotations: {
          readOnlyHint: !def.write,
          destructiveHint: false,
          idempotentHint: !def.write,
          openWorldHint: true,
        },
      },
      async (input) => {
        try {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(await service.call(name, input)),
              },
            ],
          };
        } catch (error) {
          return {
            isError: true,
            content: [{ type: 'text', text: error.message }],
          };
        }
      },
    );
  }
  return server;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  loadWindowsToken();
  await createServer().connect(new StdioServerTransport());
}
