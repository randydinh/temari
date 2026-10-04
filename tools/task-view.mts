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
  readonly talk?: TaskViewTalk;
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

/** Topic writes are independent of task execution admission. */
export interface TaskViewTalk {
  describe(): unknown | Promise<unknown>;
  topic(id: string, page: { offset?: number; limit?: number }): Promise<unknown>;
  create(input: unknown): Promise<unknown>;
  turn(topicId: string, input: unknown): Promise<unknown>;
  link(topicId: string, input: unknown): Promise<unknown>;
  ack(topicId: string, attentionId: string, input: unknown): Promise<unknown>;
  accept(topicId: string, turnId: string, input: unknown): Promise<unknown>;
}

/** The service owns admission, idempotency, runtime control, and acceptance. */
export interface TaskViewController {
  describe(): unknown | Promise<unknown>;
  create(input: unknown): Promise<unknown>;
  action(taskId: string, input: unknown): Promise<unknown>;
  reconciliationList?(): Promise<unknown>;
  reconciliationReview?(attemptId: string): Promise<unknown>;
  reconciliationCheckCurrentBinding?(attemptId: string, input: unknown): Promise<unknown>;
  reconciliationConfirmReviewed?(attemptId: string, input: unknown): Promise<unknown>;
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
const TOPIC_ID = '[A-Za-z0-9][A-Za-z0-9._-]{0,127}';

function topicPage(url: URL): { offset?: number; limit?: number } {
  const result: { offset?: number; limit?: number } = {};
  for (const key of url.searchParams.keys()) {
    if (
      (key !== 'offset' && key !== 'limit') ||
      url.searchParams.getAll(key).length !== 1
    )
      throw new RequestError(400, 'Select only one offset and limit.');
    const raw = url.searchParams.get(key)!;
    const value = Number(raw);
    if (
      !/^(0|[1-9]\d*)$/.test(raw) ||
      !Number.isSafeInteger(value) ||
      (key === 'limit' && (value < 1 || value > 50))
    )
      throw new RequestError(400, 'Topic page requires offset >= 0 and limit 1..50.');
    result[key] = value;
  }
  return result;
}

function topicInput(value: unknown, keys: readonly string[]): unknown {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    !Object.keys(value).every((key) => keys.includes(key))
  )
    throw new RequestError(400, 'Unexpected or missing topic request field.');
  const input = value as Record<string, unknown>;
  if (
    typeof input.requestId !== 'string' ||
    !new RegExp(`^${TOPIC_ID}$`).test(input.requestId) ||
    (keys.includes('expectedVersion') &&
      (!Number.isSafeInteger(input.expectedVersion) ||
        (input.expectedVersion as number) < 1))
  )
    throw new RequestError(400, 'Topic request identity and current version are required.');
  for (const key of ['title', 'text']) {
    const field = input[key];
    if (keys.includes(key) && (typeof field !== 'string' || !field.trim()))
      throw new RequestError(400, `Topic ${key} is required.`);
  }
  if (
    keys.includes('taskId') &&
    (typeof input.taskId !== 'string' || !new RegExp(`^${TOPIC_ID}$`).test(input.taskId))
  )
    throw new RequestError(400, 'Select one task identity.');
  return value;
}

function plainError(error: unknown): string {
  const value = error instanceof Error ? error.message : 'Task state could not be read.';
  return value
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .split(/[\r\n]/, 1)[0]!
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .trim()
    .slice(0, 1024) || 'Dashboard request failed.';
}

function headerCount(request: IncomingMessage, name: string): number {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2)
    if (request.rawHeaders[index]!.toLowerCase() === name) count++;
  return count;
}

