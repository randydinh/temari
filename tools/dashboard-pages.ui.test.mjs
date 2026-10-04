// Executes the shipped pages script with model-free DOM/transport fixtures.
// Real HTTP admission, headed-browser behavior and source/profile proof are separate.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [source, html] = await Promise.all([
  readFile(join(checkout, 'tools/dashboard-pages.js'), 'utf8'),
  readFile(join(checkout, 'tools/task-view.html'), 'utf8'),
]);

class UiEvent {
  constructor(type, options = {}) {
    Object.assign(this, { type, defaultPrevented: false }, options);
  }
  preventDefault() { this.defaultPrevented = true; }
}
class Surface {
  listeners = new Map();
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) ?? []) {
      const result = listener(event);
      if (result?.then) result.catch((error) => { this.listenerError = error; });
    }
    return !event.defaultPrevented;
  }
}
class Element extends Surface {
  constructor(tag, id = '') {
    super();
    Object.assign(this, { tagName: tag.toUpperCase(), id, childNodes: [], dataset: {},
      attributes: new Map(), hidden: false, disabled: false, open: false,
      value: '', className: '', ownText: '' });
    this.classList = {
      toggle: (name, force) => {
        const classes = new Set(this.className.split(/\s+/).filter(Boolean));
        const present = force ?? !classes.has(name);
        if (present) classes.add(name); else classes.delete(name);
        this.className = [...classes].join(' ');
        return present;
      },
    };
  }
  set textContent(value) { this.ownText = String(value); this.childNodes = []; }
  get textContent() { return this.ownText + this.childNodes.map((child) => child.textContent).join(''); }
  set innerHTML(_value) { throw new Error('Fixture metadata must stay plain text.'); }
  get firstChild() { return this.childNodes[0] ?? null; }
  append(...children) { this.childNodes.push(...children); }
  replaceChildren(...children) { this.ownText = ''; this.childNodes = children; }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  scrollIntoView(options) { this.lastScroll = options; }
}
const descendants = (element) => element.childNodes.flatMap((child) => [child, ...descendants(child)]);
const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status, json: async () => structuredClone(body),
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let index = 0; index < 120; index++) await Promise.resolve(); }

function harness(route) {
  const elements = new Map();
  for (const match of html.matchAll(/<([a-z][a-z0-9-]*)\b[^>]*\bid="([^"]+)"[^>]*>/gi)) {
    assert(!elements.has(match[2]), 'Duplicate fixture HTML identity: ' + match[2]);
    const node = new Element(match[1], match[2]);
    node.hidden = /\bhidden\b/.test(match[0]);
    node.disabled = /\bdisabled\b/.test(match[0]);
    elements.set(match[2], node);
  }
  const navigation = [...html.matchAll(/<button\b[^>]*\bdata-view="([^"]+)"[^>]*>/gi)]
    .map((match) => { const button = new Element('button'); button.dataset.view = match[1]; return button; });
  const document = new Surface(), window = new Surface();
  document.hidden = false;
  document.getElementById = (id) => {
    const node = elements.get(id) ?? [...elements.values()]
      .flatMap((element) => descendants(element)).find((element) => element.id === id);
    assert(node, 'Missing fixture DOM node: ' + id);
    return node;
  };
  document.querySelectorAll = (selector) => {
    assert.equal(selector, '[data-view]');
    return navigation;
  };
  document.createElement = (tag) => new Element(tag);
  document.createElementNS = (_namespace, tag) => new Element(tag);
  const get = (id) => document.getElementById(id);
  // These are the pages script's shared core rendering seams, not fake page flows.
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  };
  const section = (title, note) => {
    const node = el('div', 'section-heading');
    node.append(el('h3', '', title));
    if (note) node.append(el('span', 'section-note', note));
    return node;
  };
  const requests = [], timers = [];
  const location = { href: 'http://127.0.0.1:3102/?view=tasks' };
  const context = vm.createContext({
    document, window, location, URL, CustomEvent: UiEvent,
    history: { replaceState: (_state, _unused, url) => { location.href = String(url); } },
    byId: get, el, section, badge: (value) => el('span', 'badge', value),
    state: { dashboard: { mode: 'read-only' } },
    post: () => { throw new Error('This fixture admits no mutations.'); },
    crypto: { randomUUID: () => { throw new Error('No scheduling/mutation in pages tests.'); } },
    setInterval: (callback, milliseconds) => { timers.push({ callback, milliseconds }); return timers.length; },
    fetch: async (path, options = {}) => {
      assert.equal(options.method ?? 'GET', 'GET', 'Only fixture reads are admitted.');
      requests.push({ path, options });
      return route(path, requests.length);
    },
  });
  vm.runInContext(source, context, { filename: 'dashboard-pages.js' });
  const call = (name, ...args) => vm.runInContext(`${name}(${args.map((arg) => JSON.stringify(arg)).join(',')})`, context);
  const inspect = (expression) => vm.runInContext(expression, context);
  const click = (node) => { assert(node, 'Missing fixture action'); node.dispatchEvent(new UiEvent('click')); };
  return { get, call, inspect, click, requests, timers,
    async view(name) { click(navigation.find((button) => button.dataset.view === name)); await flush(); },
    input(id, value) { get(id).value = value; get(id).dispatchEvent(new UiEvent('input')); },
  };
}

