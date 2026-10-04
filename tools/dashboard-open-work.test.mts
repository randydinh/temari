import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  createOpenWorkReader,
  validateOpenWorkManifest,
} from './dashboard-open-work.mjs';

function fixture() {
  return {
    schema: 1,
    id: 'capture-1',
    capturedAt: '2026-10-01T12:00:00.000Z',
    baseline: 'a'.repeat(40),
    coverage: {
      chatScope: 'Explicit sample',
      chatLimit: 50,
      allChats: false,
      worktreeScope: 'Explicit roots',
      unavailableHosts: ['other'],
      unavailableSources: [],
      gaps: ['Not live inventory'],
    },
    chats: [
      {
        id: 'thread-1',
        title: '<script>verbatim</script>',
        kind: 'codex',
        hostId: 'local',
        cwd: '/work',
        status: 'unknown',
        updatedAt: null,
        worktreeId: 'tree-1',
      },
    ],
    worktrees: [
      {
        id: 'tree-1',
        root: '/work',
        exists: true,
        head: null,
        branch: null,
        clean: null,
        unresolvedPathCount: null,
        untrackedPathCount: null,
        commitsNotInMain: null,
        preservation: 'unverified',
      },
    ],
    sourceRefs: [{ kind: 'host capture', sha256: 'b'.repeat(64) }],
  };
}
const digest = (data: string | Buffer) =>
  createHash('sha256').update(data).digest('hex');

function unavailableTitleFixture() {
  const value = fixture();
  return {
    ...value,
    chats: value.chats.map((chat) => ({ ...chat, title: null })),
  };
}

test('strict admission retains unknown observations and verbatim titles without creating links', () => {
  const value = validateOpenWorkManifest(fixture());
  assert.equal(value.chats[0]!.title, '<script>verbatim</script>');
  assert.equal(value.worktrees[0]!.commitsNotInMain, null);
  assert.equal(Object.hasOwn(value.chats[0]!, 'url'), false);
  const missing = fixture();
  missing.worktrees[0]!.exists = false;
  assert.doesNotThrow(() => validateOpenWorkManifest(missing));
});

test('explicit null retains exact chat identity and metadata; existing bounded titles remain verbatim', () => {
  const unknown = unavailableTitleFixture();
  const admitted = validateOpenWorkManifest(unknown);
  assert.equal(admitted, unknown);
  assert.equal(admitted.chats[0]!.title, null);
  assert.deepEqual(admitted.chats[0], {
    ...fixture().chats[0],
    title: null,
  });
  assert.deepEqual(admitted.coverage, fixture().coverage);
  assert.deepEqual(admitted.sourceRefs, fixture().sourceRefs);
  assert.equal(admitted.worktrees[0]!.preservation, 'unverified');

  const titled = fixture();
  titled.chats[0]!.title = 'x'.repeat(512);
  assert.equal(validateOpenWorkManifest(titled), titled);
  assert.equal(titled.chats[0]!.title, 'x'.repeat(512));
});

test('null titles must be explicit; missing, invalid and oversized titles remain inadmissible', () => {
  const missing: any = unavailableTitleFixture();
  delete missing.chats[0].title;
  assert.throws(() => validateOpenWorkManifest(missing));
  for (const title of [undefined, 1, true, {}, [], 'x'.repeat(513), 'bad\0title']) {
    const value: any = unavailableTitleFixture();
    value.chats[0].title = title;
    assert.throws(() => validateOpenWorkManifest(value));
  }
});

test('null titles do not relax identity, local association, coverage or preservation guards', () => {
  const mutations: ((m: any) => void)[] = [
    (m) => (m.chats[0].id = '../escape'),
    (m) => m.chats.push({ ...m.chats[0] }),
    (m) => (m.chats[0].kind = 'browser'),
    (m) => (m.chats[0].status = 'done'),
    (m) => (m.chats[0].titleReason = 'caller metadata'),
    (m) => (m.chats[0].worktreeId = 'missing'),
    (m) => (m.chats[0].hostId = 'remote'),
    (m) => (m.chats[0].cwd = '/different-root'),
    (m) => (m.worktrees[0].preservation = 'verified'),
    (m) => (m.coverage.allChats = true),
    (m) => (m.sourceRefs[0].path = '/secret'),
  ];
  for (const mutate of mutations) {
    const value = unavailableTitleFixture();
    mutate(value);
    assert.throws(() => validateOpenWorkManifest(value), Error, mutate.toString());
  }
});

