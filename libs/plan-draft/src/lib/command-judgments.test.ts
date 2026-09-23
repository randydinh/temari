import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmod,
  lstat,
  readFile,
  readdir,
  rename,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { assessFixture } from '../../../knowledge/src/support/fixtures.js';
import {
  createCommandJudgments,
  createConversationPlanDraft,
  type CommandJudgmentConfiguration,
  type CommandJudgmentRole,
  type DraftReviewInput,
  type JudgmentRole,
} from '../index.js';
import {
  commandConfiguration,
  commandEvents,
} from '../support/command-fixtures.js';
import {
  conversationFixture,
  proposeFixture,
} from '../support/conversation-fixtures.js';
import { fixture } from '../support/fixtures.js';
import { canonical, issuesFor, renderDraft, sha256 } from './data.js';

function change(
  config: CommandJudgmentConfiguration,
  role: JudgmentRole,
  updates: Partial<CommandJudgmentRole>,
): CommandJudgmentConfiguration {
  return {
    ...config,
    roles: { ...config.roles, [role]: { ...config.roles[role], ...updates } },
  };
}

function blocked(outcome: unknown, reason?: RegExp) {
  assert(outcome !== null && typeof outcome === 'object' && 'kind' in outcome);
  const result =
    outcome.kind === 'draft' && 'draft' in outcome
      ? outcome.draft
      : 'result' in outcome
        ? outcome.result
        : null;
  assert(
    result !== null &&
      typeof result === 'object' &&
      'status' in result &&
      'summary' in result,
  );
  assert(typeof result.summary === 'string');
  assert.equal(result.status, 'BLOCKED', result.summary);
  if (reason) assert.match(result.summary, reason);
  assert.doesNotMatch(result.summary, /sensitive-output|sensitive-error/);
}

function passed(outcome: unknown) {
  assert(outcome !== null && typeof outcome === 'object' && 'kind' in outcome);
  assert(outcome.kind === 'draft');
  assert('investigation' in outcome && 'draft' in outcome);
  const { investigation, draft } = outcome;
  assert(
    investigation !== null &&
      typeof investigation === 'object' &&
      'status' in investigation,
  );
  assert(
    draft !== null &&
      typeof draft === 'object' &&
      'status' in draft &&
      'summary' in draft,
  );
  assert(typeof draft.summary === 'string');
  assert.equal(investigation.status, 'ISSUES');
  assert.equal(draft.status, 'PASS', draft.summary);
}

async function inputs() {
  const f = await fixture();
  const { input, checkpoint } = f;
  const issues = issuesFor(checkpoint);
  const markdown = renderDraft(input.title, input.proposal, checkpoint, issues);
  const review: DraftReviewInput = {
    task: input.task,
    brief: input.brief,
    request: input.request,
    investigationResult: input.investigationResult,
    destination: input.destination,
    proposal: input.proposal,
    writer: input.writer,
    reviewer: { id: input.reviewer.id, revision: input.reviewer.revision },
    authority: {
      schema: 1,
      operation: 'create-local-plan-draft',
      taskId: input.task.id,
      taskDirectory: input.task.directory,
      destination: input.destination,
      taskEvidence: true,
    },
    checkpoint,
    issues,
    candidate: { markdown, sha256: sha256(markdown) },
  };
  return {
    ...f,
    assess: {
      brief: {
        ...input.brief,
        context: `${input.brief.context}\n${checkpoint.suppliedContext}`,
      },
      checkpoint,
      checkpointPath: input.investigationResult.evidencePaths[1],
    },
    propose: {
      brief: input.brief,
      request: input.request,
      investigationResult: input.investigationResult,
      checkpoint,
    },
    review,
  };
}