function inventory(title) {
  return {
    schema: 1, state: 'available', baseline: 'b'.repeat(40),
    capture: { id: 'fixture-capture', sha256: 'c'.repeat(64), capturedAt: new Date().toISOString(),
      assessedAt: new Date().toISOString(), freshness: 'fresh' },
    coverage: { chatScope: 'bounded fixture', chatLimit: 50, worktreeScope: 'fixture local registry',
      unavailableHosts: [], unavailableSources: [], gaps: [] },
    chats: [{ id: 'chat-exact-id', kind: 'codex', title, hostId: 'local', status: 'idle',
      cwd: '/fixture/project', worktreeId: 'worktree-1', updatedAt: 1791068400 }],
    worktrees: [{ id: 'worktree-1', root: '/fixture/project', branch: 'codex/fixture',
      head: 'd'.repeat(40), exists: true, clean: true, unresolvedPathCount: 0,
      untrackedPathCount: 0, commitsNotInMain: 0 }],
    sourceRefs: [{ kind: 'chats', sha256: 'e'.repeat(64) }], gaps: [],
  };
}
const chatCards = (ui) => ui.get('open-work-chats').childNodes.filter((node) => node.dataset.openWorkChatId);
const worktreeCards = (ui) => ui.get('open-work-worktrees').childNodes.filter((node) => node.dataset.openWorkWorktreeId);

for (const title of ["  <img onerror='fixture'> Original & title  ", '']) {
  test(`captured string title remains verbatim (${title ? 'literal metadata' : 'empty string'})`, async () => {
    const ui = harness(async (path) => { assert.equal(path, '/api/open-work'); return response(inventory(title)); });
    await ui.view('open-work');
    const card = chatCards(ui)[0];
    assert.equal(card.childNodes[0].textContent, title);
    assert.equal(card.childNodes[0].firstChild.href, 'codex://threads/chat-exact-id');
    assert.doesNotMatch(card.textContent, /Unavailable in current capture|Untitled chat/);
    if (title) {
      ui.input('open-work-search', 'ORIGINAL & TITLE');
      assert.equal(chatCards(ui).length, 1);
      assert.equal(chatCards(ui)[0].childNodes[0].textContent, title);
    }
  });
}

test('null title uses exact chat identity and remains searchable and associated with its captured cwd', async () => {
  const ui = harness(async (path) => { assert.equal(path, '/api/open-work'); return response(inventory(null)); });
  await ui.view('open-work');
  let card = chatCards(ui)[0];
  assert.equal(card.dataset.openWorkChatId, 'chat-exact-id');
  assert.equal(card.childNodes[0].textContent, 'chat-exact-id');
  assert.match(card.textContent, /TitleUnavailable in current capture/);
  assert.match(card.textContent, /Chat workspace\/fixture\/project/);
  assert.doesNotMatch(card.textContent, /Untitled|Unknown chat/);
  for (const needle of ['CHAT-EXACT-ID', '/fixture/project']) {
    ui.input('open-work-search', needle);
    assert.equal(chatCards(ui).length, 1);
  }
  ui.input('open-work-search', '');
  card = chatCards(ui)[0];
  assert.match(worktreeCards(ui)[0].textContent, /chat-exact-id · title unavailable · Idle at capture/);
  ui.click(descendants(card).find((node) => node.tagName === 'BUTTON' && node.textContent === 'Show worktree'));
  assert.equal(ui.get('open-work-kind').value, 'worktrees');
  assert.equal(ui.get('open-work-search').value, '/fixture/project');
  assert.equal(worktreeCards(ui).length, 1);
  assert.equal(worktreeCards(ui)[0].dataset.openWorkWorktreeId, 'worktree-1');
  assert.equal(ui.get('open-work-worktrees').lastScroll.block, 'start');
});

