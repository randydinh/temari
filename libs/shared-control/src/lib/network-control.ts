import assert from 'node:assert/strict';
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';

import type {
  Nx05ImmutableArtifactProvider,
  Nx05SharedControlProvider,
} from '@temari/runtime';

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const COMMANDS = [
  'createParent',
  'loadParent',
  'claimParent',
  'renewParent',
  'cancelParent',
  'claimChildGroup',
  'renewChild',
  'loadChild',
  'commitParentAndDispatch',
  'publishChild',
] as const;
type Command = (typeof COMMANDS)[number];
type Backend = Pick<Nx05SharedControlProvider, Command>;
type ArtifactBackend = Nx05ImmutableArtifactProvider;
type WireRequest = {
  command: Command | 'putArtifact' | 'loadArtifact';
  input: unknown;
};

function tokenMatches(actual: string | undefined, expected: string): boolean {
  if (!actual?.startsWith('Bearer ')) return false;
  const received = Buffer.from(actual.slice(7));
  const required = Buffer.from(expected);
  return (
    received.length === required.length && timingSafeEqual(received, required)
  );
}

async function readJson(request: IncomingMessage): Promise<WireRequest> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    assert(bytes <= MAX_REQUEST_BYTES, 'Request exceeds limit.');
    chunks.push(buffer);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert(value && typeof value === 'object' && !Array.isArray(value));
  const record = value as Record<string, unknown>;
  assert.deepEqual(Object.keys(record).sort(), ['command', 'input']);
  assert(typeof record.command === 'string');
  return record as WireRequest;
}

function send(
  response: import('node:http').ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > MAX_RESPONSE_BYTES) {
    response
      .writeHead(413)
      .end(JSON.stringify({ ok: false, error: 'Response exceeds limit.' }));
    return;
  }
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  response.end(body);
}

