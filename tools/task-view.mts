import { createServer, type IncomingMessage, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { emptyOpenWork } from './dashboard-open-work.mjs';

export interface TaskViewReader {
  listSnapshots(): Promise<readonly { readonly taskId: string }[]>;
  snapshot(taskId: string): Promise<unknown>;
  pickup(request: {
    readonly taskId: string;
  }): Promise<{ readonly status: string; readonly selected: unknown }>;
}

export interface TaskViewOptions {
  readonly runtime: TaskViewReader;
  readonly openWork?: { describe(): Promise<unknown> };
  readonly archonBaseUrl: string;
  readonly controller?: TaskViewController;
  readonly knowledge?: {
    inspect(): Promise<unknown>;
    select(nodeId: string): Promise<unknown>;
    expand(nodeId: string): Promise<unknown>;
  };
  readonly schedules?: {
    describe(): Promise<unknown>;
    create(input: unknown): Promise<unknown>;
    update(id: string, input: unknown): Promise<unknown>;
  };
}

/** The service owns admission, idempotency, runtime control, and acceptance. */
export interface TaskViewController {
  describe(): unknown | Promise<unknown>;
  create(input: unknown): Promise<unknown>;
  action(taskId: string, input: unknown): Promise<unknown>;
  reconciliationView?(attemptId: string): Promise<unknown>;
  reconciliationCreate?(input: unknown): Promise<unknown>;
  reconciliationInvalidate?(
    attemptId: string,
    input: unknown,
  ): Promise<unknown>;
  reconciliationConfirm?(attemptId: string, input: unknown): Promise<unknown>;
}

export class TaskViewControllerError extends Error {
  constructor(
    readonly status: 400 | 409,
    message: string,
  ) {
    super(message);
    this.name = 'TaskViewControllerError';
  }
}

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const BODY_LIMIT = 64 * 1024;
const BODY_TIMEOUT_MS = 5_000;

function headerCount(request: IncomingMessage, name: string): number {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2)
    if (request.rawHeaders[index]!.toLowerCase() === name) count++;
  return count;
}

function validateMutation(request: IncomingMessage, csrfToken: string): void {
  if (
    headerCount(request, 'origin') !== 1 ||
    request.headers.origin !== `http://${request.headers.host}`
  )
    throw new RequestError(
      403,
      'Task changes require the exact local dashboard origin.',
    );
  const token = request.headers['x-temari-token'];
  if (
    headerCount(request, 'x-temari-token') !== 1 ||
    typeof token !== 'string' ||
    Buffer.byteLength(token) !== Buffer.byteLength(csrfToken) ||
    !timingSafeEqual(Buffer.from(token), Buffer.from(csrfToken))
  )
    throw new RequestError(
      403,
      'Task changes require this dashboard session token. Reload the dashboard.',
    );
  const contentType = request.headers['content-type'];
  if (
    headerCount(request, 'content-type') !== 1 ||
    typeof contentType !== 'string' ||
    !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(contentType)
  )
    throw new RequestError(
      415,
      'Task changes require application/json encoded as UTF-8.',
    );
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const length = request.headers['content-length'];
  if (
    length !== undefined &&
    (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT)
  )
    throw new RequestError(413, 'Task request body exceeds 64 KiB.');
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('aborted', onAborted);
      if (error) {
        request.resume();
        reject(error);
      } else resolve(Buffer.concat(chunks, size));
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        finish(new RequestError(413, 'Task request body exceeds 64 KiB.'));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => finish();
    const onAborted = (): void =>
      finish(new RequestError(400, 'Task request body was interrupted.'));
    const timer = setTimeout(
      () => finish(new RequestError(408, 'Task request body timed out.')),
      BODY_TIMEOUT_MS,
    );
    timer.unref();
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('aborted', onAborted);
    // Retain this listener until the request is collected, including after a
    // size refusal or timeout while the peer is still sending bytes.
    request.once('error', (error) => finish(error));
  });
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw new RequestError(400, 'Task request body must be valid UTF-8 JSON.');
  }
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
  [
    '/dashboard-pages.js',
    ['dashboard-pages.js', 'text/javascript; charset=utf-8'],
  ],
] as const);