function map(label = 'Retained document', id = 'document-old', extraDocuments = []) {
  const anchor = { source: { id: 'fixture-source', name: 'Fixture source' }, publicationId: 'fixture-publication',
    generation: 'fixture-generation', manifestSha256: 'a'.repeat(64), role: 'support', path: 'folder/document.md' };
  return { schema: 1, state: 'ready', nodes: [
    { id: 'source-1', kind: 'source', label: 'Fixture source', qualifiers: ['historical'], anchors: [anchor] },
    { id, kind: 'document', label, qualifiers: ['historical'], anchors: [anchor] }, ...extraDocuments,
  ], edges: [{ id: 'edge-1', source: 'source-1', target: id, kind: 'contains-document', anchors: [anchor], qualifiers: ['retained'] }],
  coverage: { documentsReturned: 1 + extraDocuments.length, documentsKnown: 1 + extraDocuments.length, truncated: false }, gaps: [] };
}
function detail(snapshot, id = 'document-old') {
  return { state: 'ready', node: snapshot.nodes.find((node) => node.id === id),
    edges: snapshot.edges, metadata: { provenance: 'recorded' }, gaps: [] };
}
async function populateKnowledge(ui, snapshot) {
  await ui.view('knowledge');
  ui.click(ui.get('knowledge-graph-view'));
  ui.click(ui.get('knowledge-drives').childNodes.find((node) => node.tagName === 'BUTTON' && node.textContent.includes('Fixture source')));
  await flush();
  await ui.call('selectKnowledgeNode', snapshot.nodes[1].id);
  assert.equal(ui.inspect('pages.selectedNode'), snapshot.nodes[1].id);
  assert.equal(ui.inspect('pages.selectedSource'), 'fixture-source');
  assert.match(ui.get('knowledge-detail').textContent, new RegExp(snapshot.nodes[1].label));
  assert(ui.get('knowledge-map').childNodes.length > 0, 'Fixture should have an actually rendered graph');
  assert(ui.get('knowledge-nodes').childNodes.length > 0, 'Fixture should have rendered node choices');
}
function assertUnavailableCleared(ui, label) {
  assert.equal(ui.inspect('pages.knowledge.state'), 'unavailable');
  assert.equal(ui.inspect('pages.knowledge.nodes.length'), 0);
  assert.equal(ui.inspect('pages.knowledge.edges.length'), 0);
  assert.equal(ui.inspect('pages.selectedNode'), null);
  assert.equal(ui.inspect('pages.selectedSource'), null);
  assert.equal(ui.get('knowledge-detail').childNodes.length, 0);
  assert.equal(ui.get('knowledge-map').childNodes.length, 0);
  assert.equal(ui.get('knowledge-nodes').childNodes.filter((node) => node.tagName === 'BUTTON').length, 0);
  assert.equal(ui.get('knowledge-nodes').hidden, true);
  assert.equal(ui.get('knowledge-source-browser').hidden, true);
  assert.match(ui.get('knowledge-status').textContent, /unavailable/);
  assert.match(ui.get('knowledge-empty').textContent, /needs attention/);
  for (const id of ['knowledge-tree', 'knowledge-map', 'knowledge-nodes', 'knowledge-drives', 'knowledge-detail'])
    assert(!ui.get(id).textContent.includes(label), 'Stale label survived in ' + id);
}