test('rejects unknown fields, malformed values, unsafe links, duplicates and dangling associations', () => {
  const mutations: ((m: any) => void)[] = [
    (m) => (m.extra = true),
    (m) => (m.coverage.extra = true),
    (m) => (m.chats[0].summary = 'secret'),
    (m) => (m.worktrees[0].rawStatus = 'raw'),
    (m) => (m.sourceRefs[0].path = '/secret'),
    (m) => (m.sourceRefs[0].sha256 = 'bad'),
    (m) => (m.schema = 2),
    (m) => (m.id = '../escape'),
    (m) => (m.baseline = 'main'),
    (m) => (m.capturedAt = '2026-02-30T12:00:00Z'),
    (m) => (m.capturedAt = '2026-10-01T12:00:00+00:00'),
    (m) => (m.coverage.allChats = true),
    (m) => (m.coverage.chatLimit = 0),
    (m) => (m.coverage.chatLimit = 51),
    (m) => (m.coverage.chatScope = 'x'.repeat(2049)),
    (m) => (m.coverage.gaps = [2]),
    (m) => (m.chats[0].id = 'codex://threads/foo'),
    (m) => (m.chats[0].id = 'bad?query'),
    (m) => (m.chats[0].kind = 'browser'),
    (m) => (m.chats[0].title = 'x'.repeat(513)),
    (m) => (m.chats[0].cwd = 'relative'),
    (m) => (m.chats[0].updatedAt = -1),
    (m) => (m.chats[0].worktreeId = 'missing'),
    (m) => (m.chats[0].hostId = 'remote'),
    (m) => (m.chats[0].hostId = null),
    (m) => (m.chats[0].cwd = '/different-root'),
    (m) => (m.chats[0].status = 'done'),
    (m) => m.chats.push({ ...m.chats[0] }),
    (m) => m.worktrees.push({ ...m.worktrees[0], id: 'tree-2' }),
    (m) => m.worktrees.push({ ...m.worktrees[0], root: '/other' }),
    (m) => (m.worktrees[0].root = 'relative'),
    (m) => (m.worktrees[0].root = '/' + 'x'.repeat(4096)),
    (m) => (m.worktrees[0].preservation = 'verified'),
    (m) => (m.worktrees[0].clean = 'yes'),
    (m) => (m.worktrees[0].untrackedPathCount = 1.5),
    (m) => (m.worktrees[0].unresolvedPathCount = -1),
    (m) => {
      m.worktrees[0].exists = false;
      m.worktrees[0].head = 'c'.repeat(40);
    },
    (m) => {
      m.worktrees[0].clean = true;
      m.worktrees[0].unresolvedPathCount = 1;
      m.worktrees[0].untrackedPathCount = 0;
    },
    (m) => {
      m.worktrees[0].exists = false;
      m.worktrees[0].commitsNotInMain = 0;
    },
    (m) =>
      (m.chats = Array.from({ length: 1001 }, (_, i) => ({
        ...m.chats[0],
        id: `c${i}`,
      }))),
    (m) =>
      (m.worktrees = Array.from({ length: 201 }, (_, i) => ({
        ...m.worktrees[0],
        id: `w${i}`,
        root: `/w${i}`,
      }))),
    (m) => (m.sourceRefs = Array(33).fill(m.sourceRefs[0])),
    (m) => (m.coverage.gaps = Array(600).fill('x'.repeat(2048))),
  ];
  for (const mutate of mutations) {
    const value = fixture();
    mutate(value);
    assert.throws(
      () => validateOpenWorkManifest(value),
      Error,
      mutate.toString(),
    );
  }
});

test('configuration rejects relative paths and malformed digests before reading', () => {
  assert.throws(() =>
    createOpenWorkReader({ manifestPath: 'relative', sha256: 'a'.repeat(64) }),
  );
  assert.throws(() =>
    createOpenWorkReader({ manifestPath: '/capture', sha256: 'bad' }),
  );
});