test('real command judgments publish exactly the reviewed candidate and retain untrusted inputs', async () => {
  const f = await conversationFixture();
  const config = await commandConfiguration(f.intent.task.directory);
  const judgments = createCommandJudgments(config);
  await judgments.checkReady(['review']);
  assert.deepEqual(await commandEvents(f.intent.task.directory), []);
  passed(
    await createConversationPlanDraft(
      { kind: 'start', intent: f.intent },
      { provider: f.provider, ...judgments },
    ),
  );
  const events = await commandEvents(f.intent.task.directory);
  assert.deepEqual(
    events.map((e) => e.request.role),
    ['assess', 'propose', 'review'],
  );
  assert.equal(new Set(events.map((e) => e.pid)).size, 3);
  for (const event of events) {
    const { __CF_USER_TEXT_ENCODING, ...environment } = event.environment;
    if (__CF_USER_TEXT_ENCODING !== undefined) {
      assert.equal(process.platform, 'darwin');
      assert.match(__CF_USER_TEXT_ENCODING, /^0x[0-9A-Fa-f]+:0x0:0x0$/);
    }
    assert.deepEqual(environment, { FIXTURE_DECLARED: 'nonsecret' });
    assert.equal(event.cwd, f.intent.task.directory);
    assert.deepEqual(event.args, ['literal $(touch never) ; *']);
    const { requestId, requestDigest, ...covered } = event.request;
    assert.match(requestId, /^[a-f0-9-]{36}$/);
    assert.equal(requestDigest, sha256(canonical(covered)));
    assert.deepEqual(Object.keys(covered).sort(), [
      'bindingRevision',
      'executionPolicy',
      'instructions',
      'limits',
      'responseShape',
      'role',
      'service',
      'trusted',
      'untrusted',
      'version',
    ]);
    assert.deepEqual(covered.service, {
      id: 'synthetic-local',
      configurationRevision: 'fixture-v1',
    });
    assert.deepEqual(covered.executionPolicy, {
      attempts: 1,
      tools: false,
      context: 'fresh',
      responseRepair: false,
    });
    assert.deepEqual(covered.trusted.brief, f.intent.brief);
    assert.deepEqual(covered.trusted.request, f.intent.request);
    assert.doesNotMatch(covered.instructions, /execute evil/);
    assert.match(JSON.stringify(covered.untrusted), /execute evil/);
    assert.equal(covered.limits.inputBytes, 32 * 1024 * 1024);
    assert.equal(covered.limits.resultBytes, 256 * 1024);
  }
  assert.match(events[0].request.untrusted.brief.context, /execute evil/);
  assert.equal(
    events[0].request.trusted.brief.context,
    'Trusted coordinator instructions.',
  );
  const review = events[2].request.untrusted;
  assert.deepEqual(events[2].request.trusted.authority, review.authority);
  assert.equal(
    await readFile(f.intent.destination, 'utf8'),
    review.candidate.markdown,
  );
  assert.equal(
    sha256(await readFile(f.intent.destination)),
    review.candidate.sha256,
  );
  assert.notEqual(judgments.writer.id, judgments.reviewer.id);
  assert.match(review.candidate.markdown, /D1 open/);
  assert.match(review.candidate.markdown, /What is still unknown/);
});

test('construction snapshots stable configuration without I/O and binds every execution choice', async () => {
  const f = await inputs();
  const config = await commandConfiguration(f.input.task.directory);
  const original = createCommandJudgments(config);
  const reordered = structuredClone(
    change(config, 'assess', {
      artifacts: Object.fromEntries(
        Object.entries(config.roles.assess.artifacts).reverse(),
      ),
    }),
  );
  assert.equal(
    createCommandJudgments(reordered).assessor.revision,
    original.assessor.revision,
  );
  for (const update of [
    { behaviorRevision: 'v2' },
    { service: { id: 'replacement', configurationRevision: 'fixture-v1' } },
    { service: { id: 'synthetic-local', configurationRevision: 'v2' } },
    { timeoutMs: 4999 },
    { environment: {} },
    { args: [...config.roles.assess.args, 'changed'] },
    { cwd: '/missing-directory' },
    {
      artifacts: {
        ...config.roles.assess.artifacts,
        '/missing-asset': '0'.repeat(64),
      },
    },
  ]) {
    const changed = createCommandJudgments(change(config, 'assess', update));
    assert.notEqual(changed.assessor.revision, original.assessor.revision);
    assert.equal(changed.reviewer.revision, original.reviewer.revision);
  }
  Object.assign(config.roles.assess.service, {
    configurationRevision: 'mutated',
  });
  assert.equal(
    original.assessor.revision,
    createCommandJudgments(reordered).assessor.revision,
  );
  assert.deepEqual(
    await original.assessor.assess(f.assess),
    assessFixture(f.checkpoint),
  );
  assert.deepEqual(
    (await commandEvents(f.input.task.directory))[0].request.service,
    { id: 'synthetic-local', configurationRevision: 'fixture-v1' },
  );
  await rename(
    config.roles.review.args[0],
    join(f.input.task.directory, 'unavailable.mjs'),
  );
  const reconstructed = createCommandJudgments(reordered);
  assert.equal(reconstructed.reviewer.revision, original.reviewer.revision);
  await assert.rejects(
    reconstructed.checkReady(['review']),
    /unavailable or changed artifacts/,
  );
});