test('HTTP refresh failure clears old nodes, edges, detail and selections with a truthful unavailable state', async () => {
  const snapshot = map(); let refreshes = 0;
  const ui = harness(async (path) => {
    if (path === '/api/knowledge') return ++refreshes === 1 ? response(snapshot) : response({ error: 'Pinned publication unavailable.' }, 503);
    if (path === '/api/knowledge/node?node=source-1') return response(detail(snapshot, 'source-1'));
    assert.equal(path, '/api/knowledge/node?node=document-old'); return response(detail(snapshot));
  });
  await populateKnowledge(ui, snapshot);
  ui.click(ui.get('refresh-map')); await flush();
  assertUnavailableCleared(ui, 'Retained document');
  assert.equal(ui.get('error').hidden, false);
  assert.equal(ui.get('error').textContent, 'Pinned publication unavailable.');
});

test('successful refresh removing the selected node clears old detail without requesting that removed identity', async () => {
  const old = map(), current = map('Current document', 'document-current'); let refreshes = 0;
  const ui = harness(async (path) => {
    if (path === '/api/knowledge') return response(++refreshes === 1 ? old : current);
    if (path === '/api/knowledge/node?node=source-1') return response(detail(old, 'source-1'));
    assert.equal(path, '/api/knowledge/node?node=document-old'); return response(detail(old));
  });
  await populateKnowledge(ui, old);
  ui.click(ui.get('refresh-map')); await flush();
  assert.equal(ui.inspect('pages.selectedNode'), null);
  assert.equal(ui.get('knowledge-detail').childNodes.length, 0);
  assert.match(ui.get('knowledge-nodes').textContent, /Current document/);
  assert.doesNotMatch(ui.get('knowledge-nodes').textContent, /Retained document/);
  assert.equal(ui.requests.filter((request) => request.path === '/api/knowledge/node?node=document-old').length, 1);
});

test('failed new node lookup cannot retain the previous detail while the admitted map remains available', async () => {
  const snapshot = map('Retained document', 'document-old', [
    { id: 'document-second', kind: 'document', label: 'Second document', anchors: [], qualifiers: [] },
  ]);
  const ui = harness(async (path) => {
    if (path === '/api/knowledge') return response(snapshot);
    if (path === '/api/knowledge/node?node=source-1') return response(detail(snapshot, 'source-1'));
    if (path.endsWith('node=document-old')) return response(detail(snapshot));
    assert.equal(path, '/api/knowledge/node?node=document-second'); return response({ error: 'Selected record refused.' }, 404);
  });
  await populateKnowledge(ui, snapshot);
  ui.click(ui.get('knowledge-nodes').childNodes.find((node) => node.textContent.includes('Second document')));
  await flush();
  assert.equal(ui.get('knowledge-detail').childNodes.length, 0);
  assert.equal(ui.inspect('pages.knowledge.state'), 'ready');
  assert.equal(ui.inspect('pages.knowledge.nodes.length'), 3);
  assert.equal(ui.get('error').textContent, 'Selected record refused.');
});

test('failed expansion clears the whole old map and selected detail', async () => {
  const snapshot = map();
  const ui = harness(async (path) => {
    if (path === '/api/knowledge') return response(snapshot);
    if (path === '/api/knowledge/node?node=source-1') return response(detail(snapshot, 'source-1'));
    if (path === '/api/knowledge/node?node=document-old') return response(detail(snapshot));
    assert.equal(path, '/api/knowledge/expand?node=document-old'); throw new Error('Fixture connection interrupted.');
  });
  await populateKnowledge(ui, snapshot);
  ui.click(ui.get('knowledge-detail').childNodes.find((node) => node.tagName === 'BUTTON' && node.textContent === 'Expand connected records'));
  await flush();
  assertUnavailableCleared(ui, 'Retained document');
  assert.equal(ui.get('error').textContent, 'Fixture connection interrupted.');
});

test('an older refresh response cannot replace a newer accepted map', async () => {
  const older = deferred(), newer = deferred(); let refreshes = 0;
  const ui = harness(async (path) => {
    assert.equal(path, '/api/knowledge');
    return ++refreshes === 1 ? response(map()) : refreshes === 2 ? older.promise : newer.promise;
  });
  await ui.view('knowledge');
  const oldRequest = ui.call('loadKnowledge'), newRequest = ui.call('loadKnowledge');
  newer.resolve(response(map('Newest document', 'document-newest'))); await newRequest;
  older.resolve(response(map('Obsolete response', 'document-obsolete'))); await oldRequest;
  assert.equal(ui.inspect('pages.knowledge.nodes[1].id'), 'document-newest');
  assert.match(ui.get('knowledge-tree').textContent, /document.md/);
  ui.click(ui.get('knowledge-graph-view'));
  assert.match(ui.get('knowledge-nodes').textContent, /Newest document/);
  assert.doesNotMatch(ui.get('knowledge-nodes').textContent, /Obsolete response/);
});