/** Local task projection with optional mutations delegated to the controller. */
export function createTaskViewServer(options: TaskViewOptions): Server {
  const archonBaseUrl = validateArchonBaseUrl(options.archonBaseUrl);
  const csrfToken = randomBytes(32).toString('hex');
  const server = createServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD')
      response.setHeader('Connection', 'close');
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
        headerCount(request, 'host') !== 1 ||
        ![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(
          request.headers.host ?? '',
        )
      ) {
        send(403, { error: 'This task view accepts local requests only.' });
        return;
      }
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
      if (url.pathname === '/api/open-work') {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.setHeader('Allow', 'GET, HEAD');
          send(405, { error: 'Open work is read-only.' });
          return;
        }
        if ((request.url ?? '').includes('?'))
          throw new RequestError(400, 'Unexpected open-work query.');
        send(
          200,
          options.openWork
            ? await options.openWork.describe()
            : emptyOpenWork(),
        );
        return;
      }
      const actionMatch =
        /^\/api\/tasks\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/actions$/.exec(
          url.pathname,
        );
      const scheduleMatch =
        /^\/api\/schedules\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/actions$/.exec(
          url.pathname,
        );
      const reconciliationViewMatch =
        /^\/api\/reconciliation\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/.exec(
          url.pathname,
        );
      const reconciliationActionMatch =
        /^\/api\/reconciliation\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/(invalidate|confirm)$/.exec(
          url.pathname,
        );
      if (
        request.method !== 'GET' &&
        request.method !== 'HEAD' &&
        !options.controller
      ) {
        response.setHeader('Allow', 'GET, HEAD');
        send(405, { error: 'The task view is read-only.' });
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        if (request.method !== 'POST') {
          response.setHeader('Allow', actionMatch ? 'POST' : 'GET, HEAD, POST');
          send(405, {
            error:
              'This dashboard accepts POST only for task creation and task actions.',
          });
          return;
        }
        if (
          url.search ||
          (url.pathname !== '/api/tasks' &&
            !actionMatch &&
            url.pathname !== '/api/schedules' &&
            !scheduleMatch &&
            url.pathname !== '/api/reconciliation' &&
            !reconciliationActionMatch)
        ) {
          send(404, { error: 'Not found.' });
          return;
        }
        if (
          !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(
            request.socket.remoteAddress ?? '',
          )
        )
          throw new RequestError(
            403,
            'Task changes require a local connection.',
          );
        validateMutation(request, csrfToken);
        const input = await readJsonBody(request);
        if (
          (url.pathname === '/api/schedules' || scheduleMatch) &&
          !options.schedules
        )
          throw new RequestError(400, 'Scheduling is not configured.');
        if (
          (url.pathname === '/api/reconciliation' ||
            reconciliationActionMatch) &&
          (!options.controller?.reconciliationCreate ||
            !options.controller.reconciliationInvalidate ||
            !options.controller.reconciliationConfirm)
        )
          throw new RequestError(
            400,
            'Merge reconciliation is not configured.',
          );
        const result = reconciliationActionMatch
          ? reconciliationActionMatch[2] === 'invalidate'
            ? await options.controller!.reconciliationInvalidate!(
                reconciliationActionMatch[1]!,
                input,
              )
            : await options.controller!.reconciliationConfirm!(
                reconciliationActionMatch[1]!,
                input,
              )
          : url.pathname === '/api/reconciliation'
            ? await options.controller!.reconciliationCreate!(input)
            : scheduleMatch
              ? await options.schedules!.update(scheduleMatch[1]!, input)
              : url.pathname === '/api/schedules'
                ? await options.schedules!.create(input)
                : actionMatch
                  ? await options.controller!.action(actionMatch[1]!, input)
                  : await options.controller!.create(input);
        send(200, result);
        return;
      }
      if (url.pathname === '/api/dashboard') {
        send(200, {
          mode: options.controller ? 'writable' : 'read-only',
          csrfToken: options.controller ? csrfToken : null,
          config: options.controller
            ? await options.controller.describe()
            : null,
          archonBaseUrl,
          openWorkAvailable: Boolean(options.openWork),
          knowledgeAvailable: Boolean(options.knowledge),
          schedulingAvailable: Boolean(options.schedules),
        });
        return;
      }
      if (url.pathname === '/api/schedules') {
        if (url.search)
          throw new RequestError(400, 'Unexpected schedule query.');
        send(
          200,
          options.schedules
            ? await options.schedules.describe()
            : { configured: false, schedules: [], targets: [] },
        );
        return;
      }
      if (reconciliationViewMatch) {
        if (!options.controller?.reconciliationView)
          throw new RequestError(
            400,
            'Merge reconciliation is not configured.',
          );
        if (url.search)
          throw new RequestError(400, 'Unexpected reconciliation query.');
        const view = await options.controller.reconciliationView(
          reconciliationViewMatch[1]!,
        );
        send(
          view ? 200 : 404,
          view ?? { error: 'Reconciliation attempt not found.' },
        );
        return;
      }
      if (
        url.pathname === '/api/knowledge' ||
        url.pathname === '/api/knowledge/expand' ||
        url.pathname === '/api/knowledge/node'
      ) {
        const params = [...url.searchParams.keys()];
        if (
          url.pathname === '/api/knowledge'
            ? params.length > 0
            : params.length !== 1 ||
              params[0] !== 'node' ||
              url.searchParams.getAll('node').length !== 1
        )
          throw new RequestError(400, 'Select one configured node identity.');
        const node = url.searchParams.get('node');
        if (
          url.pathname !== '/api/knowledge' &&
          (!node || node.length > 256 || node.includes('\0'))
        )
          throw new RequestError(400, 'Invalid knowledge node identity.');
        if (!options.knowledge) {
          send(200, {
            schema: 1,
            state: 'not-configured',
            nodes: [],
            edges: [],
            gaps: [
              {
                reason:
                  'Configure pinned Registrar publications to view their map.',
              },
            ],
            historical: true,
            currentOriginal: 'not-checked',
          });
          return;
        }
        send(
          200,
          url.pathname === '/api/knowledge'
            ? await options.knowledge.inspect()
            : url.pathname === '/api/knowledge/expand'
              ? await options.knowledge.expand(node!)
              : await options.knowledge.select(node!),
        );
        return;
      }
      if (actionMatch && options.controller) {
        response.setHeader('Allow', 'POST');
        send(405, { error: 'Task actions require POST.' });
        return;
      }
      if (url.pathname === '/api/tasks') {
        send(200, {
          tasks: await options.runtime.listSnapshots(),
          archonBaseUrl,
        });
        return;
      }
      const pickup =
        /^\/api\/tasks\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/pickup$/.exec(
          url.pathname,
        );
      if (pickup) {
        const result = await options.runtime.pickup({ taskId: pickup[1]! });
        send(result.status === 'empty' ? 404 : 200, result);
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
      const controllerStatus =
        error && typeof error === 'object' && 'status' in error
          ? error.status
          : undefined;
      const status =
        error instanceof RequestError
          ? error.status
          : options.controller &&
              (controllerStatus === 400 ||
                controllerStatus === 404 ||
                controllerStatus === 409)
            ? controllerStatus
            : 500;
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.setHeader('Connection', 'close');
        request.resume();
      }
      send(status, {
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
