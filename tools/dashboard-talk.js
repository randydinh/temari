// Topic state and the mutation token stay in memory; the host owns all execution.
(() => {
  'use strict';
  const node = (id) => document.getElementById(id);
  const LIMIT = 40;
  const drafts = new Map();
  const pending = new Map();
  const mutationErrors = new Map();
  const taskActions = new Set();
  const uncertainTaskActions = new Map();
  const bindings = new Map();
  const state = {
    configured: null, capabilities: {}, topics: [], attention: [], attentionPage: null, selected: null,
    detail: null, fresh: false, active: false, token: null, offset: null,
    detailRequest: 0, listLoading: null, fingerprint: null, timer: null,
    create: null, linkTopic: null, listError: '', notice: '',
    scopeMode: null, workspaces: [], topicPage: null,
  };
  const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
  const version = (value) => Number.isSafeInteger(value) && value >= 0;
  const text = (value) => typeof value === 'string' ? value : '';
  const human = (value) => text(value).replaceAll('_', ' ').replaceAll('-', ' ');
  const activeTurn = (value) => ['queued', 'running'].includes(text(value).toLowerCase());
  const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : value === true ? 1 : 0;
  const validTaskController = (task) => task.controller == null || (
    ['planning', 'implementation'].includes(task.controller?.phase) &&
    typeof task.controller.state === 'string' && task.controller.state.length <= 64 &&
    (task.controller.message === null || typeof task.controller.message === 'string') &&
    (task.controller.action === null || (
      ['prepare-plan', 'implementation-start'].includes(task.controller.action?.action) &&
      typeof task.controller.action.label === 'string' && Number.isSafeInteger(task.version) && task.version >= 1 &&
      (task.controller.action.proposalSha256 === undefined || /^[a-f0-9]{64}$/u.test(task.controller.action.proposalSha256))
    ))
  );
  const registry = () => state.scopeMode === 'workspace-registry';
  const workspaceKey = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/u.test(value);
  const opaqueIdentity = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256 && !value.includes('\0');
  const bindingPin = (binding) => JSON.stringify([binding.workspaceKey, binding.workspaceId, binding.taskStoreId]);
  function admitBinding(topic) {
    const binding = topic?.binding;
    if (!workspaceKey(binding?.workspaceKey) || !opaqueIdentity(binding.workspaceId) || !opaqueIdentity(binding.taskStoreId) ||
      typeof binding.available !== 'boolean' || !(binding.reason === null || typeof binding.reason === 'string'))
      throw failed('This topic workspace binding is unavailable. Reload before making changes.');
    if (bindings.has(topic.topicId) && bindings.get(topic.topicId) !== bindingPin(binding))
      throw failed('This topic workspace binding changed. Existing topics cannot be retargeted; your draft has been kept.');
    return binding;
  }
  const selectedBinding = () => state.detail?.topic.binding ?? state.topics.find((topic) => topic.topicId === state.selected)?.binding;
  const workspaceFor = (binding) => state.workspaces.find((entry) => entry.workspaceKey === binding?.workspaceKey && entry.workspaceId === binding?.workspaceId);
  const topicCapabilities = () => registry() ? state.detail?.capabilities ?? {} : state.capabilities;
  const bindingAvailable = (binding) => binding?.available === true && workspaceFor(binding)?.available === true;
  function bindingDescription(binding) {
    const workspace = workspaceFor(binding);
    return `Workspace: ${text(workspace?.label) || 'Label unavailable'} · fixed for this topic${bindingAvailable(binding) ? '' : ` · unavailable: ${text(binding?.reason) || text(workspace?.reason) || 'The host could not verify this workspace.'}`}`;
  }
  function renderWorkspaceSelector() {
    const field = node('talk-topic-workspace-field'), select = node('talk-topic-workspace');
    field.hidden = !registry();
    select.required = registry();
    const selected = state.create?.body.workspaceKey ?? select.value;
    const placeholder = make('option', '', 'Choose a workspace');
    placeholder.value = '';
    select.replaceChildren(placeholder);
    if (registry()) for (const workspace of state.workspaces) {
      const option = make('option', '', `${workspace.label} · ${workspace.topicCount} topic${workspace.topicCount === 1 ? '' : 's'}${workspace.available ? '' : ' · unavailable'}`);
      option.value = workspace.workspaceKey;
      option.disabled = !workspace.available;
      select.append(option);
    }
    select.value = state.workspaces.some((entry) => entry.workspaceKey === selected) ? selected : '';
    select.disabled = !registry() || Boolean(state.create);
    const workspace = state.workspaces.find((entry) => entry.workspaceKey === selected);
    node('talk-topic-workspace-help').textContent = workspace && !workspace.available
      ? `${text(workspace.reason) || 'This workspace is unavailable.'} Choose an available workspace before creating a new topic.`
      : state.create?.state === 'uncertain'
        ? 'The original workspace, title and request ID are retained for an explicit identical retry.'
        : 'Choose explicitly for this new topic. Its workspace stays fixed; creating a topic does not start task execution.';
    return workspace?.available === true;
  }
  const stamp = (value) => {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? '' : date.toLocaleString();
  };
  const make = (tag, className = '', value = '') => {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = value;
    return element;
  };
  function empty(target, heading, description) {
    const box = make('div', 'talk-empty');
    box.append(make('h3', '', heading), make('p', '', description));
    target.replaceChildren(box);
  }
  function error(message, id = 'talk-error') {
    node(id).textContent = message;
    node(id).hidden = !message;
  }
  function failed(message, status = 0, uncertain = false) {
    return Object.assign(new Error(message), { status, uncertain });
  }
  async function request(path, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(path, {
        method: body ? 'POST' : 'GET', cache: 'no-store', signal: controller.signal,
        headers: body ? { 'content-type': 'application/json', 'x-temari-token': state.token } : {},
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      let result;
      try { result = await response.json(); }
      catch { throw failed('The server response could not be read. Reload to check saved state.', response.status, Boolean(body)); }
      if (!response.ok) {
        if (response.status === 403) state.token = null;
        throw failed(text(result.error) || 'The request was refused.', response.status, Boolean(body) && response.status >= 500);
      }
      return result;
    } catch (cause) {
      if ('uncertain' in cause) throw cause;
      throw failed(cause.name === 'AbortError' ? 'The request timed out. Reload to check saved state.' : 'The server could not be reached. Reload to check saved state.', 0, Boolean(body));
    } finally { clearTimeout(timeout); }
  }
  async function token() {
    if (state.token) return;
    const dashboard = await request('/api/dashboard');
    if (typeof dashboard.csrfToken !== 'string' || !dashboard.csrfToken)
      throw failed('Talk changes are not admitted by the current dashboard setup.');
    state.token = dashboard.csrfToken;
  }
  function topicPath(id) {
    if (!validId(id)) throw failed('The topic identity is unavailable.');
    return `/api/topics/${encodeURIComponent(id)}`;
  }
  function taskLink(taskId, label = 'Open task') {
    if (!validId(taskId)) return make('span', 'event-detail', 'Task link unavailable');
    const link = make('a', '', label);
    const url = new URL(location.href);
    url.searchParams.set('view', 'tasks');
    url.searchParams.set('task', taskId);
    url.searchParams.delete('topic');
    link.href = `${url.pathname}${url.search}`;
    link.addEventListener('click', (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const handled = !window.dispatchEvent(new CustomEvent('temari-open-task', {
        detail: { taskId }, cancelable: true,
      }));
      if (handled) event.preventDefault();
    });
    return link;
  }
  function saveDraft() {
    if (state.selected) drafts.set(state.selected, node('talk-message').value);
  }
  function clearSubmittedDraft(operation) {
    if (drafts.get(operation.topicId) === operation.body.text) drafts.set(operation.topicId, '');
    if (state.selected === operation.topicId && node('talk-message').value === operation.body.text)
      node('talk-message').value = '';
  }
  function turnLabel(turn) {
    switch (text(turn.state).toLowerCase()) {
      case 'queued': return 'Reply queued';
      case 'running': return 'Temari is responding';
      case 'responded': return 'Reply saved';
      case 'blocked': return 'Reply blocked';
      case 'uncertain': return 'Reply uncertain — no automatic replay';
      default: return `Turn state: ${human(turn.state) || 'unknown'}`;
    }
  }
  function renderControls() {
    const operation = pending.get(state.selected);
    const busy = state.detail?.turns?.some((turn) => activeTurn(turn.state)) ||
      activeTurn(state.topics.find((topic) => topic.topicId === state.selected)?.turnState);
    const writable = Boolean(state.configured && state.fresh && state.detail && version(state.detail.topic.version) &&
      (!registry() || bindingAvailable(selectedBinding())));
    const capabilities = topicCapabilities();
    node('talk-new-topic').disabled = !state.configured || !state.capabilities.canCreateTopic || state.create?.state === 'submitting';
    node('talk-message').disabled = !state.configured || !state.selected;
    node('talk-send').disabled = !writable || !capabilities.canSendTurn || busy || Boolean(operation) || !node('talk-message').value.trim();
    node('talk-link-task').disabled = !writable || !capabilities.canLinkTask || busy || Boolean(operation);
    node('talk-refresh-topic').disabled = !state.selected || !state.configured;
    node('talk-retry').hidden = operation?.state !== 'uncertain';
    const retryCapability = operation?.kind === 'turn' ? capabilities.canSendTurn : operation?.kind === 'link' ? capabilities.canLinkTask :
      operation?.kind === 'proposal' ? capabilities.canAcceptProposal : capabilities.canAcknowledge;
    node('talk-retry').disabled = !state.configured || (registry() && (!bindingAvailable(selectedBinding()) || !retryCapability));
    node('talk-retry').textContent = operation?.kind === 'turn' ? 'Retry the same message' : 'Retry the same request';
    const last = state.detail?.turns?.at(-1);
    node('talk-turn-status').textContent = operation?.state === 'preparing' ? 'Reading the current topic version…' :
      operation?.state === 'submitting' ? 'Saving your request…' :
      operation?.state === 'uncertain' ? 'The response was lost. Saved state is being checked; nothing is automatically resent.' :
      operation?.state === 'retained' ? 'The request was retained. Reloading its saved state…' :
      state.notice || (last ? turnLabel(last) : '');
    node('talk-composer-help').textContent = !state.selected ? 'Choose a topic to start. Ctrl/⌘ + Enter sends.' :
      registry() && !bindingAvailable(selectedBinding()) ? 'This workspace is unavailable. Your draft stays with this topic; an existing topic cannot be retargeted.' :
      !state.fresh ? 'Reload this topic before sending. Your draft stays here.' :
      busy ? 'This topic has a reply in progress. You can write a draft or open another topic.' :
      operation ? 'Your draft stays here until the saved request is confirmed.' : 'Only this topic is sent. Ctrl/⌘ + Enter sends.';
    const workspaceSelected = renderWorkspaceSelector();
    node('talk-create-topic').disabled = !state.configured || !state.capabilities.canCreateTopic || state.create?.state === 'submitting' ||
      (registry() && !workspaceSelected);
    for (const button of node('talk-transcript').querySelectorAll('[data-accept-proposal]'))
      button.disabled = !writable || !(registry() ? capabilities.canAcceptProposal : capabilities.canLinkTask) || busy || Boolean(operation);
  }
  function renderTopics() {
    const needle = node('talk-topic-search').value.trim().toLowerCase();
    const list = node('talk-topic-list');
    list.replaceChildren();
    const topics = state.topics.filter((topic) => [text(topic.title), ...(registry() ? [text(workspaceFor(topic.binding)?.label), topic.topicId] : [])]
      .some((value) => value.toLowerCase().includes(needle)));
    for (const topic of topics) {
      const button = make('button', 'talk-topic');
      button.type = 'button';
      button.dataset.topicId = topic.topicId;
      button.setAttribute('aria-current', String(topic.topicId === state.selected));
      button.append(make('span', 'talk-topic-title', text(topic.title) || 'Untitled topic'));
      if (registry()) button.append(make('span', 'talk-topic-workspace', bindingDescription(topic.binding)));
      const meta = make('span', 'talk-topic-meta');
      if (count(topic.unread)) meta.append(make('span', 'count', `${count(topic.unread)} unread`));
      if (count(topic.attentionCount)) meta.append(make('span', '', `${count(topic.attentionCount)} need attention`));
      if (activeTurn(topic.turnState)) meta.append(make('span', '', human(topic.turnState)));
      if (pending.get(topic.topicId)?.state === 'uncertain') meta.append(make('span', '', 'Check saved request'));
      button.append(meta);
      button.addEventListener('click', () => selectTopic(topic.topicId));
      list.append(button);
    }
    if (!topics.length) list.append(make('p', 'event-detail', needle ? 'No matching topics.' : state.configured ? 'Create a topic to start.' : 'Topics are unavailable in this setup.'));
    // unread and attention describe the same durable observations, not two counts.
    const badge = version(state.attentionPage?.total) ? state.attentionPage.total :
      new Set(state.attention.filter((item) => !item.acknowledgedAt).map((item) => item.attentionId)).size;
    node('talk-nav-count').textContent = String(badge);
    node('talk-nav-count').hidden = badge === 0;
    node('talk-nav-count').setAttribute('aria-label', `${badge} unread attention items`);
    const omitted = count(state.topicPage?.omittedBefore) + count(state.topicPage?.omittedAfter);
    node('talk-list-status').textContent = state.listError || (state.configured === null ? 'Checking Talk setup…' :
      `${state.topics.length}${registry() && version(state.topicPage?.total) ? ` of ${state.topicPage.total}` : ''} topic${state.topics.length === 1 ? '' : 's'}${omitted ? ` · ${omitted} outside this bounded list` : ''}`);
    renderControls();
  }
  function renderLinkedTasks() {
    const list = node('talk-linked-tasks');
    list.replaceChildren();
    for (const task of state.detail?.linkedTasks ?? []) {
      const card = make('article', 'talk-work-card');
      card.dataset.linkedTaskId = task.taskId;
      const heading = make('h3');
      heading.append(taskLink(task.taskId, text(task.title) || 'Linked task'));
      card.append(heading, make('p', 'event-detail', `${human(task.status) || 'Status unknown'} · version ${version(task.version) ? task.version : 'unknown'}${validId(task.currentRunId) ? ` · run ${task.currentRunId}` : ''}`));
      if (text(task.goal) || text(task.summary)) card.append(make('p', '', text(task.goal) || task.summary));
      if (task.available === false) card.append(make('p', 'blocker', text(task.reason) || 'This task observation is unavailable.'));
      if (text(task.nextAction)) card.append(make('p', '', `Next: ${task.nextAction}`));
      if (task.controller) {
        card.append(make('p', 'event-detail', `${human(task.controller.phase)} · ${human(task.controller.state)}`));
        if (text(task.controller.message)) card.append(make('p', ['BLOCKED', 'RECOVERY_REQUIRED'].includes(task.controller.state) ? 'blocker' : '', task.controller.message));
      }
      if (task.controller?.action) {
        const controls = make('div', 'talk-card-actions');
        const action = make('button', 'quiet', text(task.controller.action.label) || human(task.controller.action.action));
        action.type = 'button';
        action.dataset.taskAction = task.controller.action.action;
        action.disabled = task.available === false || taskActions.has(task.taskId);
        action.addEventListener('click', () => runTaskAction(task));
        controls.append(action); card.append(controls);
      }
      if (Array.isArray(task.omittedFields) && task.omittedFields.length)
        card.append(make('p', 'event-detail', `Shortened fields: ${task.omittedFields.map(human).filter(Boolean).join(', ')}. Open task details for the retained record.`));
      list.append(card);
    }
    if (!list.childNodes.length) list.append(make('p', 'event-detail', state.selected ? 'No tasks linked to this topic.' : 'Select a topic to see its linked work.'));
  }
  function renderAttention() {
    const list = node('talk-attention-list');
    list.replaceChildren();
    const selected = new Map(state.attention.filter((item) => !item.acknowledgedAt).map((item) => [item.attentionId, item]));
    for (const item of state.detail?.attention ?? []) {
      if (item.acknowledgedAt) selected.delete(item.attentionId);
      else selected.set(item.attentionId, item);
    }
    const items = [...selected.values()];
    const page = state.attentionPage;
    const total = version(page?.total) ? page.total : items.length;
    node('talk-attention-count').textContent = String(total);
    const omitted = count(page?.omittedBefore) + count(page?.omittedAfter);
    const extra = items.filter((item) => !state.attention.some((global) => global.attentionId === item.attentionId)).length;
    node('talk-attention-coverage').hidden = omitted === 0 && extra === 0;
    node('talk-attention-coverage').textContent = `The global list shows ${state.attention.length} of ${total} unread items${omitted ? `; ${omitted} older items are outside that page` : ''}.${extra ? ` This topic adds ${extra} retained items.` : ''} Select a topic to see all of its retained attention.`;
    for (const item of items) {
      const card = make('article', 'talk-work-card');
      card.dataset.attentionId = item.attentionId;
      const topic = state.topics.find((entry) => entry.topicId === item.topicId);
      card.append(make('h3', '', text(topic?.title) || 'Topic attention'), make('p', '', text(item.summary) || human(item.kind) || 'Task update'));
      card.append(make('p', 'event-detail', `${human(item.kind) || 'Update'} · task version ${version(item.taskVersion) ? item.taskVersion : 'unknown'}${validId(item.runId) ? ` · run ${item.runId}` : ''}`));
      const actions = make('div', 'talk-card-actions');
      const open = make('button', 'quiet', 'Open topic');
      open.type = 'button';
      open.addEventListener('click', () => {
        selectTopic(item.topicId);
        window.dispatchEvent(new CustomEvent('temari-talk-open'));
      });
      const seen = make('button', 'quiet', 'Mark seen');
      seen.type = 'button';
      const binding = state.topics.find((topic) => topic.topicId === item.topicId)?.binding;
      const capabilities = item.topicId === state.selected && state.detail ? topicCapabilities() : state.capabilities;
      seen.disabled = !state.configured || Boolean(pending.get(item.topicId)) ||
        (registry() && (!bindingAvailable(binding) || !capabilities.canAcknowledge));
      seen.addEventListener('click', () => acknowledge(item));
      actions.append(open, taskLink(item.taskId), seen);
      card.append(actions);
      list.append(card);
    }
    if (!items.length) list.append(make('p', 'event-detail', 'No unacknowledged attention items in this capture.'));
  }
  function renderMessage(author, value, createdAt) {
    const message = make('div', `talk-message${author === 'You' ? ' talk-message-user' : ''}`);
    const heading = make('div', 'talk-message-heading');
    heading.append(make('strong', '', author), make('time', '', stamp(createdAt)));
    message.append(heading, make('p', 'talk-message-text', text(value)));
    return message;
  }
  function renderProposal(turn) {
    const proposal = turn.proposedTask;
    if (!proposal || !validId(proposal.proposalId)) return null;
    const box = make('section', 'talk-work-card');
    box.dataset.proposalId = proposal.proposalId;
    box.append(make('h3', '', text(proposal.title) || 'Proposed task'), make('p', '', text(proposal.goal)));
    const status = {
      offered: 'Proposed goal — accepting saves and links an open task.',
      linking: 'Task creation or linking is in progress.',
      linked: 'Goal saved and linked. The linked task shows any admitted planning or implementation progress.',
      uncertain: 'Task creation or linking is uncertain. An explicit retry uses the retained proposal identity.',
    }[proposal.state] ?? 'Proposal state unknown. Reload before accepting.';
    box.append(make('p', 'event-detail', status));
    const actions = make('div', 'talk-card-actions');
    if (['offered', 'uncertain'].includes(proposal.state)) {
      const accept = make('button', 'quiet', proposal.state === 'uncertain' ? 'Retry accepting task proposal' : 'Accept task proposal');
      accept.type = 'button';
      accept.dataset.acceptProposal = turn.turnId;
      accept.addEventListener('click', () => acceptProposal(turn.turnId));
      actions.append(accept);
    }
    if (validId(proposal.taskId)) actions.append(taskLink(proposal.taskId));
    if (actions.childNodes.length) box.append(actions);
    return box;
  }
  function renderDetail() {
    const detail = state.detail;
    node('talk-topic-title').textContent = text(detail?.topic.title) || text(state.topics.find((topic) => topic.topicId === state.selected)?.title) || 'Talk to Temari';
    const transcript = node('talk-transcript');
    if (!detail) {
      state.fingerprint = null;
      empty(transcript, state.selected ? 'Loading this topic' : 'Select a topic', state.selected ? 'Your draft stays separate from other conversations.' : 'Talk here while your linked tasks continue. Other topics stay separate.');
      if (registry() && state.selected) transcript.replaceChildren(make('p', 'talk-topic-binding', bindingDescription(selectedBinding())), ...transcript.childNodes);
      node('talk-pagination').hidden = true;
    } else {
      const fingerprint = JSON.stringify([detail.topic.topicId, detail.turns, detail.page, registry() ? bindingDescription(detail.topic.binding) : null]);
      if (fingerprint !== state.fingerprint) {
        const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 70;
        const previousTop = transcript.scrollTop;
        const previousFingerprint = state.fingerprint;
        transcript.replaceChildren();
        for (const turn of detail.turns) {
          const box = make('article', 'talk-turn');
          box.dataset.turnId = turn.turnId;
          box.append(renderMessage('You', turn.userMessage, turn.createdAt));
          if (text(turn.assistantMessage)) box.append(renderMessage('Temari', turn.assistantMessage, turn.updatedAt));
          const note = `${turnLabel(turn)}${text(turn.reason) ? ` — ${turn.reason}` : ''}`;
          box.append(make('p', 'talk-turn-note', note));
          const proposal = renderProposal(turn);
          if (proposal) box.append(proposal);
          transcript.append(box);
        }
        if (!detail.turns.length) empty(transcript, 'Start this conversation', 'Ask a question, work through a plan, or discuss the tasks linked here.');
        if (registry()) transcript.replaceChildren(make('p', 'talk-topic-binding', bindingDescription(detail.topic.binding)), ...transcript.childNodes);
        state.fingerprint = fingerprint;
        transcript.scrollTop = (!previousFingerprint || nearBottom) && state.offset === null ? transcript.scrollHeight : previousTop;
      }
      const page = detail.page;
      node('talk-pagination').hidden = page.omittedBefore === 0 && page.omittedAfter === 0;
      node('talk-page-status').textContent = `${page.total ? page.offset + 1 : 0}–${page.offset + detail.turns.length} of ${page.total} turns · ${page.omittedBefore} earlier / ${page.omittedAfter} later omitted`;
      node('talk-earlier').disabled = page.offset === 0;
      node('talk-later').disabled = page.omittedAfter === 0 || detail.turns.length === 0;
      node('talk-latest').disabled = page.omittedAfter === 0;
    }
    renderLinkedTasks();
    renderAttention();
    renderControls();
  }
  function admitDetail(result, id) {
    if (result?.topic?.topicId !== id || !version(result.topic.version) || !Array.isArray(result.turns) ||
      !Array.isArray(result.linkedTasks) || !Array.isArray(result.attention) ||
      !version(result.page?.total) || !version(result.page?.offset) || !version(result.page?.omittedBefore) || !version(result.page?.omittedAfter) ||
      result.turns.length > LIMIT || result.turns.some((turn) => !validId(turn.turnId) || typeof turn.userMessage !== 'string') ||
      result.turns.some((turn) => turn.proposedTask && (!validId(turn.proposedTask.proposalId) ||
        typeof turn.proposedTask.title !== 'string' || typeof turn.proposedTask.goal !== 'string' ||
        !['offered', 'linking', 'linked', 'uncertain'].includes(turn.proposedTask.state) ||
        (turn.proposedTask.taskId !== null && !validId(turn.proposedTask.taskId)))) ||
      result.attention.some((item) => !validId(item.attentionId) || item.topicId !== id) ||
      result.linkedTasks.some((task) => !validId(task.taskId) || !validTaskController(task)))
      throw failed('This topic response has an unsupported shape. Reload before making changes.');
    if (registry()) {
      const binding = admitBinding(result.topic);
      if (['canCreateTopic', 'canSendTurn', 'canLinkTask', 'canAcknowledge', 'canAcceptProposal'].some((key) => typeof result.capabilities?.[key] !== 'boolean'))
        throw failed('This topic capability response is unavailable. Reload before making changes.');
      bindings.set(id, bindingPin(binding));
    }
    return result;
  }
  async function readDetail(id, offset = 0) {
    return admitDetail(await request(`${topicPath(id)}?offset=${offset}&limit=${LIMIT}`), id);
  }
  function reconcile(result) {
    const operation = pending.get(result.topic.topicId);
    if (!operation || ['preparing', 'submitting'].includes(operation.state)) return;
    if (operation.kind === 'turn' && result.turns.some((turn) => turn.requestId === operation.body.requestId)) {
      clearSubmittedDraft(operation);
      pending.delete(operation.topicId);
      mutationErrors.delete(operation.topicId);
      if (state.selected === operation.topicId) state.notice = 'Your message is saved. Its reply state is shown above.';
    }
    if ((operation.kind === 'link' && result.linkedTasks.some((task) => task.taskId === operation.body.taskId)) ||
      (operation.kind === 'ack' && result.attention.some((item) => item.attentionId === operation.attentionId && item.acknowledgedAt)) ||
      (operation.kind === 'proposal' && result.turns.some((turn) => turn.turnId === operation.turnId && turn.proposedTask?.state === 'linked' && validId(turn.proposedTask.taskId)))) {
      pending.delete(operation.topicId);
      mutationErrors.delete(operation.topicId);
    }
  }
  async function loadSelected() {
    const id = state.selected;
    if (!id || !state.configured) return;
    const sequence = ++state.detailRequest;
    const offset = state.offset;
    try {
      let detail = await readDetail(id, offset ?? 0);
      if (offset === null && detail.page.omittedAfter > 0) {
        detail = await readDetail(id, Math.max(0, detail.page.total - LIMIT));
        // A byte-bounded page can be shorter than its requested turn count.
        if (detail.page.omittedAfter > 0) detail = await readDetail(id, Math.max(0, detail.page.total - 1));
      }
      if (id !== state.selected || sequence !== state.detailRequest) return;
      state.detail = detail;
      state.fresh = true;
      reconcile(detail);
      await reconcileTaskActions(detail);
      error(mutationErrors.get(id) ?? '');
      renderDetail();
    } catch (cause) {
      if (id !== state.selected || sequence !== state.detailRequest) return;
      state.fresh = false;
      error(`${cause.message} Your draft has been kept.`);
      renderControls();
    }
  }
  async function loadTopics() {
    if (state.listLoading) return state.listLoading;
    state.listLoading = (async () => {
      try {
        const result = await request('/api/topics');
        if (typeof result.configured !== 'boolean' || !Array.isArray(result.topics) || !Array.isArray(result.attention) ||
          ['canCreateTopic', 'canSendTurn', 'canLinkTask'].some((key) => typeof result.capabilities?.[key] !== 'boolean') ||
          result.topics.some((topic) => !validId(topic.topicId)) || result.attention.some((item) => !validId(item.topicId) || !validId(item.attentionId)))
          throw failed('The topic list has an unsupported shape.');
        const mode = result.scopeMode === 'workspace-registry' ? 'workspace-registry' : 'single-workspace';
        if (result.scopeMode !== undefined && !['workspace-registry', 'single-workspace'].includes(result.scopeMode))
          throw failed('This Talk workspace mode is unsupported.');
        if (state.scopeMode !== null && state.scopeMode !== mode)
          throw failed('Talk workspace setup changed. Reload this page before making changes.');
        if (mode === 'workspace-registry') {
          if (!Array.isArray(result.workspaces) || result.workspaces.some((entry) => !workspaceKey(entry.workspaceKey) || !opaqueIdentity(entry.workspaceId) ||
            typeof entry.label !== 'string' || typeof entry.available !== 'boolean' || !version(entry.topicCount) ||
            !(entry.reason === null || typeof entry.reason === 'string')) || new Set(result.workspaces.map((entry) => entry.workspaceKey)).size !== result.workspaces.length)
            throw failed('The workspace choices have an unsupported shape.');
          for (const topic of result.topics) admitBinding(topic);
          for (const topic of result.topics) bindings.set(topic.topicId, bindingPin(topic.binding));
        }
        const changed = state.configured !== result.configured;
        state.scopeMode = mode;
        state.workspaces = mode === 'workspace-registry' ? result.workspaces : [];
        state.topicPage = mode === 'workspace-registry' ? result.page ?? null : null;
        state.configured = result.configured;
        state.capabilities = result.capabilities ?? {};
        state.topics = result.topics;
        state.attention = result.attention;
        state.attentionPage = result.attentionPage ?? null;
        state.listError = '';
        node('talk-setup').hidden = result.configured && !text(result.setupReason);
        node('talk-setup').textContent = text(result.setupReason) || 'Talk is not configured. Ask the host to select its conversational setup; task views remain available.';
        if (!result.configured) {
          state.token = null;
          state.fresh = false;
        }
        if (changed) window.dispatchEvent(new CustomEvent('temari-talk-configured', { detail: { configured: result.configured } }));
        renderTopics();
        renderAttention();
      } catch (cause) {
        state.listError = `${cause.message} Topic badges may be stale.`;
        state.fresh = false;
        renderTopics();
        renderAttention();
      }
    })();
    try { await state.listLoading; } finally { state.listLoading = null; }
  }
  async function selectTopic(id, updateUrl = true) {
    if (!validId(id)) return;
    if (id !== state.selected) {
      saveDraft();
      state.selected = id;
      state.detail = null;
      state.fresh = false;
      state.offset = null;
      state.notice = '';
      state.detailRequest++;
      state.fingerprint = null;
      node('talk-message').value = drafts.get(id) ?? '';
      error(mutationErrors.get(id) ?? '');
      renderDetail();
    }
    if (updateUrl) {
      const url = new URL(location.href);
      url.searchParams.set('view', 'talk');
      url.searchParams.set('topic', id);
      url.searchParams.delete('task');
      history.replaceState(null, '', url);
    }
    renderTopics();
    await loadSelected();
  }
  async function activate() {
    state.active = true;
    await loadTopics();
    const requested = new URL(location.href).searchParams.get('topic');
    const id = validId(requested) ? requested : state.selected || (state.topics.length === 1 ? state.topics[0].topicId : null);
    if (id && state.configured) await selectTopic(id, false);
    else renderDetail();
  }
  async function refresh() {
    await loadTopics();
    if (state.active) await loadSelected();
  }
  async function submit(operation) {
    if (pending.get(operation.topicId)?.state === 'submitting') return;
    pending.set(operation.topicId, { ...operation, state: 'submitting' });
    mutationErrors.delete(operation.topicId);
    if (state.selected === operation.topicId) { state.notice = ''; error(''); }
    renderControls();
    renderAttention();
    try {
      await token();
      const result = await request(operation.path, operation.body);
      if (operation.kind === 'turn' && (result.topicId !== operation.topicId || !validId(result.turnId) || !version(result.topicVersion)))
        throw failed('The saved turn identity could not be confirmed. Reload before retrying.', 0, true);
      if (operation.kind === 'link' || operation.kind === 'proposal') {
        try { admitDetail(result, operation.topicId); }
        catch { throw failed('The saved task or link could not be confirmed. Reload before retrying.', 0, true); }
      }
      if (operation.kind === 'ack' && (result.topicId !== operation.topicId || result.attentionId !== operation.attentionId || !version(result.topicVersion)))
        throw failed('The attention acknowledgment could not be confirmed. Reload before retrying.', 0, true);
      if (operation.kind === 'turn') {
        pending.delete(operation.topicId);
        clearSubmittedDraft(operation);
      } else pending.delete(operation.topicId);
      if (state.selected === operation.topicId) {
        state.notice = operation.kind === 'turn' ? '' : operation.kind === 'proposal' ? 'Proposal response saved. Its task/link state is shown with the turn.' : operation.kind === 'link' ? 'Task linked.' : 'Attention item marked seen.';
        if (operation.kind === 'turn') state.offset = null;
        await loadSelected();
      }
      await loadTopics();
      if (operation.kind === 'link' && state.linkTopic === operation.topicId) node('talk-link-dialog').close();
    } catch (cause) {
      if (cause.uncertain) pending.set(operation.topicId, { ...operation, state: 'uncertain' });
      else pending.delete(operation.topicId);
      const message = cause.uncertain ? `${cause.message} You may deliberately retry the identical request with its retained ID.` : cause.message;
      mutationErrors.set(operation.topicId, message);
      if (state.selected === operation.topicId) {
        error(message);
        state.fresh = false;
      } else error(`Request for another topic: ${cause.message}`);
      if (operation.kind === 'link') error(cause.message, 'talk-link-error');
      await loadTopics();
      if (state.selected === operation.topicId) await loadSelected();
    } finally {
      renderTopics();
      renderAttention();
      renderControls();
    }
  }
  async function send(event) {
    event?.preventDefault();
    if (node('talk-send').disabled) return;
    saveDraft();
    const id = state.selected;
    await submit({ kind: 'turn', topicId: id, path: `${topicPath(id)}/turns`, body: {
      requestId: crypto.randomUUID(), expectedVersion: state.detail.topic.version, text: node('talk-message').value,
    } });
  }
  async function createTopic(event) {
    event.preventDefault();
    if (!state.configured || !state.capabilities.canCreateTopic || state.create?.state === 'submitting') return;
    const previous = state.create;
    const body = previous?.state === 'uncertain' ? previous.body : { requestId: crypto.randomUUID(), title: node('talk-topic-name').value.trim(),
      ...(registry() ? { workspaceKey: node('talk-topic-workspace').value } : {}) };
    if (!body.title) return;
    if (registry() && !state.workspaces.some((entry) => entry.workspaceKey === body.workspaceKey && entry.available)) {
      error('Choose an available host-provided workspace for this new topic.', 'talk-topic-error');
      renderControls();
      return;
    }
    state.create = { body, state: 'submitting' };
    renderControls();
    error('', 'talk-topic-error');
    try {
      await token();
      const result = await request('/api/topics', body);
      if (!validId(result.topic?.topicId)) throw failed('The created topic identity could not be confirmed.', 0, true);
      if (registry()) {
        try {
          const binding = admitBinding(result.topic), selected = state.workspaces.find((entry) => entry.workspaceKey === body.workspaceKey);
          if (binding.workspaceKey !== body.workspaceKey || binding.workspaceId !== selected?.workspaceId)
            throw failed('Created topic workspace did not match the explicit selection.');
          bindings.set(result.topic.topicId, bindingPin(binding));
        } catch { throw failed('The created topic workspace could not be confirmed. Reload before an identical retry.', 0, true); }
      }
      state.create = null;
      node('talk-topic-name').readOnly = false;
      node('talk-create-topic').textContent = 'Create topic';
      node('talk-topic-dialog').close();
      await loadTopics();
      await selectTopic(result.topic.topicId);
    } catch (cause) {
      state.create = cause.uncertain ? { body, state: 'uncertain' } : null;
      node('talk-topic-name').readOnly = cause.uncertain;
      node('talk-create-topic').textContent = cause.uncertain ? 'Retry the same creation' : 'Create topic';
      error(cause.uncertain ? `${cause.message} This button retries the identical ${registry() ? 'workspace, ' : ''}title and request ID; it does not create a new request.` : cause.message, 'talk-topic-error');
    } finally { renderControls(); }
  }
  async function openLinkDialog() {
    if (node('talk-link-task').disabled) return;
    state.linkTopic = state.selected;
    node('talk-link-topic').textContent = `Link existing work to ${text(state.detail.topic.title) || 'this topic'}.`;
    node('talk-task-choice').replaceChildren(make('option', '', 'Loading tasks…'));
    node('talk-save-link').disabled = true;
    error('', 'talk-link-error');
    node('talk-link-dialog').showModal();
    try {
      const result = await request('/api/tasks');
      if (!Array.isArray(result.tasks)) throw failed('The task list is unavailable.');
      const select = node('talk-task-choice');
      const placeholder = make('option', '', 'Choose a task');
      placeholder.value = '';
      select.replaceChildren(placeholder);
      for (const task of result.tasks.filter((task) => validId(task.taskId))) {
        const option = make('option', '', `${text(task.title) || task.taskId} · ${human(task.status) || 'status unknown'}`);
        option.value = task.taskId;
        select.append(option);
      }
      if (select.options.length === 1) error('No existing tasks are available to link.', 'talk-link-error');
    } catch (cause) { error(cause.message, 'talk-link-error'); }
  }
  async function linkTask(event) {
    event.preventDefault();
    const id = state.linkTopic;
    const taskId = node('talk-task-choice').value;
    if (!validId(id) || !validId(taskId) || pending.has(id)) return;
    pending.set(id, { kind: 'link', topicId: id, state: 'preparing' });
    renderControls();
    renderAttention();
    node('talk-save-link').disabled = true;
    try {
      const detail = await readDetail(id);
      if (registry() && (!bindingAvailable(detail.topic.binding) || !detail.capabilities.canLinkTask))
        throw failed('Task linking is not available for this topic workspace.');
      await submit({ kind: 'link', topicId: id, path: `${topicPath(id)}/links`, body: { requestId: crypto.randomUUID(), expectedVersion: detail.topic.version, taskId } });
    } catch (cause) {
      if (pending.get(id)?.state === 'preparing') pending.delete(id);
      error(cause.message, 'talk-link-error');
    } finally {
      node('talk-save-link').disabled = pending.has(id);
      renderControls();
      renderAttention();
    }
  }
  async function acknowledge(item) {
    if (!state.configured || pending.has(item.topicId)) return;
    pending.set(item.topicId, { kind: 'ack', topicId: item.topicId, state: 'preparing' });
    renderControls();
    renderAttention();
    try {
      const detail = await readDetail(item.topicId);
      if (registry() && (!bindingAvailable(detail.topic.binding) || !detail.capabilities.canAcknowledge))
        throw failed('Acknowledgment is not available for this topic workspace.');
      await submit({ kind: 'ack', topicId: item.topicId, attentionId: item.attentionId,
        path: `${topicPath(item.topicId)}/attention/${encodeURIComponent(item.attentionId)}/ack`,
        body: { requestId: crypto.randomUUID(), expectedVersion: detail.topic.version },
      });
    } catch (cause) {
      if (pending.get(item.topicId)?.state === 'preparing') pending.delete(item.topicId);
      error(cause.message);
    } finally { renderControls(); renderAttention(); }
  }
  async function acceptProposal(turnId) {
    const id = state.selected;
    if (!validId(id) || !validId(turnId) || !state.fresh || pending.has(id) ||
      !(registry() ? topicCapabilities().canAcceptProposal && bindingAvailable(selectedBinding()) : state.capabilities.canLinkTask)) return;
    const turn = state.detail?.turns.find((entry) => entry.turnId === turnId);
    if (!['offered', 'uncertain'].includes(turn?.proposedTask?.state)) return;
    await submit({ kind: 'proposal', topicId: id, turnId,
      path: `${topicPath(id)}/proposals/${encodeURIComponent(turnId)}/accept`,
      body: { requestId: crypto.randomUUID(), expectedVersion: state.detail.topic.version },
    });
  }
  async function runTaskAction(task) {
    const topicId = state.selected;
    const action = task?.controller?.action;
    if (!validId(topicId) || !validId(task?.taskId) || !Number.isSafeInteger(task?.version) || task.version < 1 || !action || taskActions.has(task.taskId)) return;
    saveDraft();
    taskActions.add(task.taskId); renderLinkedTasks();
    const requestId = crypto.randomUUID();
    const body = { action: action.action, requestId, expectedVersion: task.version,
      ...(action.action === 'prepare-plan' ? { proposalSha256: action.proposalSha256 } : {}) };
    try {
      await token();
      const result = await request(`/api/tasks/${encodeURIComponent(task.taskId)}/actions`, body);
      if (result?.taskId !== task.taskId || !version(result.version))
        throw failed('The task action response could not be confirmed. Reload to check saved state.', 0, true);
      if (state.selected === topicId) state.notice = `${text(action.label) || 'Task action'} saved.`;
      mutationErrors.delete(topicId);
    } catch (cause) {
      const message = cause.uncertain
        ? `${cause.message} This action will not be retried automatically.`
        : cause.message;
      if (cause.uncertain) uncertainTaskActions.set(task.taskId, { topicId, requestId, action: action.action });
      mutationErrors.set(topicId, message);
      if (state.selected === topicId) error(message);
    } finally {
      taskActions.delete(task.taskId);
      if (state.selected === topicId) await loadSelected();
      renderLinkedTasks(); renderControls();
    }
  }
  async function reconcileTaskActions(detail) {
    const observedImplementationStates = new Set(['STARTING', 'RUNNING', 'COMPLETE', 'FAILED', 'CANCELLED', 'RECOVERY_REQUIRED']);
    for (const [taskId, operation] of uncertainTaskActions) {
      const linked = detail.linkedTasks.find((task) => task.taskId === taskId);
      if (operation.topicId !== detail.topic.topicId || !linked) continue;
      try {
        const result = await request(`/api/tasks/${encodeURIComponent(taskId)}`);
        const task = result?.task;
        if (task?.taskId !== taskId || !Array.isArray(task.events)) continue;
        if (!task.events.some((event) => event?.idempotencyKey === `ui-${operation.requestId}`)) continue;
        if (operation.action !== 'implementation-start' || linked.controller?.phase !== 'implementation' ||
          !observedImplementationStates.has(linked.controller.state)) continue;
        uncertainTaskActions.delete(taskId);
        mutationErrors.delete(operation.topicId);
        if (state.selected === operation.topicId) {
          state.notice = `Implementation intent is retained; the controller now reports ${human(linked.controller.state)}.`;
          error('');
        }
      } catch {}
    }
  }
  async function poll() {
    clearTimeout(state.timer);
    if (!document.hidden) await refresh();
    const busy = state.active && (state.detail?.turns.some((turn) => activeTurn(turn.state)) ||
      activeTurn(state.topics.find((topic) => topic.topicId === state.selected)?.turnState) || pending.has(state.selected));
    state.timer = setTimeout(poll, busy ? 3000 : 10000);
  }
  node('talk-topic-search').addEventListener('input', renderTopics);
  node('talk-message').addEventListener('input', () => { saveDraft(); renderControls(); });
  node('talk-message').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) send(event);
  });
  node('talk-composer').addEventListener('submit', send);
  node('talk-retry').addEventListener('click', () => {
    const operation = pending.get(state.selected);
    if (operation?.state === 'uncertain') submit(operation);
  });
  node('talk-new-topic').addEventListener('click', () => {
    if (node('talk-new-topic').disabled) return;
    if (!state.create) {
      node('talk-topic-name').value = '';
      node('talk-topic-name').readOnly = false;
      node('talk-topic-workspace').value = '';
      node('talk-create-topic').textContent = 'Create topic';
      error('', 'talk-topic-error');
    }
    renderControls();
    node('talk-topic-dialog').showModal();
    node('talk-topic-name').focus();
  });
  node('talk-topic-form').addEventListener('submit', createTopic);
  node('talk-topic-workspace').addEventListener('change', () => { error('', 'talk-topic-error'); renderControls(); });
  node('talk-close-topic').addEventListener('click', () => node('talk-topic-dialog').close());
  node('talk-close-link').addEventListener('click', () => node('talk-link-dialog').close());
  node('talk-link-task').addEventListener('click', openLinkDialog);
  node('talk-link-form').addEventListener('submit', linkTask);
  node('talk-task-choice').addEventListener('change', () => { node('talk-save-link').disabled = !validId(node('talk-task-choice').value); });
  node('talk-refresh-topic').addEventListener('click', () => { mutationErrors.delete(state.selected); state.notice = ''; refresh(); });
  node('refresh').addEventListener('click', () => { if (state.active) refresh(); });
  node('talk-earlier').addEventListener('click', () => { state.offset = Math.max(0, (state.detail?.page.offset ?? 0) - LIMIT); loadSelected(); });
  node('talk-later').addEventListener('click', () => {
    state.offset = (state.detail?.page.offset ?? 0) + (state.detail?.turns.length ?? 0);
    loadSelected();
  });
  node('talk-latest').addEventListener('click', () => { state.offset = null; loadSelected(); });
  window.addEventListener('dashboard-view-changed', (event) => { state.active = event.detail?.view === 'talk'; });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  window.TemariTalkUI = { activate };
  poll();
})();
