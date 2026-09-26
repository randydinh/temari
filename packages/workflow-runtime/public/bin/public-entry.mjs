import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const POLICY_BYTES = 64 * 1024;
const REQUEST_BYTES = 64 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });

async function readBoundedFile(path, limit) {
  const before = await lstat(path);
  assert(
    before.isFile() && !before.isSymbolicLink(),
    'Expected a regular file.',
  );
  assert(before.size <= limit, 'File exceeds the byte limit.');
  const file = await open(
    path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = await file.stat();
    assert(
      stat.isFile() &&
        stat.dev === before.dev &&
        stat.ino === before.ino &&
        stat.size === before.size &&
        stat.size <= limit,
      'File changed before reading.',
    );
    const bytes = Buffer.alloc(stat.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        used,
        bytes.length - used,
        null,
      );
      if (!bytesRead) break;
      used += bytesRead;
    }
    const after = await file.stat();
    assert(
      used === stat.size &&
        after.size === stat.size &&
        after.mtimeMs === stat.mtimeMs,
      'File changed while reading.',
    );
    return bytes.subarray(0, used);
  } finally {
    await file.close();
  }
}

async function readJson(path, limit) {
  assert(isAbsolute(path), 'Request path must be absolute.');
  return JSON.parse(utf8.decode(await readBoundedFile(path, limit)));
}

const policy = JSON.parse(
  utf8.decode(await readBoundedFile(join(root, 'policy.json'), POLICY_BYTES)),
);

function exactFields(value, required, optional = []) {
  assert(
    value && typeof value === 'object' && !Array.isArray(value),
    'Expected a JSON object.',
  );
  assert(
    required.every((key) => Object.hasOwn(value, key)) &&
      Object.keys(value).every(
        (key) => required.includes(key) || optional.includes(key),
      ),
    'Request has unknown or missing fields.',
  );
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function finish(value, code = 0) {
  print(value);
  process.exitCode = code;
}

function usage() {
  throw new Error(
    'Usage: node <temari|poteto-mode|closeout>.mjs policy | admit --request ABS_JSON | admit --run-directory ABS_PATH',
  );
}

function policyDescription(entry) {
  const selected = policy.entries[entry];
  return {
    schemaVersion: 1,
    entry,
    status: 'described',
    supportedRoute: selected.supportedRoute,
    supportedProfile: selected.supportedProfile,
    policyId: policy.policyId,
  };
}

function compareObligations(actual, expected) {
  return (
    Object.keys(expected).every((key) => actual?.[key] === expected[key]) &&
    Object.keys(actual ?? {}).every((key) => Object.hasOwn(expected, key))
  );
}

function admitEngineering(entry, request) {
  exactFields(request, [
    'schemaVersion',
    'entry',
    'route',
    'profile',
    'obligations',
  ]);
  const reasons = [];
  if (request.schemaVersion !== 1) reasons.push('unsupported-request-schema');
  if (request.entry !== entry) reasons.push('entry-mismatch');
  if (request.route !== 'full-playbook') reasons.push('route-not-admitted');
  if (request.profile !== 'feature-v1') reasons.push('profile-not-admitted');
  if (!compareObligations(request.obligations, policy.feature.obligations)) {
    reasons.push('obligations-not-admitted');
  }

  if (reasons.length > 0) {
    return {
      schemaVersion: 1,
      entry,
      status: 'rejected',
      reasons,
      policyId: policy.policyId,
    };
  }

  return {
    schemaVersion: 1,
    entry,
    status: 'blocked',
    route: request.route,
    profile: request.profile,
    reasons: ['host-capability-proof-missing'],
    missingCapabilities: policy.feature.requiredCapabilities,
    policyId: policy.policyId,
  };
}

export async function run(entry, argv = process.argv.slice(2)) {
  assert(
    Object.hasOwn(policy.entries, entry),
    `Unknown public entry: ${entry}`,
  );
  const [command, flag, argument, ...extra] = argv;
  if (command === 'policy' && argv.length === 1) {
    finish(policyDescription(entry));
    return;
  }
  if (command !== 'admit' || extra.length > 0 || argument === undefined)
    usage();

  if (entry === 'closeout') {
    if (flag !== '--run-directory' || !isAbsolute(argument)) usage();
    finish(
      {
        schemaVersion: 1,
        entry,
        status: 'blocked',
        reasons: [
          'trusted-invocation-and-current-candidate-selection-unimplemented',
        ],
        policyId: policy.policyId,
      },
      1,
    );
    return;
  }

  if (flag !== '--request') usage();
  const result = admitEngineering(
    entry,
    await readJson(argument, REQUEST_BYTES),
  );
  finish(result, 1);
}
