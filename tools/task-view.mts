import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';

export interface TaskViewReader {
  listSnapshots(): Promise<readonly { readonly taskId: string }[]>;
  snapshot(taskId: string): Promise<unknown>;
}

export interface TaskViewOptions {
  readonly runtime: TaskViewReader;
  readonly archonBaseUrl: string;
}

/** The console location is configured by the operator, never by task content. */
export function validateArchonBaseUrl(value: string): string {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      'Archon URL must be an HTTP(S) origin without credentials, query or fragment.',
    );
  if (url.pathname !== '/')
    throw new Error(
      'Archon URL must be an origin, for example http://127.0.0.1:3091.',
    );
  return url.origin;
}

const assets = new Map([
  ['/', ['task-view.html', 'text/html; charset=utf-8']],
  ['/task-view.js', ['task-view.js', 'text/javascript; charset=utf-8']],
  ['/task-view.css', ['task-view.css', 'text/css; charset=utf-8']],
] as const);

/** Read-only projection; every task mutation stays behind the runtime CLI/API. */
export function createTaskViewServer(options: TaskViewOptions): Server {
  const archonBaseUrl = validateArchonBaseUrl(options.archonBaseUrl);
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    const send = (status: number, data: unknown): void => {
      response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
      });
      response.end(
        request.method === 'HEAD' ? undefined : JSON.stringify(data),
      );
    };
    try {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      if (
        ![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(
          request.headers.host ?? '',
        )
      ) {
        send(403, { error: 'This task view accepts local requests only.' });
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.setHeader('Allow', 'GET, HEAD');
        send(405, { error: 'The task view is read-only.' });
        return;
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/api/tasks') {
        send(200, {
          tasks: await options.runtime.listSnapshots(),
          archonBaseUrl,
        });
        return;
      }
      const match = /^\/api\/tasks\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(
        url.pathname,
      );
      if (match) {
        const task = (await options.runtime.listSnapshots()).find(
          (item) => item.taskId === match[1],
        );
        send(
          task ? 200 : 404,
          task ? { task, archonBaseUrl } : { error: 'Task not found.' },
        );
        return;
      }
      const asset = assets.get(url.pathname as '/');
      if (asset) {
        const bytes = await readFile(new URL(`./${asset[0]}`, import.meta.url));
        response.writeHead(200, { 'Content-Type': asset[1] });
        response.end(request.method === 'HEAD' ? undefined : bytes);
        return;
      }
      send(404, { error: 'Not found.' });
    } catch (error) {
      // Do not turn an unreadable/corrupt ledger into an empty, successful inbox.
      send(500, {
        error:
          error instanceof Error
            ? error.message
            : 'Task state could not be read.',
      });
    }
  });
  return server;
}

export async function startTaskViewServer(
  options: TaskViewOptions & { readonly port?: number },
): Promise<Server> {
  const port = options.port ?? 3092;
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('Port must be between 0 and 65535.');
  const server = createTaskViewServer(options);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return server;
}
