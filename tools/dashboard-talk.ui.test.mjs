// Focused DOM fixtures; live browser and protected transport checks are separate.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [source, html] = await Promise.all([
  readFile(join(checkout, 'tools/dashboard-talk.js'), 'utf8'),
  readFile(join(checkout, 'tools/task-view.html'), 'utf8'),
]);

class UiEvent {
  constructor(type, options = {}) {
    Object.assign(this, { type, button: 0, cancelable: false, defaultPrevented: false }, options);
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
}
class EventSurface {
  listeners = new Map();
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(callback);
  }
  dispatchEvent(event) {
    for (const callback of this.listeners.get(event.type) ?? []) {
      const result = callback(event);
      // Match DOM dispatch: a pending async listener does not block another click.
      if (result?.then) result.catch((error) => { this.listenerError = error; });
    }
    return !event.defaultPrevented;
  }
}
class Element extends EventSurface {
  constructor(tag, id = '') {
    super(); this.tagName = tag.toUpperCase(); this.id = id;
    this.dataset = {}; this.attributes = new Map(); this.childNodes = [];
    this.value = ''; this.disabled = false; this.hidden = false; this.open = false;
    this.scrollTop = 0; this.clientHeight = 300; this.ownText = '';
  }
  set textContent(value) { this.ownText = String(value); this.childNodes = []; }
  get textContent() { return this.ownText + this.childNodes.map((child) => child.textContent).join(''); }
  set innerHTML(_value) { throw new Error('HTML insertion is forbidden in the Talk text surface.'); }
  get options() { return this.childNodes.filter((child) => child.tagName === 'OPTION'); }
  get scrollHeight() { return Math.max(300, descendants(this).length * 40); }
  append(...children) { this.childNodes.push(...children); }
  replaceChildren(...children) { this.ownText = ''; this.childNodes = children; }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  querySelectorAll(selector) {
    assert.equal(selector, '[data-accept-proposal]');
    return descendants(this).filter((element) => Object.hasOwn(element.dataset, 'acceptProposal'));
  }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() {}
}
function descendants(element) {
  return element.childNodes.flatMap((child) => [child, ...descendants(child)]);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => structuredClone(data) };
}
const capabilities = { canCreateTopic: true, canSendTurn: true, canLinkTask: true };
function summary(id, extra = {}) {
  return { topicId: id, title: id, version: 1, updatedAt: '2026-10-03T15:00:00.000Z', unread: 0, attentionCount: 0, turnState: null, ...extra };
}
function turn(id, message, extra = {}) {
  return {
    turnId: id, requestId: id.replace(/^turn-/, ''), userMessage: message,
    assistantMessage: null, state: 'responded', reason: null,
    createdAt: '2026-10-03T15:00:00.000Z', updatedAt: '2026-10-03T15:00:01.000Z',
    proposedTask: null, ...extra,
  };
}
function detail(id, turns = [], extra = {}) {
  return {
    topic: { topicId: id, title: id, version: 1 }, turns,
    page: { total: turns.length, offset: 0, limit: 40, omittedBefore: 0, omittedAfter: 0, hasMore: false },
    linkedTasks: [], attention: [], ...extra,
  };
}
function listing(topics, attention = [], extra = {}) {
  return {
    configured: true, capabilities, topics, attention, setupReason: null,
    attentionPage: { total: attention.length, offset: 0, limit: 50, omittedBefore: 0, omittedAfter: 0, hasMore: false },
    ...extra,
  };
}
async function flush() { for (let index = 0; index < 100; index++) await Promise.resolve(); }
async function harness(route) {
  const elements = new Map();
  for (const match of html.matchAll(/<([a-z][a-z0-9-]*)\b[^>]*\bid="([^"]+)"[^>]*>/gi)) {
    assert(!elements.has(match[2]), `Duplicate HTML id ${match[2]}`);
    const element = new Element(match[1], match[2]);
    element.disabled = /\bdisabled\b/.test(match[0]);
    element.hidden = /\bhidden\b/.test(match[0]);
    elements.set(match[2], element);
  }
  const window = new EventSurface();
  const document = new EventSurface();
  document.hidden = false;
  document.getElementById = (id) => {
    assert(elements.has(id), `UI references missing HTML id ${id}`);
    return elements.get(id);
  };
  document.createElement = (tag) => new Element(tag);
  const location = { href: 'http://127.0.0.1:3102/' };
  const requests = [], timers = new Map();
  let timerId = 0, requestId = 0;
  const context = vm.createContext({
    window, document, location, URL, AbortController, CustomEvent: UiEvent,
    crypto: { randomUUID: () => `fixture-request-${++requestId}` },
    history: { replaceState: (_state, _title, url) => { location.href = new URL(url, location.href).href; } },
    setTimeout: (callback, ms) => { const id = ++timerId; timers.set(id, { callback, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    fetch: async (path, options) => {
      const request = { path, method: options.method, body: options.body ? JSON.parse(options.body) : null, headers: options.headers };
      requests.push(request);
      if (path === '/api/dashboard') return response({ csrfToken: 'fixture-session-token' });
      return route(request);
    },
  });
  vm.runInContext(source, context, { filename: 'dashboard-talk.js' });
  await flush();
  const get = (id) => document.getElementById(id);
  const click = (element) => element.dispatchEvent(new UiEvent('click', { cancelable: true }));
  const input = (value) => { get('talk-message').value = value; get('talk-message').dispatchEvent(new UiEvent('input')); };
  const topicButton = (id) => descendants(get('talk-topic-list')).find((element) => element.dataset.topicId === id);
  return {
    get, click, input, topicButton, requests, window, location, timers,
    activate: () => window.TemariTalkUI.activate(),
    submit: () => get('talk-composer').dispatchEvent(new UiEvent('submit', { cancelable: true })),
    async poll() {
      const selected = [...timers.entries()].find(([, timer]) => timer.ms === 3000 || timer.ms === 10000);
      assert(selected, 'Polling timer must be bounded and retained.');
      timers.delete(selected[0]); await selected[1].callback(); await flush();
    },
  };
}

test('late other-topic reads cannot replace selected history; drafts survive topic/task switching', async () => {
  const lateA = deferred(); let firstA = true;
  const tasks = [{ taskId: 'task-b', title: '<b>literal task</b>', status: 'OPEN', version: 1, currentRunId: null, goal: 'Review a goal', nextAction: null, available: true, omittedFields: [] }];
  const ui = await harness(async ({ path }) => {
    if (path === '/api/topics') return response(listing([summary('topic-a'), summary('topic-b')]));
    if (path.startsWith('/api/topics/topic-a?')) {
      if (firstA) { firstA = false; return lateA.promise; }
      return response(detail('topic-a', [turn('turn-a', 'A conversation')]));
    }
    if (path.startsWith('/api/topics/topic-b?')) return response(detail('topic-b', [turn('turn-b', 'B conversation')], { linkedTasks: tasks }));
    throw new Error(`Unexpected fixture read ${path}`);
  });
  ui.click(ui.topicButton('topic-a')); await flush();
  ui.click(ui.topicButton('topic-b')); await flush();
  assert.equal(ui.get('talk-topic-title').textContent, 'topic-b');
  lateA.resolve(response(detail('topic-a', [turn('turn-a', 'A late response')]))); await flush();
  assert.equal(ui.get('talk-topic-title').textContent, 'topic-b');
  assert.match(ui.get('talk-transcript').textContent, /B conversation/);
  assert.doesNotMatch(ui.get('talk-transcript').textContent, /A late response/);
  ui.input('B draft'); ui.click(ui.topicButton('topic-a')); await flush();
  ui.input('A draft'); ui.click(ui.topicButton('topic-b')); await flush();
  assert.equal(ui.get('talk-message').value, 'B draft');
  const link = descendants(ui.get('talk-linked-tasks')).find((element) => element.tagName === 'A');
  assert.match(link.href, /view=tasks&.*task=task-b/);
  assert.doesNotMatch(link.href, /topic=/);
  let linked;
  ui.window.addEventListener('temari-open-task', (event) => { linked = event.detail.taskId; event.preventDefault(); });
  assert.equal(ui.click(link), false, 'Handled task navigation must suppress document reload.');
  assert.equal(linked, 'task-b');
  assert.equal(ui.get('talk-message').value, 'B draft');
  assert.equal(ui.requests.filter((request) => request.method === 'POST').length, 0);
});

test('lost202 matches the exact retained request and never automatically resends', async () => {
  let saved = null;
  const ui = await harness(async ({ path, method, body }) => {
    if (path === '/api/topics') return response(listing([summary('topic-a', { turnState: saved ? 'queued' : null })]));
    if (method === 'POST') {
      assert.equal(path, '/api/topics/topic-a/turns');
      saved = turn(`turn-${body.requestId}`, body.text, { state: 'queued', requestId: body.requestId });
      throw new Error('Fixture connection ended after durable save.');
    }
    return response(detail('topic-a', saved ? [saved] : []));
  });
  await ui.activate(); ui.input('Save this message'); ui.submit(); await flush();
  assert.equal(ui.get('talk-message').value, '');
  assert.equal(ui.get('talk-retry').hidden, true);
  assert.equal(ui.get('talk-send').disabled, true);
  await ui.poll();
  assert.equal(ui.requests.filter((request) => request.method === 'POST').length, 1);
  assert.match(ui.get('talk-transcript').textContent, /Reply queued/);
});

test('explicit retry preserves the same body and does not erase a newer draft', async () => {
  let saved = null, posts = 0;
  const ui = await harness(async ({ path, method, body }) => {
    if (path === '/api/topics') return response(listing([summary('topic-a', { turnState: saved ? 'queued' : null })]));
    if (method === 'POST') {
      if (++posts === 1) throw new Error('Fixture refused to confirm saved state.');
      saved = turn(`turn-${body.requestId}`, body.text, { state: 'queued', requestId: body.requestId });
      return response({ topicId: 'topic-a', turnId: saved.turnId, topicVersion: 2, state: 'queued' }, 202);
    }
    return response(detail('topic-a', saved ? [saved] : []));
  });
  await ui.activate(); ui.input('Original body'); ui.submit(); await flush();
  assert.equal(ui.get('talk-retry').hidden, false);
  await ui.poll(); assert.equal(posts, 1, 'Background recovery is read-only.');
  ui.input('A newer draft'); ui.click(ui.get('talk-retry')); await flush();
  const sent = ui.requests.filter((request) => request.method === 'POST');
  assert.deepEqual(sent[1].body, sent[0].body);
  assert.equal(ui.get('talk-message').value, 'A newer draft');
  assert.equal(ui.get('talk-retry').hidden, true);
});

test('task proposal is explicit, safely rendered, and uses only the fixed accept route', async () => {
  const proposed = turn('turn-proposal', 'Suggest a task', {
    assistantMessage: 'Review this proposal first.',
    proposedTask: { proposalId: 'proposal-one', title: '<script>literal title</script>', goal: '<img>literal goal', state: 'offered', taskId: null },
  });
  const ui = await harness(async ({ path, method }) => {
    if (path === '/api/topics') return response(listing([summary('topic-a')]));
    if (method === 'POST') {
      assert.equal(path, '/api/topics/topic-a/proposals/turn-proposal/accept');
      proposed.proposedTask.state = 'linked'; proposed.proposedTask.taskId = 'task-proposal';
    }
    return response(detail('topic-a', [proposed]));
  });
  await ui.activate();
  assert.equal(ui.requests.filter((request) => request.method === 'POST').length, 0);
  assert.match(ui.get('talk-transcript').textContent, /<script>literal title<\/script>/);
  const accept = descendants(ui.get('talk-transcript')).find((element) => element.dataset.acceptProposal);
  assert.equal(accept.disabled, false);
  ui.click(accept); await flush();
  assert.equal(ui.requests.filter((request) => request.method === 'POST').length, 1);
  assert.match(ui.get('talk-transcript').textContent, /Goal saved and linked/);
  assert.match(ui.get('talk-transcript').textContent, /Task controls own planning and execution/);
});

test('attention total is counted once and omitted older topic items remain accessible', async () => {
  const item = (id, topicId = 'topic-a') => ({ attentionId: id, topicId, taskId: 'task-one', kind: 'update', summary: id, taskVersion: 1, runId: null, acknowledgedAt: null });
  const latest = [item('attention-new-a'), item('attention-new-b', 'topic-b')];
  const older = item('attention-old-a');
  const ui = await harness(async ({ path }) => path === '/api/topics'
    ? response(listing([summary('topic-a', { unread: 3 }), summary('topic-b', { unread: 1 })], latest, { attentionPage: { total: 4, offset: 0, limit: 50, omittedBefore: 0, omittedAfter: 2, hasMore: true } }))
    : response(detail('topic-a', [], { attention: [latest[0], older] })));
  ui.click(ui.topicButton('topic-a')); await flush();
  assert.equal(ui.get('talk-nav-count').textContent, '4', 'Unread summaries are not added to the same attention total.');
  assert.equal(ui.get('talk-attention-count').textContent, '4');
  const rows = descendants(ui.get('talk-attention-list')).filter((element) => element.dataset.attentionId);
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map((row) => row.dataset.attentionId)).size, rows.length);
  assert.match(ui.get('talk-attention-coverage').textContent, /2 of 4/);
  assert.match(ui.get('talk-attention-coverage').textContent, /2 older/);
  assert.match(ui.get('talk-attention-coverage').textContent, /adds 1 retained/);
});