test('a pinned null-title capture projects the exact ID and null without granting live or preservation claims', async (t) => {
  const root = await mkdtemp(join(process.cwd(), '.open-work-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = unavailableTitleFixture();
  const bytes = JSON.stringify(manifest);
  const manifestPath = join(root, 'capture.json');
  await writeFile(manifestPath, bytes);
  const reader = createOpenWorkReader({
    manifestPath,
    sha256: digest(bytes),
    now: () => Date.parse(manifest.capturedAt),
  });
  const result = await reader.describe();
  assert.equal(result.state, 'available');
  assert.deepEqual(result.chats, manifest.chats);
  assert.equal(result.chats[0]!.id, 'thread-1');
  assert.equal(result.chats[0]!.title, null);
  assert.equal(result.chats[0]!.worktreeId, 'tree-1');
  assert.deepEqual(result.sourceRefs, manifest.sourceRefs);
  assert.deepEqual(result.coverage, manifest.coverage);
  assert.equal(result.worktrees[0]!.preservation, 'unverified');
  assert.equal(result.readOnly, true);
  assert.equal(result.currentWriterState, 'not-checked');
  assert.equal(result.closureEligibility, 'not-assessed');

  await writeFile(manifestPath, bytes + '\n');
  const changed = await reader.describe();
  assert.equal(changed.state, 'unavailable');
  assert.deepEqual(changed.chats, []);
});

test('rereads exact bytes, assesses capture age, clears rows after change, corruption or removal', async (t) => {
  const root = await mkdtemp(join(process.cwd(), '.open-work-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = join(root, 'capture.json');
  const bytes = JSON.stringify(fixture());
  await writeFile(manifestPath, bytes);
  let now = Date.parse(fixture().capturedAt);
  const reader = createOpenWorkReader({
    manifestPath,
    sha256: digest(bytes),
    now: () => now,
  });
  for (const [age, freshness] of [
    [0, 'fresh'],
    [900000, 'fresh'],
    [900001, 'stale'],
    [-1, 'future'],
  ] as const) {
    now = Date.parse(fixture().capturedAt) + age;
    const result = await reader.describe();
    assert.equal(result.capture?.freshness, freshness);
    assert.equal(result.capture?.ageMs, age);
    assert.equal(result.currentWriterState, 'not-checked');
    assert.equal(result.closureEligibility, 'not-assessed');
  }
  for (const changed of [
    bytes + '\n',
    '{broken',
    JSON.stringify({ ...fixture(), chats: [] }),
  ]) {
    await writeFile(manifestPath, changed);
    const result = await reader.describe();
    assert.equal(result.state, 'unavailable');
    assert.deepEqual(result.chats, []);
    assert.equal(result.capture, null);
    assert.deepEqual(result.worktrees, []);
  }
  await writeFile(manifestPath, bytes);
  assert.equal((await reader.describe()).state, 'available');
  await rm(manifestPath);
  assert.equal((await reader.describe()).state, 'unavailable');
  await writeFile(join(root, 'other.json'), bytes);
  await symlink(join(root, 'other.json'), manifestPath);
  assert.equal((await reader.describe()).state, 'unavailable');
});

test('matching digest cannot admit corrupt, oversized, non-UTF8 or non-file captures', async (t) => {
  const root = await mkdtemp(join(process.cwd(), '.open-work-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = join(root, 'capture');
  for (const bytes of [
    Buffer.from('{bad'),
    Buffer.from(JSON.stringify({ ...fixture(), schema: 9 })),
    Buffer.alloc(1024 * 1024 + 1),
    Buffer.from([255]),
  ]) {
    await writeFile(manifestPath, bytes);
    assert.equal(
      (
        await createOpenWorkReader({
          manifestPath,
          sha256: digest(bytes),
        }).describe()
      ).state,
      'unavailable',
    );
  }
  assert.equal(
    (
      await createOpenWorkReader({
        manifestPath: root,
        sha256: 'a'.repeat(64),
      }).describe()
    ).state,
    'unavailable',
  );
});
