import { fork } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
let command,
  identity,
  anchor,
  witness,
  result = { code: null, signal: null };
let stopping = false,
  launched = false,
  reason = 'normal-exit';
let timer, launchTimer;
const graceMs = 150,
  settleMs = 1500;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function groupExists() {
  try {
    process.kill(-anchor.pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}
async function finish(why) {
  if (stopping) return;
  if (!identity) {
    process.exit(1);
    return;
  }
  stopping = true;
  reason = why;
  clearTimeout(timer);
  clearTimeout(launchTimer);
  // Only signal our still-live direct anchor handle/group, never a recovered PID.
  let cleanup = 'UNCERTAIN';
  if (anchor && anchor.exitCode === null && anchor.signalCode === null) {
    try {
      process.kill(-anchor.pid, 'SIGTERM');
    } catch {}
    await delay(graceMs);
    if (anchor.exitCode === null && anchor.signalCode === null) {
      try {
        process.kill(-anchor.pid, 'SIGKILL');
      } catch {}
    }
    const deadline = Date.now() + settleMs;
    while (Date.now() < deadline && groupExists()) await delay(20);
    cleanup = groupExists() ? 'UNCERTAIN' : 'CONFIRMED';
  }
  const receipt = {
    identity,
    witness,
    ...result,
    reason,
    cleanup,
    cleanupScope: 'owned-posix-process-group',
    termGraceMs: graceMs,
    observationMs: settleMs,
    observedAt: new Date().toISOString(),
  };
  try {
    writeFileSync(identity.receiptPath, JSON.stringify(receipt) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  } catch {
    receipt.cleanup = 'UNCERTAIN';
  }
  process.send?.({ type: 'finished', receipt }, () =>
    process.exit(receipt.cleanup === 'CONFIRMED' ? 0 : 1),
  );
  if (!process.connected) process.exit(receipt.cleanup === 'CONFIRMED' ? 0 : 1);
}
process.on('disconnect', () => void finish('controller-lost'));
process.on('SIGTERM', () => void finish('guardian-cancelled'));
process.on('message', (message) => {
  if (message.type === 'prepare' && !anchor) {
    ({ command, identity } = message);
    anchor = fork(fileURLToPath(new URL('./anchor.mjs', import.meta.url)), [], {
      detached: true,
      execArgv: [],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    witness = { guardianPid: process.pid, anchorPid: anchor.pid };
    launchTimer = setTimeout(() => void finish('launch-gate-expired'), 5000);
    anchor.on('message', (msg) => {
      if (msg.type === 'ready' && !stopping && process.connected)
        process.send?.({ type: 'prepared', witness }, (error) => {
          if (error) void finish('controller-lost');
        });
      if (msg.type === 'result') {
        result = { code: msg.code, signal: msg.signal, error: msg.error };
        void finish('normal-exit');
      }
    });
    anchor.on('error', () => void finish('anchor-failed'));
    anchor.on('exit', () => {
      if (!stopping) void finish('anchor-lost');
    });
  } else if (message.type === 'go' && anchor && !stopping && !launched) {
    launched = true;
    clearTimeout(launchTimer);
    timer = setTimeout(() => void finish('timeout'), command.timeoutMs);
    anchor.send({ type: 'launch', command });
  } else if (message.type === 'cancel')
    void finish(message.reason ?? 'cancelled');
});