function validateMutation(request: IncomingMessage, csrfToken: string, subject = 'Task'): void {
  if (
    headerCount(request, 'origin') !== 1 ||
    request.headers.origin !== `http://${request.headers.host}`
  )
    throw new RequestError(
      403,
      `${subject} changes require the exact local dashboard origin.`,
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
      `${subject} changes require this dashboard session token. Reload the dashboard.`,
    );
  const contentType = request.headers['content-type'];
  if (
    headerCount(request, 'content-type') !== 1 ||
    typeof contentType !== 'string' ||
    !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(contentType)
  )
    throw new RequestError(
      415,
      `${subject} changes require application/json encoded as UTF-8.`,
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
  ['/dashboard-talk.js', ['dashboard-talk.js', 'text/javascript; charset=utf-8']],
  ['/dashboard-reconciliation.js', ['dashboard-reconciliation.js', 'text/javascript; charset=utf-8']],
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
      if (url.pathname === '/api/topics' || url.pathname.startsWith('/api/topics/')) {
        const topicMatch = new RegExp(`^/api/topics/(${TOPIC_ID})$`).exec(url.pathname);
        const topicAction = new RegExp(
          `^/api/topics/(${TOPIC_ID})/(turns|links|attention/(${TOPIC_ID})/ack|proposals/(${TOPIC_ID})/accept)$`,
        ).exec(url.pathname);
        const list = url.pathname === '/api/topics';
        if (request.method === 'GET' || request.method === 'HEAD') {
          if (topicAction) {
            response.setHeader('Allow', 'POST');
            send(405, { error: 'Topic actions require POST.' });
          } else if (list) {
            if ((request.url ?? '').includes('?'))
              throw new RequestError(400, 'Unexpected topic list query.');
            send(200, options.talk ? await options.talk.describe() : {
              configured: false,
              setupReason: 'Talk is not configured.',
              topics: [],
              attention: [],
              capabilities: { canCreateTopic: false, canSendTurn: false, canLinkTask: false },
            });
          } else if (topicMatch) {
            const page = topicPage(url);
            if (!options.talk) throw new RequestError(404, 'Topic not found; Talk is not configured.');
            const topic = await options.talk.topic(topicMatch[1]!, page);
            send(topic == null ? 404 : 200, topic ?? { error: 'Topic not found.' });
          } else send(404, { error: 'Not found.' });
          return;
        }
        if ((!list && !topicAction) || (request.url ?? '').includes('?')) {
          send(404, { error: 'Not found.' });
          return;
        }
        if (!options.talk || request.method !== 'POST') {
          response.setHeader('Allow', options.talk ? 'POST' : 'GET, HEAD');
          send(405, { error: options.talk ? 'Topic changes require POST.' : 'Talk is not configured.' });
          return;
        }
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? ''))
          throw new RequestError(403, 'Topic changes require a local connection.');
        validateMutation(request, csrfToken, 'Topic');
        const action = topicAction?.[2];
        const input = topicInput(await readJsonBody(request), list
          ? ['requestId', 'title']
          : action === 'turns'
            ? ['requestId', 'expectedVersion', 'text']
            : action === 'links'
              ? ['requestId', 'expectedVersion', 'taskId']
              : ['requestId', 'expectedVersion']);
        const topicId = topicAction?.[1];
        const result = list ? await options.talk.create(input)
          : action === 'turns' ? await options.talk.turn(topicId!, input)
            : action === 'links' ? await options.talk.link(topicId!, input)
              : topicAction?.[3] ? await options.talk.ack(topicId!, topicAction[3], input)
                : await options.talk.accept(topicId!, topicAction![4]!, input);
        send(action === 'turns' ? 202 : 200, result);
        return;
      }
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
      if (url.pathname === '/api/reconciliation' || url.pathname.startsWith('/api/reconciliation/')) {
        const list = url.pathname === '/api/reconciliation';
        const match = /^\/api\/reconciliation\/([^/]+)(?:\/(review|invalidate|check-current-binding|confirm|confirm-reviewed))?$/.exec(url.pathname);
        if ((request.url ?? '').includes('?'))
          throw new RequestError(400, 'Unexpected reconciliation query.');
        let attemptId: string | undefined;
        if (match) {
          try { attemptId = decodeURIComponent(match[1]!); }
          catch { throw new RequestError(400, 'Invalid reconciliation attempt identity.'); }
          if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(attemptId))
            throw new RequestError(400, 'Invalid reconciliation attempt identity.');
        }
        if (!list && !match) { send(404, { error: 'Not found.' }); return; }
        const action = match?.[2];
        if (request.method === 'GET' || request.method === 'HEAD') {
          if (action && action !== 'review') {
            response.setHeader('Allow', 'POST');
            send(405, { error: 'Reconciliation intent actions require POST.' });
          } else if (list) {
            send(200, options.controller?.reconciliationList
              ? await options.controller.reconciliationList()
              : { configured: false, setupReason: 'Merge reconciliation is not configured.', attempts: [], page: { total: 0, limit: 50, omitted: 0 }, capabilities: { canCheckCurrentBinding: false, canRecordConfirmationIntent: false } });
          } else {
            const reader = action === 'review' ? options.controller?.reconciliationReview : options.controller?.reconciliationView;
            if (!reader) throw new RequestError(400, 'Merge reconciliation is not configured.');
            const result = await reader.call(options.controller, attemptId!);
            send(result == null ? 404 : 200, result ?? { error: 'Reconciliation attempt not found.' });
          }
          return;
        }
        if (!options.controller || request.method !== 'POST' || action === 'review' || (!list && !action)) {
          response.setHeader('Allow', !options.controller || action === 'review' || (!list && !action) ? 'GET, HEAD' : 'POST');
          send(405, { error: !options.controller ? 'The task view is read-only.' : 'Unsupported reconciliation method.' });
          return;
        }
        const dispatch = list ? options.controller.reconciliationCreate
          : action === 'check-current-binding' ? options.controller.reconciliationCheckCurrentBinding
            : action === 'invalidate' ? options.controller.reconciliationInvalidate
              : action === 'confirm' ? options.controller.reconciliationConfirm
              : options.controller.reconciliationConfirmReviewed;
        if (!dispatch) throw new RequestError(400, 'Merge reconciliation is not configured.');
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? ''))
          throw new RequestError(403, 'Reconciliation intent requires a local connection.');
        validateMutation(request, csrfToken, 'Reconciliation');
        const input = await readJsonBody(request);
        if (action === 'invalidate' || action === 'check-current-binding' || action === 'confirm-reviewed') {
          const keys = action === 'confirm-reviewed' ? ['requestId', 'reviewSha256'] : [];
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== keys.length || !Object.keys(input).every((key) => keys.includes(key)))
            throw new RequestError(400, 'Unexpected or missing reconciliation request field.');
          if (action === 'confirm-reviewed') {
            const selected = input as Record<string, unknown>;
            if (typeof selected.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(selected.requestId) || typeof selected.reviewSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(selected.reviewSha256))
              throw new RequestError(400, 'Select exact reconciliation request and review identities.');
          }
        }
        send(200, list
          ? await options.controller.reconciliationCreate!(input)
          : await (dispatch as (id: string, input: unknown) => Promise<unknown>).call(options.controller, attemptId!, input));
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
            !scheduleMatch)
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
        const result = scheduleMatch
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
          csrfToken: options.controller || options.talk ? csrfToken : null,
          config: options.controller
            ? await options.controller.describe()
            : null,
          archonBaseUrl,
          openWorkAvailable: Boolean(options.openWork),
          knowledgeAvailable: Boolean(options.knowledge),
          schedulingAvailable: Boolean(options.schedules),
          talkAvailable: Boolean(options.talk),
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
      const reconciliationRequest = /^\/api\/reconciliation(?:\/|\?|$)/.test(request.url ?? '');
      const topicRequest = /^\/api\/topics(?:\/|\?|$)/.test(request.url ?? '');
      const scheduleRequest = /^\/api\/schedules(?:\/|\?|$)/.test(request.url ?? '');
      const serviceError = error instanceof Error && (
        (options.talk && topicRequest && error.name === 'TalkRequestError') ||
        (options.schedules && scheduleRequest && error.name === 'DashboardScheduleRequestError') ||
        (options.controller && reconciliationRequest && error.name === 'ReconciliationBrowserRequestError')
      );
      const status =
        error instanceof RequestError
          ? error.status
          : serviceError && (controllerStatus === 400 || controllerStatus === 404 || controllerStatus === 409 || controllerStatus === 503)
            ? controllerStatus
          : options.controller && !topicRequest && !scheduleRequest &&
              (controllerStatus === 400 ||
                controllerStatus === 404 ||
                controllerStatus === 409)
            ? controllerStatus
            : 500;
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.setHeader('Connection', 'close');
        request.resume();
      }
      // The host can retain the full diagnostic in its selected local stderr;
      // the HTTP projection contains only a plain first-line message.
      if ((reconciliationRequest && !(error instanceof RequestError)) || status >= 500 || (serviceError && error instanceof Error && error.cause !== undefined)) console.error(error);
      send(status, {
        error: reconciliationRequest && !(error instanceof RequestError)
          ? status >= 500 ? 'Reconciliation state could not be read or retained.' : 'Reconciliation request refused.'
          : plainError(error),
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