test('invalid configuration fails before file access', async () => {
  const f = await conversationFixture();
  const config = await commandConfiguration(f.intent.task.directory);
  for (const update of [
    { executable: 'node' },
    { cwd: '/a/../b' },
    { artifacts: {} },
    { timeoutMs: 0 },
    { timeoutMs: 300001 },
    { timeoutMs: 1.5 },
    { args: ['nul\0'] },
    { environment: { 'BAD=KEY': 'value' } },
    { artifacts: { [config.roles.assess.executable]: 'wrong' } },
    { service: { id: '', configurationRevision: 'v1' } },
  ])
    assert.throws(
      () => createCommandJudgments(change(config, 'assess', update)),
      /invalid configuration/,
    );
});

test('readiness touches only requested roles and unavailable required roles block before retrieval', async () => {
  const f = await conversationFixture();
  let config = await commandConfiguration(f.intent.task.directory);
  config = change(config, 'assess', {
    executable: '/unavailable-executable',
    artifacts: { '/unavailable-executable': '0'.repeat(64) },
  });
  const judgments = createCommandJudgments(config);
  await judgments.checkReady(['review', 'propose']);
  let reads = 0;
  const provider = {
    ...f.provider,
    read: async (r: Parameters<typeof f.provider.read>[0]) => {
      reads++;
      return f.provider.read(r);
    },
  };
  blocked(
    await createConversationPlanDraft(
      { kind: 'start', intent: f.intent },
      { provider, ...judgments },
    ),
    /unavailable or changed artifacts/,
  );
  assert.equal(reads, 0);
  assert.deepEqual(await commandEvents(f.intent.task.directory), []);
  assert.equal(await lstat(f.intent.destination).catch(() => null), null);
  assert(
    !(await readdir(f.intent.task.directory)).some((name) =>
      name.endsWith('-started.json'),
    ),
  );
});

test('each invocation rechecks artifacts after readiness', async () => {
  const f = await inputs();
  const config = await commandConfiguration(f.input.task.directory);
  const judgments = createCommandJudgments(config);
  await judgments.checkReady(['propose']);
  await writeFile(config.roles.propose.args[0], 'changed wrapper');
  await assert.rejects(
    judgments.writer.propose(f.propose),
    /unavailable or changed artifacts/,
  );
  assert.deepEqual(await commandEvents(f.input.task.directory), []);
});

test('explicit parsers return complete domain results from real processes', async () => {
  const f = await inputs();
  const judgments = createCommandJudgments(
    await commandConfiguration(f.input.task.directory),
  );
  assert.deepEqual(
    await judgments.assessor.assess(f.assess),
    assessFixture(f.checkpoint),
  );
  assert.deepEqual(
    await judgments.writer.propose(f.propose),
    await proposeFixture(f.propose),
  );
  const review = await judgments.reviewer.review(f.review);
  assert.equal(review.candidateSha256, f.review.candidate.sha256);
  assert.equal(review.verdict, 'approve');
  assert.deepEqual(
    review.criteria.map((c) => c.criterion),
    f.input.brief.acceptanceCriteria,
  );
  const events = await commandEvents(f.input.task.directory);
  assert.deepEqual(events[0].request.untrusted, f.assess);
  assert.deepEqual(events[1].request.untrusted, f.propose);
  assert.deepEqual(events[2].request.untrusted, f.review);
});

test('parent environment and Node coverage forwarding do not enter the command', async () => {
  const f = await inputs();
  const configuration = await commandConfiguration(f.input.task.directory);
  const names = [
    'TEMARI_TEST_PARENT_ONLY',
    'NODE_V8_COVERAGE',
    '__CF_USER_TEXT_ENCODING',
  ];
  const original = names.map((name) => process.env[name]);
  try {
    process.env['TEMARI_TEST_PARENT_ONLY'] = 'synthetic-not-a-credential';
    process.env['NODE_V8_COVERAGE'] = join(
      f.input.task.directory,
      'forbidden-coverage',
    );
    process.env['__CF_USER_TEXT_ENCODING'] = 'synthetic-parent-value';
    assert.deepEqual(
      await createCommandJudgments(configuration).writer.propose(f.propose),
      await proposeFixture(f.propose),
    );
    const [event] = await commandEvents(f.input.task.directory);
    assert.equal(event.environment.TEMARI_TEST_PARENT_ONLY, undefined);
    assert.equal(event.environment.NODE_V8_COVERAGE, undefined);
    assert.notEqual(
      event.environment.__CF_USER_TEXT_ENCODING,
      'synthetic-parent-value',
    );
    assert.equal(
      await lstat(join(f.input.task.directory, 'forbidden-coverage')).catch(
        () => null,
      ),
      null,
    );
  } finally {
    names.forEach((name, i) => {
      if (original[i] === undefined) delete process.env[name];
      else process.env[name] = original[i];
    });
  }
});

