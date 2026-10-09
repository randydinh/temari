import assert from 'node:assert/strict';
import childProcess, {
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import fsPromises, {
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runProcessToFiles } from './process-capture.js';

const bytes = 16_777_217;
const emitter = `const write=async(stream,value)=>{const chunk=Buffer.alloc(65536,value);for(let n=0;n<256;n++)await new Promise((done,reject)=>stream.write(chunk,e=>e?reject(e):done()));await new Promise((done,reject)=>stream.write('!',e=>e?reject(e):done()));};Promise.all([write(process.stdout,97),write(process.stderr,122)]).then(()=>{EXIT});`;
function expected(value: number) {
  const hash = createHash('sha256');
  for (let n = 0; n < 256; n++) hash.update(Buffer.alloc(65536, value));
  return hash.update('!').digest('hex');
}

test('normal and nonzero process capture retain each full pipe beyond 16 MiB without a volume kill', async (t) => {
  for (const code of [0, 7])
    await t.test(`exit ${code}`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'temari-process-large-'));
      try {
        let started: { pid: number; startedAt: string } | undefined;
        const captured = await runProcessToFiles({
          program: process.execPath,
          args: ['-e', emitter.replace('EXIT', `process.exit(${code})`)],
          cwd: root,
          stdoutPath: join(root, 'stdout'),
          stderrPath: join(root, 'stderr'),
          timeoutMs: 10000,
          onStarted: async (identity) => {
            started = identity;
          },
        });
        assert.equal(captured.code, code);
        assert.equal(captured.captureComplete, true);
        assert.equal(captured.timedOut, false);
        assert.equal(captured.pid, started!.pid);
        assert.equal(captured.startedAt, started!.startedAt);
        for (const [stream, value] of [
          [captured.stdout, 97],
          [captured.stderr, 122],
        ] as const) {
          assert.equal(stream.receivedBytes, bytes);
          assert.equal(stream.bytes, bytes);
          assert.equal(stream.sha256, expected(value));
          assert.equal((await stat(stream.path)).size, bytes);
          assert.equal((await stat(stream.path)).mode & 0o777, 0o600);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
});

test('timeout and cancellation drain the full available prefix on both pipes', async (t) => {
  for (const cancelled of [false, true])
    await t.test(cancelled ? 'cancel' : 'timeout', async () => {
      const root = await mkdtemp(join(tmpdir(), 'temari-process-interrupt-'));
      const controller = new AbortController();
      const timer = cancelled
        ? setTimeout(() => controller.abort(), 600)
        : null;
      try {
        const captured = await runProcessToFiles({
          program: process.execPath,
          args: ['-e', emitter.replace('EXIT', 'setInterval(()=>{},10000)')],
          cwd: root,
          stdoutPath: join(root, 'stdout'),
          stderrPath: join(root, 'stderr'),
          timeoutMs: cancelled ? 10000 : 600,
          signal: controller.signal,
        });
        assert.equal(captured.captureComplete, true);
        assert.equal(captured.cancelled, cancelled);
        assert.equal(captured.timedOut, !cancelled);
        assert.equal(captured.stdout.bytes, bytes);
        assert.equal(captured.stderr.bytes, bytes);
        assert.equal(captured.stdout.sha256, expected(97));
        assert.equal(captured.stderr.sha256, expected(122));
      } finally {
        if (timer) clearTimeout(timer);
        await rm(root, { recursive: true, force: true });
      }
    });
});

test('independent stdout/stderr write failures terminate execution and retain honest partial metadata', async (t) => {
  for (const streamName of ['stdout', 'stderr'] as const)
    await t.test(streamName, async () => {
      const root = await mkdtemp(join(tmpdir(), 'temari-process-sink-'));
      const probe = await open(join(root, 'probe'), 'w');
      const prototype = Object.getPrototypeOf(probe),
        original = prototype.writeFile;
      await probe.close();
      let failed = false;
      let stdoutFd: number | null = null;
      let stderrFd: number | null = null;
      const mocked = t.mock.method(
        prototype,
        'writeFile',
        async function (this: { fd: number }, chunk: Uint8Array) {
          if (chunk[0] === 97) stdoutFd = this.fd;
          if (chunk[0] === 122) stderrFd = this.fd;
          if (
            !failed &&
            this.fd === (streamName === 'stdout' ? stdoutFd : stderrFd)
          ) {
            failed = true;
            throw new Error('PRIVATE_SINK_FAILURE_SENTINEL');
          }
          return original.call(this, chunk);
        },
      );
      try {
        const captured = await runProcessToFiles({
          program: process.execPath,
          args: ['-e', emitter.replace('EXIT', 'setInterval(()=>{},10000)')],
          cwd: root,
          stdoutPath: join(root, 'stdout'),
          stderrPath: join(root, 'stderr'),
          timeoutMs: 10000,
        });
        assert(failed);
        assert.equal(captured.captureComplete, false);
        assert.equal(captured[streamName].status, 'capture-failed');
        assert.equal(
          captured[streamName].bytes,
          (await stat(captured[streamName].path)).size,
        );
        assert(
          !JSON.stringify(captured).includes('PRIVATE_SINK_FAILURE_SENTINEL'),
        );
      } finally {
        mocked.mock.restore();
        await rm(root, { recursive: true, force: true });
      }
    });
});

test('a synchronous actual-start hook failure terminates the process and settles retained capture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-start-hook-failure-'));
  try {
    let startedPid = 0;
    const captured = await runProcessToFiles({
      program: process.execPath,
      args: ['-e', 'setInterval(()=>{},10000)'],
      cwd: root,
      stdoutPath: join(root, 'stdout'),
      stderrPath: join(root, 'stderr'),
      timeoutMs: 10000,
      onStarted: (identity) => {
        startedPid = identity.pid;
        throw new Error('PRIVATE_HOOK_FAILURE_SENTINEL');
      },
    });
    assert(startedPid > 0);
    assert.equal(captured.pid, startedPid);
    assert.match(captured.error!, /Worker start observation failed/);
    assert.equal(captured.code, null);
    assert.equal(captured.captureComplete, true);
    assert.equal(
      captured.stdout.bytes,
      (await stat(captured.stdout.path)).size,
    );
    assert.equal(
      captured.stderr.bytes,
      (await stat(captured.stderr.path)).size,
    );
    assert.throws(() => process.kill(startedPid, 0), /ESRCH/);
    assert(!JSON.stringify(captured).includes('PRIVATE_HOOK_FAILURE_SENTINEL'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a large internal start-observation cause is retained in full privately with typed source metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-large-operational-cause-'));
  const cause = 'PRIVATE_START_CAUSE_SENTINEL:' + 'x'.repeat(16_777_217);
  try {
    const captured = await runProcessToFiles({
      program: process.execPath,
      args: ['-e', 'setInterval(()=>{},10000)'],
      cwd: root,
      stdoutPath: join(root, 'stdout'),
      stderrPath: join(root, 'stderr'),
      timeoutMs: 10000,
      onStarted: () => {
        throw cause;
      },
    });
    assert.equal(captured.diagnostics.length, 1);
    const diagnostic = captured.diagnostics[0]!;
    assert.equal(diagnostic.category, 'start-observation');
    assert.equal(diagnostic.status, 'complete');
    assert.equal(diagnostic.bytes, Buffer.byteLength(cause));
    assert.equal(
      diagnostic.sha256,
      createHash('sha256').update(cause).digest('hex'),
    );
    assert.equal((await stat(diagnostic.path)).size, diagnostic.bytes);
    assert(!JSON.stringify(captured).includes('PRIVATE_START_CAUSE_SENTINEL'));
    const file = await open(diagnostic.path, 'r');
    try {
      const prefix = Buffer.alloc(64);
      await file.read(prefix, 0, prefix.length, 0);
      assert(prefix.toString().startsWith('PRIVATE_START_CAUSE_SENTINEL:'));
    } finally {
      await file.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stdin tolerates peer closure and retains full other operational causes while terminating the child', async (t) => {
  for (const code of ['EPIPE', 'ECONNRESET', 'EIO'])
    await t.test(code, async (sub) => {
      const root = await mkdtemp(join(tmpdir(), 'temari-stdin-diagnostic-'));
      const cause = Object.assign(
        new Error(
          'PRIVATE_STDIN_FAILURE:' +
            'x'.repeat(code === 'EIO' ? 16_777_217 : 1),
        ),
        { code },
      );
      const original = childProcess.spawn;
      const mocked = sub.mock.method(
        childProcess,
        'spawn',
        (...args: unknown[]) => {
          const child = Reflect.apply(
            original,
            childProcess,
            args,
          ) as ChildProcessWithoutNullStreams;
          setImmediate(() => child.stdin.emit('error', cause));
          return child;
        },
      );
      syncBuiltinESMExports();
      try {
        const captured = await runProcessToFiles({
          program: process.execPath,
          args: ['-e', "setTimeout(()=>process.stdout.write('finished'),100)"],
          cwd: root,
          stdoutPath: join(root, 'stdout'),
          stderrPath: join(root, 'stderr'),
          timeoutMs: 10000,
        });
        if (code === 'EIO') {
          assert.match(captured.error!, /Process input failed/);
          const diagnostic = captured.diagnostics.find(
            (item) => item.category === 'stdin',
          )!;
          assert(diagnostic);
          assert.equal(diagnostic.status, 'complete');
          assert(diagnostic.bytes > 16_777_216);
          assert.equal(
            diagnostic.sha256,
            createHash('sha256').update(cause.stack!).digest('hex'),
          );
          assert(!JSON.stringify(captured).includes('PRIVATE_STDIN_FAILURE'));
        } else {
          assert.equal(captured.error, null);
          assert.equal(captured.code, 0);
          assert.equal(captured.stdout.bytes, 8);
          assert.equal(captured.diagnostics.length, 0);
        }
      } finally {
        mocked.mock.restore();
        syncBuiltinESMExports();
        await rm(root, { recursive: true, force: true });
      }
    });
});

test('shared operational bootstrap failures return controlled incomplete capture with full private causes and actual spool availability', async (t) => {
  for (const operation of ['stdout', 'stderr', 'mkdir', 'chmod'] as const)
    await t.test(operation, async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'temari-capture-bootstrap-')),
        stdoutPath = join(root, 'stdout'),
        stderrPath = join(root, 'stderr'),
        cause = 'PRIVATE_BOOTSTRAP_CAUSE:' + 'b'.repeat(16_777_217);
      let restore: () => void;
      if (operation === 'stdout' || operation === 'stderr') {
        const original = fsPromises.open,
          patch = t.mock.method(
            fsPromises,
            'open',
            async (...args: Parameters<typeof open>) => {
              if (
                String(args[0]) ===
                (operation === 'stdout' ? stdoutPath : stderrPath)
              )
                throw cause;
              return original(...args);
            },
          );
        restore = () => patch.mock.restore();
      } else if (operation === 'mkdir') {
        const original = fsPromises.mkdir,
          patch = t.mock.method(
            fsPromises,
            'mkdir',
            async (...args: Parameters<typeof fsPromises.mkdir>) => {
              if (String(args[0]) === root) throw cause;
              return original(...args);
            },
          );
        restore = () => patch.mock.restore();
      } else {
        const original = fsPromises.chmod,
          patch = t.mock.method(
            fsPromises,
            'chmod',
            async (...args: Parameters<typeof fsPromises.chmod>) => {
              if (String(args[0]) === root) throw cause;
              return original(...args);
            },
          );
        restore = () => patch.mock.restore();
      }
      syncBuiltinESMExports();
      let captured: Awaited<ReturnType<typeof runProcessToFiles>>;
      try {
        captured = await runProcessToFiles({
          program: process.execPath,
          args: ['-e', 'process.exit(99)'],
          cwd: root,
          stdoutPath,
          stderrPath,
          timeoutMs: 5000,
        });
      } finally {
        restore!();
        syncBuiltinESMExports();
      }
      assert.equal(captured!.pid, null);
      assert.equal(captured!.captureComplete, false);
      assert.equal(captured!.stdout.available, operation === 'stderr');
      assert.equal(captured!.stderr.available, false);
      assert.equal(captured!.stderr.status, 'capture-failed');
      assert(!JSON.stringify(captured!).includes('PRIVATE_BOOTSTRAP_CAUSE'));
      assert.equal(
        await readFile(captured!.diagnostics[0]!.path, 'utf8'),
        cause,
      );
      assert.equal(
        captured!.diagnostics[0]!.sha256,
        createHash('sha256').update(cause).digest('hex'),
      );
      assert.equal(await stat(stderrPath).catch(() => null), null);
      if (operation === 'stderr')
        assert.equal(await readFile(stdoutPath, 'utf8'), '');
      else assert.equal(await stat(stdoutPath).catch(() => null), null);
      await rm(root, { recursive: true, force: true });
    });
});

test('capture input validation rejects before operational bootstrap or private file creation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-capture-validation-')),
    path = join(root, 'stdout');
  const options = {
    program: process.execPath,
    args: [],
    cwd: root,
    stdoutPath: path,
    stderrPath: path,
    timeoutMs: 5000,
  };
  await assert.rejects(runProcessToFiles(options), /distinct files/);
  await assert.rejects(
    runProcessToFiles({
      ...options,
      stderrPath: join(root, 'stderr'),
      timeoutMs: 0,
    }),
    /timeout must be positive/,
  );
  assert.equal(await stat(path).catch(() => null), null);
  await rm(root, { recursive: true, force: true });
});