test('an older refresh failure cannot clear a newer accepted map or display an obsolete error', async () => {
  const older = deferred(); let refreshes = 0;
  const ui = harness(async (path) => {
    assert.equal(path, '/api/knowledge');
    return ++refreshes === 1 ? response(map()) : refreshes === 2 ? older.promise : response(map('Newest document', 'document-newest'));
  });
  await ui.view('knowledge');
  const oldRequest = ui.call('loadKnowledge');
  await ui.call('loadKnowledge');
  older.resolve(response({ error: 'Obsolete failed request.' }, 503)); await oldRequest;
  assert.equal(ui.inspect('pages.knowledge.state'), 'ready');
  assert.equal(ui.inspect('pages.knowledge.nodes[1].id'), 'document-newest');
  assert.doesNotMatch(ui.get('error').textContent, /Obsolete failed request/);
});

test('a late node detail cannot resurrect a record removed by a newer refresh', async () => {
  const older = deferred(), old = map(); let refreshes = 0;
  const ui = harness(async (path) => {
    if (path === '/api/knowledge') return response(++refreshes === 1 ? old : map('Current document', 'document-current'));
    assert.equal(path, '/api/knowledge/node?node=document-old'); return older.promise;
  });
  await ui.view('knowledge');
  const oldDetail = ui.call('selectKnowledgeNode', 'document-old');
  await ui.call('loadKnowledge');
  older.resolve(response(detail(old))); await oldDetail;
  assert.equal(ui.inspect('pages.selectedNode'), null);
  assert.equal(ui.get('knowledge-detail').childNodes.length, 0);
  assert.equal(ui.inspect('pages.knowledge.nodes[1].id'), 'document-current');
});

test('out-of-order node details keep the latest deliberate selection', async () => {
  const older = deferred();
  const snapshot = map('First document', 'document-old', [
    { id: 'document-second', kind: 'document', label: 'Second document', anchors: [], qualifiers: [] },
  ]);
  const ui = harness(async (path) => {
    if (path === '/api/knowledge') return response(snapshot);
    if (path === '/api/knowledge/node?node=document-old') return older.promise;
    assert.equal(path, '/api/knowledge/node?node=document-second'); return response(detail(snapshot, 'document-second'));
  });
  await ui.view('knowledge');
  const oldDetail = ui.call('selectKnowledgeNode', 'document-old');
  await ui.call('selectKnowledgeNode', 'document-second');
  older.resolve(response(detail(snapshot))); await oldDetail;
  assert.equal(ui.inspect('pages.selectedNode'), 'document-second');
  assert.match(ui.get('knowledge-detail').textContent, /Second document/);
  assert.doesNotMatch(ui.get('knowledge-detail').textContent, /First document/);
});

test('a late expansion cannot restore records after a newer refresh', async () => {
  const older = deferred(), old = map(); let refreshes = 0;
  const ui = harness(async (path) => {
    if (path === '/api/knowledge') return response(++refreshes === 1 ? old : map('Newest document', 'document-newest'));
    if (path === '/api/knowledge/node?node=source-1') return response(detail(old, 'source-1'));
    if (path === '/api/knowledge/node?node=document-old') return response(detail(old));
    assert.equal(path, '/api/knowledge/expand?node=document-old'); return older.promise;
  });
  await populateKnowledge(ui, old);
  ui.click(ui.get('knowledge-detail').childNodes.find((node) => node.tagName === 'BUTTON' && node.textContent === 'Expand connected records'));
  await ui.call('loadKnowledge');
  older.resolve(response(map('Obsolete expansion', 'document-expanded'))); await flush();
  assert.equal(ui.inspect('pages.knowledge.nodes[1].id'), 'document-newest');
  assert.equal(ui.get('knowledge-detail').childNodes.length, 0);
  assert.doesNotMatch(ui.get('knowledge-nodes').textContent, /Obsolete expansion/);
});