test('malformed envelopes and complete role shapes fail closed', async (t) => {
  const f = await inputs();
  for (const mode of [
    'wrong-version',
    'wrong-role',
    'wrong-revision',
    'wrong-id',
    'wrong-digest',
    'wrong-service',
    'uncertain',
    'extra-envelope',
    'missing-envelope',
    'null-result',
    'malformed',
    'utf8',
    'duplicate-response',
    'extra-result',
    'missing-result-field',
    'string-boolean',
    'wrong-hash',
    'result-limit',
  ]) {
    await t.test(mode, async () => {
      const judgments = createCommandJudgments(
        await commandConfiguration(f.input.task.directory, { review: mode }),
      );
      await assert.rejects(
        judgments.reviewer.review(f.review),
        /^Error: Command judgment review: invalid response \([a-f0-9-]{36}\)$/,
      );
    });
  }
  for (const mode of ['wrong-basis', 'missing-action-field']) {
    const judgments = createCommandJudgments(
      await commandConfiguration(f.input.task.directory, { assess: mode }),
    );
    await assert.rejects(
      judgments.assessor.assess(f.assess),
      /invalid response/,
    );
  }
  for (const mode of ['empty-section', 'missing-verification']) {
    const judgments = createCommandJudgments(
      await commandConfiguration(f.input.task.directory, { propose: mode }),
    );
    await assert.rejects(
      judgments.writer.propose(f.propose),
      /invalid response/,
    );
  }
});

test('existing semantic admission rejects syntactically valid but inadmissible judgments', async (t) => {
  const cases: readonly [JudgmentRole, string][] = [
    ['assess', 'bad-assessment-citation'],
    ['assess', 'missing-question'],
    ['propose', 'bad-citation'],
    ['review', 'wrong-hash'],
    ['review', 'missing-criterion'],
    ['review', 'duplicate-criterion'],
    ['review', 'missing-issue'],
    ['review', 'resolved-question'],
    ['review', 'unsatisfied'],
    ['review', 'blocking'],
    ['review', 'reject'],
  ];
  for (const [role, mode] of cases) {
    await t.test(mode, async () => {
      const f = await conversationFixture();
      const config = await commandConfiguration(f.intent.task.directory, {
        [role]: mode,
      });
      blocked(
        await createConversationPlanDraft(
          { kind: 'start', intent: f.intent },
          { provider: f.provider, ...createCommandJudgments(config) },
        ),
      );
      assert.equal(await lstat(f.intent.destination).catch(() => null), null);
    });
  }
});

test(
  'process failures settle within timeout plus bounded termination even with inherited pipes',
  { timeout: 15000 },
  async (t) => {
    const f = await inputs();
    for (const [mode, category] of [
      ['stdout-limit', 'stdout limit'],
      ['stderr-limit', 'stderr limit'],
      ['nonzero', 'unsuccessful exit'],
      ['hang', 'timeout'],
      ['descendant', 'timeout'],
      ['late', 'timeout'],
      ['no-read', 'timeout'],
      ['close-stdin', 'stdin failure'],
    ]) {
      await t.test(mode, async () => {
        let config = await commandConfiguration(f.input.task.directory, {
          propose: mode,
        });
        config = change(config, 'propose', { timeoutMs: 400 });
        const judgments = createCommandJudgments(config);
        const start = Date.now();
        const input = ['no-read', 'close-stdin'].includes(mode)
          ? {
              ...f.propose,
              brief: { ...f.propose.brief, context: 'x'.repeat(1024 * 1024) },
            }
          : f.propose;
        await assert.rejects(
          judgments.writer.propose(input),
          new RegExp(category),
        );
        assert(
          Date.now() - start < 4000,
          'Failure must settle without waiting for inherited pipe closure',
        );
      });
    }
  },
);

