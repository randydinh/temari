import { createCodexModelDriver } from '../libs/host-adapters/src/lib/codex-model-driver.ts';

const executable = process.argv[2];
if (!executable || process.argv.length !== 3) {
  console.error('Usage: privacy-preflight.mjs /absolute/path/to/codex');
  process.exitCode = 2;
} else {
  let credentialRequests = 0;
  try {
    const driver = createCodexModelDriver({
      executable,
      model: 'preflight-only',
      reasoning: 'high',
      timeoutMs: 15000,
      credential: async () => {
        credentialRequests++;
        throw new Error('Preflight must not resolve credentials.');
      },
    });
    const result = await driver.preflight();
    console.log(
      JSON.stringify({ status: 'passed', ...result, credentialRequests }),
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        status: 'refused',
        reason: error instanceof Error ? error.message : 'Preflight failed.',
        credentialRequests,
      }),
    );
    process.exitCode = 1;
  }
}
