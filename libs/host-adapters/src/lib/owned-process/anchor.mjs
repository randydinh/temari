import { spawn } from 'node:child_process';
// Stay alive across TERM so a live owned group leader pins the group until KILL.
process.on('SIGTERM', () => {});
process.on('SIGINT', () => {});
let launched = false;
process.on('message', (message) => {
  if (message.type !== 'launch' || launched) return;
  launched = true;
  const c = message.command;
  const worker = spawn(c.program, c.args, {
    cwd: c.cwd,
    env: c.env,
    shell: false,
    detached: false,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  worker.stdin.on('error', () => {});
  worker.stdin.end(c.input);
  worker.once('error', (error) =>
    process.send?.({
      type: 'result',
      code: null,
      signal: null,
      error: error.message,
    }),
  );
  worker.once('exit', (code, signal) =>
    process.send?.({ type: 'result', code, signal }),
  );
});
process.send?.({ type: 'ready' });