test('launch errors and oversized or hash-mismatched inputs never yield a judgment', async () => {
  const f = await inputs();
  let config = await commandConfiguration(f.input.task.directory);
  const judgments = createCommandJudgments(config);
  await assert.rejects(
    judgments.writer.propose({
      ...f.propose,
      brief: { ...f.input.brief, context: 'x'.repeat(17 * 1024 * 1024) },
    }),
    /invalid or oversized input/,
  );
  await assert.rejects(
    judgments.reviewer.review({
      ...f.review,
      candidate: { ...f.review.candidate, markdown: 'changed' },
    }),
    /invalid or oversized input/,
  );
  assert.deepEqual(await commandEvents(f.input.task.directory), []);
  const executable = join(f.input.task.directory, 'missing-interpreter');
  const body = '#!/no/such/interpreter\n';
  await writeFile(executable, body);
  await chmod(executable, 0o700);
  config = change(config, 'propose', {
    executable,
    artifacts: { [executable]: sha256(body) },
  });
  await assert.rejects(
    createCommandJudgments(config).writer.propose(f.propose),
    /launch failure/,
  );
});

const conversationChild = fileURLToPath(
  new URL('../support/command-conversation-child.ts', import.meta.url),
);
async function runChild(mode: string, manifest: string): Promise<unknown> {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--import',
      '@swc-node/register/esm-register',
      conversationChild,
      mode,
      manifest,
    ],
    { timeout: 15000 },
  );
  return JSON.parse(stdout);
}

test('fresh recovery publishes saved preparation without available commands or readiness', async () => {
  const f = await conversationFixture();
  const configuration = await commandConfiguration(f.intent.task.directory);
  const manifest = join(f.intent.task.directory, 'command-manifest.json');
  await writeFile(
    manifest,
    JSON.stringify({
      intent: f.intent,
      contents: [...f.contents],
      configuration,
    }),
  );
  await assert.rejects(
    runChild('prepared-crash', manifest),
    (error: unknown) =>
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 73,
  );
  assert(
    (await readdir(f.intent.task.directory)).some((name) =>
      name.endsWith('-prepared.json'),
    ),
  );
  assert.equal(await lstat(f.intent.destination).catch(() => null), null);
  const before = await commandEvents(f.intent.task.directory);
  assert.deepEqual(
    before.map((e) => e.request.role),
    ['assess', 'propose', 'review'],
  );
  await rename(
    configuration.roles.review.args[0],
    join(f.intent.task.directory, 'removed-wrapper.mjs'),
  );
  passed(await runChild('resume', manifest));
  assert.equal(
    await readFile(f.intent.destination, 'utf8'),
    before[2].request.untrusted.candidate.markdown,
  );
  passed(await runChild('resume', manifest));
  assert.deepEqual(await commandEvents(f.intent.task.directory), before);
});

test('ambiguous command failure is not repeated and changed service cannot resume the operation', async () => {
  const f = await conversationFixture();
  const configuration = await commandConfiguration(f.intent.task.directory, {
    review: 'nonzero',
  });
  const deps = {
    provider: f.provider,
    ...createCommandJudgments(configuration),
  };
  blocked(
    await createConversationPlanDraft(
      { kind: 'start', intent: f.intent },
      deps,
    ),
    /unsuccessful exit/,
  );
  const before = await commandEvents(f.intent.task.directory);
  const manifest = join(f.intent.task.directory, 'command-manifest.json');
  await writeFile(
    manifest,
    JSON.stringify({
      intent: f.intent,
      contents: [...f.contents],
      configuration,
    }),
  );
  blocked(await runChild('resume', manifest), /may be unsaved or rejected/);
  assert.deepEqual(await commandEvents(f.intent.task.directory), before);
  const changed = change(configuration, 'review', {
    service: { id: 'replacement', configurationRevision: 'v2' },
  });
  blocked(
    await createConversationPlanDraft(
      {
        kind: 'resume',
        task: f.intent.task,
        destination: f.intent.destination,
      },
      { provider: f.provider, ...createCommandJudgments(changed) },
    ),
    /identit|binding|configuration/i,
  );
  assert.equal(await lstat(f.intent.destination).catch(() => null), null);
  assert.deepEqual(await commandEvents(f.intent.task.directory), before);
});