test('lost attention acknowledgment is resolved by retained state without task mutation or replay', async () => {
  const attention = { attentionId: 'attention-one', topicId: 'topic-a', taskId: 'task-one', kind: 'needs-review', summary: 'Review the retained finding', taskVersion: 7, runId: 'run-one', acknowledgedAt: null };
  let posts = 0;
  const ui = await harness(async ({ path, method, body }) => {
    if (path === '/api/topics') return response(listing([summary('topic-a', { unread: attention.acknowledgedAt ? 0 : 1 })], attention.acknowledgedAt ? [] : [attention]));
    if (method === 'POST') {
      assert.equal(path, '/api/topics/topic-a/attention/attention-one/ack');
      assert.equal(body.expectedVersion, 1);
      posts++;
      attention.acknowledgedAt = '2026-10-03T15:00:02.000Z';
      throw new Error('Fixture lost acknowledgment response after saving.');
    }
    return response(detail('topic-a', [], { attention: [attention] }));
  });
  await ui.activate();
  const seen = descendants(ui.get('talk-attention-list')).find((element) => element.tagName === 'BUTTON' && element.textContent === 'Mark seen');
  ui.click(seen); await flush();
  assert.equal(ui.get('talk-attention-count').textContent, '0');
  assert.equal(ui.get('talk-retry').hidden, true);
  await ui.poll();
  assert.equal(posts, 1);
  assert.equal(ui.requests.some((request) => request.method === 'POST' && request.path.startsWith('/api/tasks')), false);
});