/** Loopback-only service boundary for the local NX05 recovery stack. */
export async function startNx05LoopbackService(options: {
  readonly control: Backend;
  readonly artifacts: ArtifactBackend;
  readonly token: string;
  readonly port?: number;
}): Promise<{ readonly url: string; readonly close: () => Promise<void> }> {
  assert(options.token.length >= 32, 'Service token is too short.');
  const server: Server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/command') {
      send(response, 404, { ok: false, error: 'Unknown route.' });
      return;
    }
    if (!tokenMatches(request.headers.authorization, options.token)) {
      send(response, 401, { ok: false, error: 'Unauthorized.' });
      return;
    }
    try {
      const { command, input } = await readJson(request);
      let value: unknown;
      if (COMMANDS.includes(command as Command)) {
        const method = options.control[command as Command] as (
          input: never,
        ) => Promise<unknown>;
        value = await method.call(options.control, input as never);
      } else if (command === 'putArtifact') {
        assert(input && typeof input === 'object');
        const { contentBase64, runId, revision, kind } = input as Record<
          string,
          unknown
        >;
        assert(
          typeof contentBase64 === 'string' &&
            contentBase64.length <= MAX_REQUEST_BYTES,
        );
        assert(
          typeof runId === 'string' &&
            typeof revision === 'string' &&
            typeof kind === 'string',
        );
        assert(
          /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
            contentBase64,
          ),
        );
        value = await options.artifacts.put({
          runId,
          revision,
          kind: kind as Parameters<ArtifactBackend['put']>[0]['kind'],
          content: Buffer.from(contentBase64, 'base64'),
        });
      } else if (command === 'loadArtifact') {
        const bytes = await options.artifacts.load(
          input as Parameters<ArtifactBackend['load']>[0],
        );
        value = { contentBase64: Buffer.from(bytes).toString('base64') };
      } else {
        send(response, 404, { ok: false, error: 'Unknown command.' });
        return;
      }
      send(response, 200, { ok: true, value });
    } catch {
      send(response, 400, { ok: false, error: 'Command rejected.' });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** Transport adapter: the client only receives a URL and a token, never the database path. */
export class Nx05NetworkClient
  implements Nx05SharedControlProvider, Nx05ImmutableArtifactProvider
{
  readonly scope = 'shared-service' as const;

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {
    const parsed = new URL(url);
    assert(
      parsed.protocol === 'http:' &&
        parsed.hostname === '127.0.0.1' &&
        parsed.pathname === '/' &&
        !parsed.username &&
        !parsed.password &&
        !parsed.search &&
        !parsed.hash,
      'Only a loopback HTTP origin is supported.',
    );
    assert(token.length >= 32, 'Service token is too short.');
  }

  private async command<T>(
    command: WireRequest['command'],
    input: unknown,
  ): Promise<T> {
    const response = await fetch(`${this.url}/v1/command`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ command, input }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.text();
    assert(
      Buffer.byteLength(body) <= MAX_RESPONSE_BYTES,
      'Service response exceeds limit.',
    );
    const parsed = JSON.parse(body) as {
      ok: boolean;
      value?: T;
      error?: string;
    };
    assert(response.ok && parsed.ok, parsed.error ?? 'Service command failed.');
    return parsed.value as T;
  }

  createParent(
    request: Parameters<Nx05SharedControlProvider['createParent']>[0],
  ) {
    return this.command<
      Awaited<ReturnType<Nx05SharedControlProvider['createParent']>>
    >('createParent', request);
  }
  loadParent(runId: string) {
    return this.command<
      Awaited<ReturnType<Nx05SharedControlProvider['loadParent']>>
    >('loadParent', runId);
  }
  claimParent(
    request: Parameters<Nx05SharedControlProvider['claimParent']>[0],
  ) {
    return this.command<
      Awaited<ReturnType<Nx05SharedControlProvider['claimParent']>>
    >('claimParent', request);
  }
  renewParent(
    request: Parameters<Nx05SharedControlProvider['renewParent']>[0],
  ) {
    return this.command<
      Awaited<ReturnType<Nx05SharedControlProvider['renewParent']>>
    >('renewParent', request);
  }
  cancelParent(
    request: Parameters<Nx05SharedControlProvider['cancelParent']>[0],
  ) {
    return this.command<
      Awaited<ReturnType<Nx05SharedControlProvider['cancelParent']>>
    >('cancelParent', request);
  }
  claimChildGroup(
    request: Parameters<Nx05SharedControlProvider['claimChildGroup']>[0],
  ) {
    return this.command<
      Awaited<ReturnType<Nx05SharedControlProvider['claimChildGroup']>>
    >('claimChildGroup', request);
  }
  renewChild(request: Parameters<Nx05SharedControlProvider['renewChild']>[0]) {
    return this.command<
      Awaited<ReturnType<Nx05SharedControlProvider['renewChild']>>
    >('renewChild', request);
  }
  loadChild(taskId: string) {
    return this.command<
      Awaited<ReturnType<Nx05SharedControlProvider['loadChild']>>
    >('loadChild', taskId);
  }
  commitParentAndDispatch(
    request: Parameters<
      Nx05SharedControlProvider['commitParentAndDispatch']
    >[0],
  ) {
    return this.command<
      Awaited<ReturnType<Nx05SharedControlProvider['commitParentAndDispatch']>>
    >('commitParentAndDispatch', request);
  }
  publishChild(
    request: Parameters<Nx05SharedControlProvider['publishChild']>[0],
  ) {
    return this.command<
      Awaited<ReturnType<Nx05SharedControlProvider['publishChild']>>
    >('publishChild', request);
  }
  put(input: Parameters<Nx05ImmutableArtifactProvider['put']>[0]) {
    return this.command<
      Awaited<ReturnType<Nx05ImmutableArtifactProvider['put']>>
    >('putArtifact', {
      runId: input.runId,
      revision: input.revision,
      kind: input.kind,
      contentBase64: Buffer.from(input.content).toString('base64'),
    });
  }
  async load(reference: Parameters<Nx05ImmutableArtifactProvider['load']>[0]) {
    const result = await this.command<{ contentBase64: string }>(
      'loadArtifact',
      reference,
    );
    return Buffer.from(result.contentBase64, 'base64');
  }
}
