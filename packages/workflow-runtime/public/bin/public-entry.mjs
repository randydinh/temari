import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const policy = JSON.parse(await readFile(join(root, 'policy.json'), 'utf8'));

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

async function readJson(path) {
  assert(isAbsolute(path), 'Request path must be absolute.');
  return JSON.parse(await readFile(path, 'utf8'));
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
  const result = admitEngineering(entry, await readJson(argument));
  finish(result, 1);
}
