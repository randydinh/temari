import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  ScopedWorkerTools,
  type ScopedWorkerToolConfig,
} from './scoped-worker-tools.js';

export async function serveScopedWorkerTools(
  path: string,
  sha256: string,
): Promise<void> {
  assert(/^[a-f0-9]{64}$/.test(sha256));
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    assert((await file.stat()).size <= 32768);
    bytes = await file.readFile();
  } finally {
    await file.close();
  }
  assert(
    bytes.length <= 32768 &&
      createHash('sha256').update(bytes).digest('hex') === sha256,
    'Worker tool policy configuration changed.',
  );
  const tools = new ScopedWorkerTools(
    JSON.parse(bytes.toString()) as ScopedWorkerToolConfig,
  );
  await tools.validate();
  const server = new McpServer({
    name: 'temari-worker-mcp-server',
    version: '1.0.0',
  });
  const result = (value: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  });
  const wrap = (action: () => Promise<unknown>) =>
    action().then(result, () => ({
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: 'Operation refused by the selected workspace, ownership, or byte policy.',
        },
      ],
    }));
  const pathSchema = z.string().min(1).max(4096);
  const annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
  server.registerTool(
    'read_file',
    {
      description:
        'Read bounded UTF-8 text from the admitted workspace. Returns the hash required for an owned edit.',
      inputSchema: { path: pathSchema },
      annotations,
    },
    async ({ path }) => wrap(() => tools.invoke('read_file', { path })),
  );
  server.registerTool(
    'list_files',
    {
      description:
        'List bounded entries in an admitted workspace directory; protected metadata and symlinks are excluded.',
      inputSchema: { path: pathSchema.optional() },
      annotations,
    },
    async ({ path }) => wrap(() => tools.invoke('list_files', { path })),
  );
  server.registerTool(
    'search_text',
    {
      description:
        'Search a literal substring in bounded workspace text files. Returns matching paths and lines with truncation evidence.',
      inputSchema: {
        query: z.string().min(1).max(256),
        path: pathSchema.optional(),
      },
      annotations,
    },
    async ({ query, path }) =>
      wrap(() => tools.invoke('search_text', { query, path })),
  );
  if (tools.config.access === 'workspace-write')
    server.registerTool(
      'write_file',
      {
        description:
          'Replace or create one UTF-8 file within typed ownership. Supply its observed SHA-256, or null only for a new file.',
        inputSchema: {
          path: pathSchema,
          text: z.string().max(256 * 1024),
          expectedSha256: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .nullable(),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({ path, text, expectedSha256 }) =>
        wrap(() => tools.invoke('write_file', { path, text, expectedSha256 })),
    );
  await server.connect(new StdioServerTransport());
}
if (process.argv[2] === '--config') {
  serveScopedWorkerTools(process.argv[3]!, process.argv[4]!).catch(() => {
    console.error('Scoped worker MCP startup refused.');
    process.exitCode = 1;
  });
}