test('create accepts the retained {topic:record} DTO then reads fresh detail', async () => {
  let created = false;
  const ui = await harness(async ({ path, method, body }) => {
    if (method === 'POST') {
      assert.equal(path, '/api/topics'); assert.equal(body.title, 'A new topic');
      created = true;
      return response({ topic: { topicId: 'topic-new', title: body.title, version: 1, linkedTasks: [], turns: [], attention: [] } });
    }
    if (path === '/api/topics') return response(listing(created ? [summary('topic-new', { title: 'A new topic' })] : []));
    return response(detail('topic-new', [], { topic: { topicId: 'topic-new', title: 'A new topic', version: 1 } }));
  });
  ui.click(ui.get('talk-new-topic')); ui.get('talk-topic-name').value = 'A new topic';
  ui.get('talk-topic-form').dispatchEvent(new UiEvent('submit', { cancelable: true })); await flush();
  assert.equal(ui.get('talk-topic-dialog').open, false);
  assert.equal(ui.get('talk-topic-title').textContent, 'A new topic');
  assert.equal(ui.get('talk-topic-error').hidden, true);
  assert.equal(ui.requests.filter((request) => request.method === 'POST').length, 1);
});

test('a version refusal remains visible after recovery reads and keeps the draft', async () => {
  const ui = await harness(async ({ path, method }) => {
    if (path === '/api/topics') return response(listing([summary('topic-a')]));
    if (method === 'POST') return response({ error: 'The topic version changed; reload before retrying.' }, 409);
    return response(detail('topic-a'));
  });
  await ui.activate(); ui.input('Keep this draft'); ui.submit(); await flush();
  assert.equal(ui.get('talk-message').value, 'Keep this draft');
  assert.equal(ui.get('talk-error').hidden, false);
  assert.match(ui.get('talk-error').textContent, /version changed/);
  await ui.poll(); assert.match(ui.get('talk-error').textContent, /version changed/);
  ui.click(ui.get('talk-refresh-topic')); await flush();
  assert.equal(ui.get('talk-error').hidden, true);
  assert.equal(ui.requests.filter((request) => request.method === 'POST').length, 1);
});

