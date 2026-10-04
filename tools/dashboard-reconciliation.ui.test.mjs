// Model-free DOM fixtures. Actual HTTP admission/browser/source proof is separate.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [source, html] = await Promise.all([
  readFile(join(checkout, 'tools/dashboard-reconciliation.js'), 'utf8'),
  readFile(join(checkout, 'tools/task-view.html'), 'utf8'),
]);
class UiEvent {
  constructor(type, options = {}) {
    Object.assign(this, { type, button: 0, cancelable: false, defaultPrevented: false }, options);
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
}
class Surface {
  listeners = new Map();
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) ?? []) {
      const returned = listener(event);
      if (returned?.then) returned.catch((error) => { this.listenerError = error; });
    }
    return !event.defaultPrevented;
  }
}
class Element extends Surface {
  constructor(tag, id = '') {
    super(); this.tagName = tag.toUpperCase(); this.id = id;
    this.childNodes = []; this.dataset = {}; this.attributes = new Map();
    this.hidden = false; this.disabled = false; this.open = false; this.value = ''; this.ownText = '';
  }
  set textContent(value) { this.ownText = String(value); this.childNodes = []; }
  get textContent() { return this.ownText + this.childNodes.map((child) => child.textContent).join(''); }
  set innerHTML(_value) { throw new Error('Metadata must be rendered as plain text.'); }
  append(...children) { this.childNodes.push(...children); }
  replaceChildren(...children) { this.ownText = ''; this.childNodes = children; }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
}
const children = (element) => element.childNodes.flatMap((child) => [child, ...children(child)]);
const response = (data, status = 200) => ({
  ok: status >= 200 && status < 300, status, json: async () => structuredClone(data),
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let n = 0; n < 120; n++) await Promise.resolve(); }
const hash = 'a'.repeat(64), reviewHash = 'b'.repeat(64);
const capabilities = { canCheckCurrentBinding: true, canRecordConfirmationIntent: true };
function summary(id, extra = {}) {
  return {
    attemptId: id, retainedStatus: 'PENDING', state: 'awaiting-confirmation',
    classification: 'requires-confirmation', summary: 'Review retained work', summaryTruncated: false,
    taskId: 'task-1', runId: 'run-1', createdAt: '2026-10-03T21:00:00.000Z',
    updatedAt: '2026-10-03T21:01:00.000Z', blockedReason: null, confirmationRecorded: false,
    hostSelectedForReview: true, candidate: { id: 'candidate-1', sha256: hash, readiness: 'not-ready' },
    terminal: false, ...extra,
  };
}
function listing(attempts = [summary('attempt-a')], extra = {}) {
  return { configured: true, setupReason: null, attempts,
    page: { total: attempts.length, limit: 50, omitted: 0 }, capabilities, ...extra };
}
function ref(id) { return { schema: 1, id, sha256: hash, bytes: 3, mediaType: 'application/json' }; }
function payload(id) {
  return {
    schema: 1, attemptId: id,
    binding: { taskId: 'task-1', taskVersion: '3', runId: 'run-1', revision: 'revision-1',
      observationId: 'observation-1', candidateId: 'candidate-1', candidateSha256: hash, scopeSha256: hash },
    observation: { observationId: 'observation-1', observedAt: '2026-10-03T21:00:00.000Z',
      kind: 'mixed', evidence: [ref('observation-ref')] },
    plan: { planId: 'plan-1', classification: 'requires-confirmation', initialStatus: 'awaiting-confirmation',
      summary: 'Retain exact intent.', actions: [{ id: 'preserve-1', kind: 'preserve', targetId: 'task-1' }],
      request: { idempotencyKey: 'original-1', canonicalRequestDigestAlgorithm: 'canonical-json-sha256-v1',
        canonicalRequestSha256: hash }, evidence: [ref('plan-ref')] },
    scope: { schema: 1, sourceRoot: { id: 'source-root', sha256: hash },
      candidateRoot: { id: 'candidate-root', sha256: hash }, baseHead: { id: 'git-base-head-v1', sha256: hash },
      operationHead: { id: 'git-none', sha256: hash },
      affectedPaths: [{ path: 'tools/example.mts', pathSha256: hash, classification: 'tracked',
        indexBlobs: [{ stage: 0, mode: '100644', objectId: 'a'.repeat(40) }], unmergedStages: [],
        worktreeKind: 'file', worktreeSha256: hash, diffSha256: hash }],
      resolutionIntent: 'preserve', requiredChecks: [{ id: 'check-1', definitionSha256: hash }],
      expectedComparison: { candidateEvidence: ref('candidate-ref'), verificationEvidence: ref('verification-ref') } },
  };
}
function review(id = 'attempt-a', extra = {}) {
  return {
    schema: 1, attempt: summary(id), review: { complete: true, sha256: reviewHash, payload: payload(id), reasonCode: null },
    admission: { hostSelected: true, reasonCode: null },
    currentBinding: { state: 'not-checked', beganAt: null, endedAt: null, changedFields: [], reasonCode: null },
    confirmation: null, capabilities,
    effects: { mode: 'recorded-intent-only', sourceOperations: 'none', taskAcceptance: 'none', archiveOperations: 'none', terminal: false },
    ...extra,
  };
}
function saved(requestId, extra = {}) {
  return {
    confirmationId: 'confirmation-1', requestId, planId: 'plan-1', observationId: 'observation-1',
    canonicalRequestSha256: hash, confirmedAt: '2026-10-03T21:02:00.000Z',
    actorKind: 'local-dashboard-interaction', evidence: [ref('local-interaction-ref')], ...extra,
  };
}
function recorded(id, requestId) {
  return review(id, { attempt: summary(id, { retainedStatus: 'CONFIRMED', state: 'observed', confirmationRecorded: true }),
    confirmation: saved(requestId), capabilities: { ...capabilities, canRecordConfirmationIntent: false } });
}
async function harness(route) {
  const elements = new Map();
  for (const match of html.matchAll(/<([a-z][a-z0-9-]*)\b[^>]*\bid="([^"]+)"[^>]*>/gi)) {
    assert(!elements.has(match[2]), 'Duplicate HTML identity ' + match[2]);
    const element = new Element(match[1], match[2]);
    element.hidden = /\bhidden\b/.test(match[0]); element.disabled = /\bdisabled\b/.test(match[0]);
    elements.set(match[2], element);
  }
  const document = new Surface(), window = new Surface();
  document.getElementById = (id) => { assert(elements.has(id), 'Missing UI node ' + id); return elements.get(id); };
  document.createElement = (tag) => new Element(tag);
  const location = { href: 'http://127.0.0.1:3102/?view=open-work' };
  const requests = [], timers = new Map();
  let timerId = 0, requestId = 0;
  const context = vm.createContext({
    window, document, location, URL, AbortController, TextEncoder, CustomEvent: UiEvent,
    crypto: { randomUUID: () => 'fixture-request-' + (++requestId) },
    setTimeout: (callback, ms) => { const id = ++timerId; timers.set(id, { callback, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    // A fixture token is provided to this fixture transport, never a real API.
    fetch: async (path, options) => {
      const request = { path, method: options.method, headers: options.headers,
        body: options.body === undefined ? null : JSON.parse(options.body) };
      requests.push(request);
      if (path === '/api/dashboard') return response({ csrfToken: 'fixture-only-memory-token' });
      return route(request);
    },
  });
  vm.runInContext(source, context, { filename: 'dashboard-reconciliation.js' });
  const get = (id) => document.getElementById(id);
  const click = (element) => element.dispatchEvent(new UiEvent('click', { cancelable: true }));
  const lookup = (id) => {
    get('reconciliation-attempt-id').value = id;
    get('reconciliation-lookup-form').dispatchEvent(new UiEvent('submit', { cancelable: true }));
  };
  const open = () => { get('reconciliation-metadata').open = true; get('reconciliation-metadata').dispatchEvent(new UiEvent('toggle')); };
  const select = (id) => click(children(get('reconciliation-attempt-list')).find((item) => item.dataset.reconciliationAttemptId === id));
  const posts = () => requests.filter((item) => item.method === 'POST');
  return { get, click, lookup, open, select, requests, posts, window, timers,
    activate: () => window.TemariReconciliationUI.activate() };
}

test('unconfigured setup is truthful and admits no UI mutation', async () => {
  const ui = await harness(async () => response(listing([], {
    configured: false, setupReason: 'Host selection is not configured.', capabilities: {
      canCheckCurrentBinding: false, canRecordConfirmationIntent: false },
  })));
  await ui.activate(); await flush();
  assert.match(ui.get('reconciliation-status').textContent, /Host selection is not configured/);
  assert.equal(ui.get('reconciliation-lookup-button').disabled, true);
  ui.click(ui.get('reconciliation-confirm')); ui.click(ui.get('reconciliation-check')); await flush();
  assert.equal(ui.posts().length, 0);
});

test('retained omissions and exact older colon identity lookup use bounded query-free routes', async () => {
  const ui = await harness(async ({ path }) => {
    if (path === '/api/reconciliation') return response(listing([summary('attempt-a')], { page: { total: 8, limit: 50, omitted: 7 } }));
    assert.equal(path, '/api/reconciliation/older%3Aattempt/review');
    return response(review('older:attempt', { admission: { hostSelected: false, reasonCode: 'host-selection-required' },
      review: { complete: false, sha256: null, payload: null, reasonCode: 'host-selection-required' },
      capabilities: { ...capabilities, canRecordConfirmationIntent: false } }));
  });
  await ui.activate();
  assert.match(ui.get('reconciliation-coverage').textContent, /1 of 8.*7 older/);
  ui.lookup('older:attempt'); await flush();
  assert.equal(ui.get('reconciliation-selected-title').textContent, 'older:attempt');
  assert.equal(ui.get('reconciliation-confirm').disabled, true);
  assert.equal(ui.get('reconciliation-metadata').hidden, true);
  assert(ui.requests.every((item) => !item.path.includes('?')));
  ui.lookup('../outside'); await flush();
  assert.match(ui.get('reconciliation-lookup-error').textContent, /valid retained attempt ID/);
  assert.equal(ui.requests.length, 2);
});

test('recording requires a deliberate complete review and sends only exact intent pins', async () => {
  const ui = await harness(async ({ path, body }) => {
    if (path === '/api/reconciliation') return response(listing());
    if (path.endsWith('/review')) return response(review());
    assert.equal(path, '/api/reconciliation/attempt-a/confirm-reviewed');
    assert.deepEqual(body, { requestId: 'fixture-request-1', reviewSha256: reviewHash });
    return response({ schema: 1, requestId: body.requestId, outcome: 'recorded', reasonCode: null,
      review: recorded('attempt-a', body.requestId) });
  });
  await ui.activate(); ui.select('attempt-a'); await flush();
  assert.equal(ui.get('reconciliation-confirm').disabled, true);
  ui.click(ui.get('reconciliation-confirm')); await flush(); assert.equal(ui.posts().length, 0);
  ui.open(); assert.equal(ui.get('reconciliation-confirm').disabled, false);
  ui.click(ui.get('reconciliation-confirm')); ui.click(ui.get('reconciliation-confirm')); await flush();
  assert.equal(ui.posts().length, 1);
  assert.equal(ui.posts()[0].headers['x-temari-token'], 'fixture-only-memory-token');
  assert.match(ui.get('reconciliation-confirmation-status').textContent, /Historic confirmation intent recorded/);
  assert.match(ui.get('reconciliation-review-status').textContent, /candidate not ready/);
  assert.equal(ui.get('reconciliation-confirm').disabled, true);
});

test('a 200 blocked outcome is shown as blocked, never as recorded success', async () => {
  const blocked = review('attempt-a', { attempt: summary('attempt-a', { retainedStatus: 'BLOCKED', state: 'blocked',
    blockedReason: 'The candidate changed.' }), currentBinding: { state: 'drift', beganAt: '2026-10-03T21:02:00.000Z',
    endedAt: '2026-10-03T21:02:01.000Z', changedFields: ['candidateSha256', 'scopeSha256'], reasonCode: 'binding-drift' },
    capabilities: { ...capabilities, canRecordConfirmationIntent: false } });
  const ui = await harness(async ({ path, body }) => path === '/api/reconciliation' ? response(listing()) :
    path.endsWith('/review') ? response(review()) : response({
      schema: 1, requestId: body.requestId, outcome: 'blocked', reasonCode: 'binding-drift', review: blocked,
    }));
  await ui.activate(); ui.select('attempt-a'); await flush(); ui.open(); ui.click(ui.get('reconciliation-confirm')); await flush();
  assert.match(ui.get('reconciliation-mutation-status').textContent, /confirmation was blocked/);
  assert.match(ui.get('reconciliation-binding-status').textContent, /drift.*candidateSha256.*scopeSha256/);
  assert.match(ui.get('reconciliation-confirmation-status').textContent, /candidate changed/);
  assert.doesNotMatch(ui.get('reconciliation-mutation-status').textContent, /intent recorded/);
  assert.equal(ui.get('reconciliation-confirm').disabled, true);
});

test('historic confirmation and later permanent invalidation are both retained on screen', async () => {
  const detail = recorded('attempt-a', 'older-local-request');
  detail.attempt = summary('attempt-a', { retainedStatus: 'BLOCKED', state: 'blocked',
    blockedReason: 'A fresh observation is required.', confirmationRecorded: true });
  const ui = await harness(async ({ path }) => response(path === '/api/reconciliation' ? listing([detail.attempt]) : detail));
  await ui.activate(); ui.select('attempt-a'); await flush(); ui.open();
  assert.match(ui.get('reconciliation-confirmation-status').textContent, /fresh observation.*Historic confirmation intent recorded/);
  assert.equal(ui.get('reconciliation-confirm').disabled, true);
  assert.equal(ui.posts().length, 0);
});

test('lost confirmation ACK is recovered by exact saved request identity without another POST', async () => {
  let stored = review();
  const ui = await harness(async ({ path, body }) => {
    if (path === '/api/reconciliation') return response(listing());
    if (path.endsWith('/review')) return response(stored);
    stored = recorded('attempt-a', body.requestId);
    throw new Error('Fixture dropped the already-retained response.');
  });
  await ui.activate(); ui.select('attempt-a'); await flush(); ui.open(); ui.click(ui.get('reconciliation-confirm')); await flush();
  assert.equal(ui.posts().length, 1);
  assert.match(ui.get('reconciliation-mutation-status').textContent, /exact saved request is confirmed/);
  assert.equal(ui.get('reconciliation-retry').hidden, true);
  assert.equal(ui.get('reconciliation-review-error').hidden, true);
});

test('an unrelated saved confirmation cannot reconcile a lost response; deliberate retry reuses the exact body', async () => {
  let attempts = 0;
  const bodies = [];
  const unrelated = recorded('attempt-a', 'another-request');
  const ui = await harness(async ({ path, body }) => {
    if (path === '/api/reconciliation') return response(listing());
    if (path.endsWith('/review')) return response(attempts ? unrelated : review());
    bodies.push(body);
    if (++attempts === 1) throw new Error('Fixture drops a response with unknown retained effect.');
    return response({ schema: 1, requestId: body.requestId, outcome: 'refused', reasonCode: 'confirmation-already-recorded',
      review: unrelated });
  });
  await ui.activate(); ui.select('attempt-a'); await flush(); ui.open(); ui.click(ui.get('reconciliation-confirm')); await flush();
  assert.equal(ui.get('reconciliation-retry').hidden, false);
  assert.match(ui.get('reconciliation-mutation-status').textContent, /response was lost/);
  assert.equal(ui.posts().length, 1);
  ui.click(ui.get('reconciliation-retry')); await flush();
  assert.equal(ui.posts().length, 2); assert.deepEqual(bodies[0], bodies[1]);
  assert.deepEqual(Object.keys(bodies[1]).sort(), ['requestId', 'reviewSha256']);
  assert.match(ui.get('reconciliation-mutation-status').textContent, /refused/);
});

test('a malformed 200 confirmation DTO retains the exact request for deliberate retry', async () => {
  const bodies = [];
  const malformed = { schema: 1, attempt: { attemptId: 'attempt-a' }, review: { complete: true } };
  const ui = await harness(async ({ path, body }) => {
    if (path === '/api/reconciliation') return response(listing());
    if (path.endsWith('/review')) return response(bodies.length ? malformed : review());
    bodies.push(body);
    return response({ schema: 1, requestId: body.requestId, outcome: bodies.length === 1 ? 'recorded' : 'replayed',
      reasonCode: null, review: bodies.length === 1 ? malformed : recorded('attempt-a', body.requestId) });
  });
  await ui.activate(); ui.select('attempt-a'); await flush(); ui.open();
  ui.click(ui.get('reconciliation-confirm')); await flush();
  assert.equal(ui.posts().length, 1);
  assert.equal(ui.get('reconciliation-retry').hidden, false);
  assert.match(ui.get('reconciliation-mutation-status').textContent, /response was lost/);
  assert.equal(ui.get('reconciliation-confirm').disabled, true);
  ui.click(ui.get('reconciliation-retry')); await flush();
  assert.equal(ui.posts().length, 2);
  assert.deepEqual(bodies[0], bodies[1]);
  assert.deepEqual(Object.keys(bodies[1]).sort(), ['requestId', 'reviewSha256']);
  assert.match(ui.get('reconciliation-mutation-status').textContent, /exact saved request/);
  assert.equal(ui.get('reconciliation-retry').hidden, true);
});

test('current check is an explicit empty-body request and unavailable observation stays truthful', async () => {
  const unavailable = review('attempt-a', { currentBinding: { state: 'unavailable', beganAt: '2026-10-03T21:02:00.000Z',
    endedAt: '2026-10-03T21:02:01.000Z', changedFields: [], reasonCode: 'task-current-run-unavailable' } });
  const ui = await harness(async ({ path, body }) => {
    if (path === '/api/reconciliation') return response(listing());
    if (path.endsWith('/review')) return response(review());
    assert.equal(path, '/api/reconciliation/attempt-a/check-current-binding'); assert.deepEqual(body, {});
    return response(unavailable);
  });
  await ui.activate(); ui.select('attempt-a'); await flush();
  assert.equal(ui.posts().length, 0);
  ui.click(ui.get('reconciliation-check')); await flush();
  assert.match(ui.get('reconciliation-binding-status').textContent, /unavailable.*task current run unavailable/);
  assert.doesNotMatch(ui.get('reconciliation-binding-status').textContent, /Binding matched/);
  assert.equal(ui.posts().length, 1);
});

test('late reads do not replace the selected attempt or a newer mutation response', async () => {
  const oldA = deferred(), staleB = deferred();
  let readsB = 0;
  const ui = await harness(async ({ path }) => {
    if (path === '/api/reconciliation') return response(listing([summary('attempt-a'), summary('attempt-b')]));
    if (path === '/api/reconciliation/attempt-a/review') return oldA.promise;
    if (path === '/api/reconciliation/attempt-b/review') return ++readsB === 1 ? response(review('attempt-b')) : staleB.promise;
    return response(review('attempt-b', { currentBinding: { state: 'matched', beganAt: '2026-10-03T21:02:00.000Z',
      endedAt: '2026-10-03T21:02:01.000Z', changedFields: [], reasonCode: null } }));
  });
  await ui.activate(); ui.select('attempt-a'); ui.select('attempt-b'); await flush();
  oldA.resolve(response(review('attempt-a'))); await flush();
  assert.equal(ui.get('reconciliation-selected-title').textContent, 'attempt-b');
  ui.click(ui.get('reconciliation-check')); await flush();
  ui.click(ui.get('reconciliation-reload-review')); await flush();
  staleB.resolve(response(review('attempt-b'))); await flush();
  // The deliberate newer reload is allowed to return not-checked; no forever-current match.
  assert.match(ui.get('reconciliation-binding-status').textContent, /not checked by this read/);
  assert.equal(ui.get('reconciliation-selected-title').textContent, 'attempt-b');
});

test('an older pending GET cannot overwrite the binding-check result', async () => {
  const mutation = deferred(), olderRead = deferred();
  let reads = 0;
  const ui = await harness(async ({ path }) => {
    if (path === '/api/reconciliation') return response(listing());
    if (path.endsWith('/review')) return ++reads === 1 ? response(review()) : olderRead.promise;
    return mutation.promise;
  });
  await ui.activate(); ui.select('attempt-a'); await flush();
  ui.click(ui.get('reconciliation-check')); await flush();
  ui.click(ui.get('reconciliation-reload-review')); await flush();
  mutation.resolve(response(review('attempt-a', { currentBinding: { state: 'matched',
    beganAt: '2026-10-03T21:02:00.000Z', endedAt: '2026-10-03T21:02:01.000Z',
    changedFields: [], reasonCode: null } })));
  await flush();
  olderRead.resolve(response(review())); await flush();
  assert.match(ui.get('reconciliation-binding-status').textContent, /Binding matched/);
  assert.equal(ui.posts().length, 1);
});

test('refusal notices survive recovery reads; list failure clears stale controls and rows', async () => {
  let failList = false;
  const ui = await harness(async ({ path }) => {
    if (path === '/api/reconciliation') return failList ? response({ error: 'Retained store unavailable.' }, 503) : response(listing());
    if (path.endsWith('/review')) return response(review());
    return response({ error: 'Host refuses this selected intent.' }, 409);
  });
  await ui.activate(); ui.select('attempt-a'); await flush(); ui.open(); ui.click(ui.get('reconciliation-confirm')); await flush();
  assert.match(ui.get('reconciliation-review-error').textContent, /Host refuses/);
  assert.equal(ui.get('reconciliation-retry').hidden, true);
  failList = true; await ui.activate(); await flush();
  assert.match(ui.get('reconciliation-status').textContent, /Retained store unavailable/);
  assert.equal(children(ui.get('reconciliation-attempt-list')).filter((item) => item.dataset.reconciliationAttemptId).length, 0);
  assert.equal(ui.get('reconciliation-confirm').disabled, true);
  assert.equal(ui.get('reconciliation-check').disabled, true);
});

test('metadata is plain text and canonical task bridge preserves the current document', async () => {
  const detail = review();
  detail.review.payload.plan.summary = '<img src=x onerror=steal()> literal plan';
  detail.review.payload.scope.affectedPaths[0].path = 'literal/<b>path</b>.mts';
  const ui = await harness(async ({ path }) => response(path === '/api/reconciliation' ? listing() : detail));
  await ui.activate(); ui.select('attempt-a'); await flush(); ui.open();
  assert.match(ui.get('reconciliation-metadata-body').textContent, /<img src=x onerror=steal\(\)> literal plan/);
  assert.match(ui.get('reconciliation-metadata-body').textContent, /literal\/<b>path<\/b>.mts/);
  const link = children(ui.get('reconciliation-task-link')).find((item) => item.tagName === 'A');
  assert.equal(link.href, '/?view=tasks&task=task-1');
  let bridge;
  ui.window.addEventListener('temari-open-task', (event) => { bridge = event.detail; event.preventDefault(); });
  const clicked = new UiEvent('click', { cancelable: true }); link.dispatchEvent(clicked);
  assert.deepEqual({ ...bridge }, { taskId: 'task-1' }); assert.equal(clicked.defaultPrevented, true);
});

test('oversized or inconsistent complete reviews fail closed without partial approval', async () => {
  const detail = review();
  detail.review.payload.plan.summary = 'x'.repeat(65536);
  const ui = await harness(async ({ path }) => response(path === '/api/reconciliation' ? listing() : detail));
  await ui.activate(); ui.select('attempt-a'); await flush(); ui.open();
  assert.match(ui.get('reconciliation-review-error').textContent, /incomplete or too large/);
  assert.equal(ui.get('reconciliation-confirm').disabled, true);
  assert.equal(ui.get('reconciliation-metadata-body').textContent, '');
  assert.equal(ui.posts().length, 0);
});