test('byte-bounded histories below40 still expose earlier/later navigation and the newest turn', async () => {
  const all = Array.from({ length: 17 }, (_, index) => turn(`turn-${index}`, `Message ${index}`));
  const ui = await harness(async ({ path }) => {
    if (path === '/api/topics') return response(listing([summary('topic-a')]));
    const offset = Number(new URL(path, 'http://fixture.invalid').searchParams.get('offset'));
    const selected = all.slice(offset, offset + 8);
    return response(detail('topic-a', selected, { page: { total: 17, offset, limit: 40, omittedBefore: offset, omittedAfter: 17 - offset - selected.length, hasMore: offset + selected.length < 17 } }));
  });
  await ui.activate();
  assert.match(ui.get('talk-transcript').textContent, /Message 16/);
  assert.equal(ui.get('talk-pagination').hidden, false);
  ui.click(ui.get('talk-earlier')); await flush();
  assert.match(ui.get('talk-transcript').textContent, /Message 0/);
  assert.equal(ui.get('talk-later').disabled, false);
  ui.click(ui.get('talk-later')); await flush();
  assert.match(ui.get('talk-transcript').textContent, /Message 8/);
  ui.click(ui.get('talk-later')); await flush();
  assert.match(ui.get('talk-transcript').textContent, /Message 16/);
  assert.equal(ui.requests.filter((request) => request.method === 'POST').length, 0);
});

test('linked cards expose goal, unavailable reason and shortening; missing transport has a setup notice', async () => {
  const ui = await harness(async ({ path }) => path === '/api/topics'
    ? response(listing([summary('topic-a')], [], { capabilities: { ...capabilities, canSendTurn: false }, setupReason: 'Select a host model before sending.' }))
    : response(detail('topic-a', [], { linkedTasks: [{ taskId: 'task-one', title: 'Unavailable task', status: 'UNKNOWN', version: null, currentRunId: null, goal: 'Retain this goal', nextAction: null, available: false, reason: 'Workspace could not be verified.', omittedFields: ['goal'] }] })));
  await ui.activate();
  assert.equal(ui.get('talk-setup').hidden, false);
  assert.match(ui.get('talk-setup').textContent, /Select a host model/);
  assert.match(ui.get('talk-linked-tasks').textContent, /Retain this goal/);
  assert.match(ui.get('talk-linked-tasks').textContent, /Workspace could not be verified/);
  assert.match(ui.get('talk-linked-tasks').textContent, /Shortened fields: goal/);
  assert.equal(ui.get('talk-send').disabled, true);
});
