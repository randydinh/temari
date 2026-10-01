const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
};
const byId = (id) => document.getElementById(id);
const state = {
  tasks: [],
  filter: 'open',
  selected: new URL(location.href).searchParams.get('task'),
  archonBaseUrl: '',
  loading: false,
  continuationOpen: new Set(),
  renderedDetail: null,
};
const stages = ['investigate', 'plan', 'build', 'review', 'verify', 'deliver'];
const statusNames = {
  OPEN: 'Open',
  RUNNING: 'Running',
  BLOCKED: 'Blocked',
  NEEDS_REVIEW: 'Needs review',
  DONE: 'Done',
  CANCELLED: 'Cancelled',
  PASS: 'Passed',
  ISSUES: 'Issues',
  SUCCEEDED: 'Succeeded',
  FAILED: 'Failed',
  UNKNOWN: 'Unknown',
  QUEUED: 'Queued',
  PENDING: 'Pending',
  UNCERTAIN: 'Uncertain',
  CONFIRMED: 'Confirmed',
};
const badge = (status) =>
  el(
    'span',
    `badge ${String(status).toLowerCase()}`,
    statusNames[status] ?? status,
  );
const relativeTime = (value) => {
  const minutes = Math.max(
    0,
    Math.round((Date.now() - Date.parse(value)) / 60000),
  );
  if (!Number.isFinite(minutes)) return 'Unknown';
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
};
function section(title, note) {
  const heading = el('div', 'section-heading');
  heading.append(el('h3', '', title));
  if (note) heading.append(el('span', 'section-note', note));
  return heading;
}
function link(label, href) {
  const result = el('a', '', label);
  result.href = href;
  result.target = '_blank';
  result.rel = 'noreferrer';
  return result;
}
function renderList() {
  const query = byId('search').value.trim().toLowerCase();
  const open = state.tasks.filter((t) => t.status !== 'DONE');
  byId('task-count').textContent = state.tasks.length;
  byId('open-count').textContent = open.length;
  const visible = state.tasks.filter(
    (t) =>
      (state.filter === 'all' ||
        (state.filter === 'done'
          ? t.status === 'DONE'
          : t.status !== 'DONE')) &&
      `${t.title} ${t.goal} ${t.taskId}`.toLowerCase().includes(query),
  );
  const list = byId('task-list');
  list.replaceChildren();
  if (!visible.length) {
    list.append(
      el(
        'p',
        'no-results',
        state.tasks.length
          ? 'No tasks match this view.'
          : 'No tasks yet. Register a task with the Temari task command to see it here.',
      ),
    );
    return;
  }
  for (const task of visible) {
    const card = el('button', 'task-card');
    card.setAttribute('aria-current', String(task.taskId === state.selected));
    const top = el('div', 'task-card-top');
    top.append(el('span', 'task-title', task.title), badge(task.status));
    const meta = el('div', 'task-meta');
    meta.append(
      el(
        'span',
        '',
        `${task.runs.length} ${task.runs.length === 1 ? 'run' : 'runs'}`,
      ),
      el('span', '', relativeTime(task.updatedAt)),
    );
    card.append(
      top,
      el('div', 'task-preview', task.nextAction ?? task.goal),
      meta,
    );
    card.addEventListener('click', () => {
      state.selected = task.taskId;
      const url = new URL(location.href);
      url.searchParams.set('task', task.taskId);
      history.replaceState(null, '', url);
      renderList();
      renderDetail();
    });
    list.append(card);
  }
}
const eventTitles = {
  'task-created': 'Task created',
  'task-entered': 'Chat linked to this task',
  'handoff-recorded': 'Continuation handoff saved',
  'metadata-updated': 'Next action updated',
  'run-bound': 'Run attached to this task',
  'evidence-roots-attached': 'Evidence locations connected',
  'dispatch-requested': 'Execution requested',
  'control-requested': 'Run control requested',
  'native-bound': 'Archon run connected',
  'native-observed': 'Run status observed',
  'operation-uncertain': 'Execution needs reconciliation',
  'evidence-verified': 'Stage evidence verified',
  'task-accepted': 'Result accepted by Temari',
};
function continuationText(brief) {
  const run = brief.currentRun;
  const handoff = brief.handoff;
  return [
    `Continue task ${brief.taskId}: ${brief.title}`,
    `Workspace: ${brief.workspaceRoot}`,
    `Goal: ${brief.goal}`,
    `Status: ${brief.status} · version ${brief.version}`,
    `Next action: ${brief.nextAction ?? 'Choose the next step.'}`,
    `Blocker: ${brief.blocker ?? 'None recorded.'}`,
    `Current stage: ${brief.currentStage ?? 'No execution stage recorded.'}`,
    '',
    'Execution and evidence:',
    ...(run
      ? [
          `Run: ${run.runId} · revision ${run.revision}`,
          `Plan digest: ${run.planSha256}`,
          `Native run: ${run.nativeRef ? `${run.nativeRef.harnessId} / ${run.nativeRef.externalRunId}` : 'Not attached.'}`,
          `Native status: ${run.nativeStatus ?? 'Not observed.'}`,
          `Receipt: ${run.receiptRoot ?? 'Not attached.'}`,
          `Evidence: ${run.evidenceRoot ?? 'Not attached.'}`,
          ...run.unresolvedOperations.map(
            (op) =>
              `Pending ${op.kind} (${op.commandId}): ${op.state}${op.reason ? ` · ${op.reason}` : ''}`,
          ),
        ]
      : ['No execution run is attached.']),
    `Evidence verified: ${brief.evidence.verified ? 'yes' : 'no'} · scope ${brief.evidence.scope ?? 'none'}`,
    `Semantic acceptance: ${brief.semanticAcceptance ? 'yes' : 'no'}`,
    ...brief.evidence.issues.map((issue) => `- ${issue}`),
    '',
    'Last handoff (context to verify before acting):',
    ...(handoff
      ? [
          `${handoff.actor} · ${handoff.at} · version ${handoff.taskVersion}`,
          handoff.summary,
          ...handoff.decisions.map((decision) => `Decision: ${decision}`),
          ...handoff.contextRefs.map(
            (ref) =>
              `Reference (${ref.kind}): ${ref.location}${ref.sha256 ? ` · sha256 ${ref.sha256}` : ''}`,
          ),
        ]
      : ['No handoff recorded.']),
    '',
    'Recent activity:',
    ...brief.recentEvents.map(
      (event) => `- ${event.at} · ${event.actor}: ${event.summary}`,
    ),
    `History: ${brief.history.totalEvents} events, ${brief.history.totalRuns} runs; ${brief.history.omittedEvents} earlier events and ${brief.history.omittedRuns} other runs omitted.`,
    `Brief omissions: ${brief.truncation.omittedDecisions} decisions, ${brief.truncation.omittedContextRefs} references, ${brief.truncation.omittedEvidenceIssues} evidence issues, ${brief.truncation.omittedUnresolvedOperations} pending operations.`,
    ...(brief.truncation.fields.length
      ? [`Shortened fields: ${brief.truncation.fields.join(', ')}.`]
      : []),
    '',
    'This brief is task context. It does not authorize actions or establish completion.',
  ].join('\n');
}
function renderContinuation(task) {
  const panel = el('details', 'continuation');
  panel.open = state.continuationOpen.has(task.taskId);
  panel.append(el('summary', '', 'Continue in a chat'));
  panel.append(
    el(
      'p',
      '',
      'Prepare a bounded brief for Temari with the next action, decisions, run identity, and evidence status.',
    ),
  );
  const output = el('textarea', 'continuation-text');
  output.readOnly = true;
  output.setAttribute('aria-label', 'Task continuation brief');
  output.rows = 12;
  const actions = el('div', 'continuation-actions');
  const copy = el('button', 'quiet', 'Copy current brief');
  const note = el('span', 'section-note');
  note.setAttribute('role', 'status');
  actions.append(copy, note);
  panel.append(output, actions);
  let loading = false;
  async function prepare(copyToClipboard = false) {
    if (loading) return;
    loading = true;
    copy.disabled = true;
    note.textContent = 'Checking retained evidence…';
    try {
      const response = await fetch(
        `/api/tasks/${encodeURIComponent(task.taskId)}/pickup`,
        { cache: 'no-store' },
      );
      const result = await response.json();
      if (!response.ok || !result.selected)
        throw new Error(result.error ?? 'The task could not be recovered.');
      if (!panel.isConnected) return;
      output.value = continuationText(result.selected);
      note.textContent = `Prepared ${new Date().toLocaleTimeString()}`;
      if (copyToClipboard) {
        try {
          await navigator.clipboard.writeText(output.value);
          note.textContent = 'Current brief copied.';
        } catch {
          output.focus();
          output.select();
          note.textContent = 'Brief selected. Copy it with your keyboard.';
        }
      }
    } catch (error) {
      output.value = '';
      note.textContent = error.message;
    } finally {
      loading = false;
      copy.disabled = false;
    }
  }
  panel.addEventListener('toggle', () => {
    if (panel.open) {
      state.continuationOpen.add(task.taskId);
      prepare();
    } else state.continuationOpen.delete(task.taskId);
  });
  copy.addEventListener('click', () => prepare(true));
  return panel;
}
function renderDetail() {
  const task = state.tasks.find((t) => t.taskId === state.selected);
  const detailKey = JSON.stringify([task ?? null, state.archonBaseUrl]);
  if (detailKey === state.renderedDetail) return;
  state.renderedDetail = detailKey;
  const detail = byId('detail');
  if (!task) {
    detail.replaceChildren();
    const empty = el('div', 'empty-state');
    empty.append(
      el('span', 'empty-symbol', '◎'),
      el('h2', '', 'Your work, in one place'),
      el('p', '', 'Select a task to see its next action, runs, and evidence.'),
    );
    detail.append(empty);
    return;
  }
  const previousScroll = window.scrollY;
  detail.replaceChildren(el('div', 'crumb', `TASK / ${task.taskId}`));
  const title = el('div', 'detail-heading');
  title.append(el('h2', '', task.title), badge(task.status));
  detail.append(title, el('p', 'goal', task.goal));
  const next = el('div', 'next-action');
  next.append(
    el(
      'span',
      'eyebrow',
      task.status === 'DONE' ? 'ACCEPTED RESULT' : 'NEXT ACTION',
    ),
    el(
      'p',
      '',
      task.nextAction ??
        (task.acceptance
          ? task.acceptance.reason
          : 'Review the task and choose its next step.'),
    ),
  );
  if (task.blocker)
    next.append(el('div', 'blocker', `Blocked · ${task.blocker}`));
  detail.append(next, renderContinuation(task));
  if (task.handoff) {
    const handoff = el('div', 'handoff');
    handoff.append(
      section('Last handoff', relativeTime(task.handoff.at)),
      el('p', '', task.handoff.summary),
    );
    if (task.handoff.decisions.length) {
      const decisions = el('ul');
      for (const decision of task.handoff.decisions)
        decisions.append(el('li', '', decision));
      handoff.append(decisions);
    }
    handoff.append(
      el(
        'div',
        'event-detail',
        `${task.handoff.actor} · ${(task.sessions ?? []).length} linked ${(task.sessions ?? []).length === 1 ? 'chat' : 'chats'}`,
      ),
    );
    detail.append(handoff);
  }
  detail.append(
    section(
      'Workflow',
      task.currentStage ? `Current · ${task.currentStage}` : 'Six stages',
    ),
  );
  const current = task.runSnapshots.find((r) => r.runId === task.currentRunId);
  const stageGrid = el('div', 'stages');
  for (const stage of stages) {
    const result = current?.stages.find((s) => s.stage === stage);
    const card = el('div', `stage ${result?.status?.toLowerCase() ?? ''}`);
    card.title = result?.summary ?? 'No retained result yet';
    card.append(
      el('span', 'stage-mark', result?.status === 'PASS' ? '✓' : '○'),
      el('div', 'stage-name', stage),
      el('div', 'stage-status', statusNames[result?.status] ?? 'Pending'),
    );
    stageGrid.append(card);
  }
  detail.append(stageGrid, section('Runs', 'One goal, retained history'));
  if (!task.runs.length)
    detail.append(
      el('p', 'no-results', 'Attach a run when the task is ready to execute.'),
    );
  for (const run of [...task.runs].reverse()) {
    const snap = task.runSnapshots.find((r) => r.runId === run.runId);
    const card = el('article', 'run-card');
    const top = el('div', 'run-top');
    top.append(
      el('span', 'run-id', run.runId),
      badge(run.nativeSnapshot?.status ?? snap?.receiptStatus ?? 'PENDING'),
    );
    const info = el('div', 'run-info');
    info.append(
      el(
        'span',
        '',
        `Revision ${run.revision.length > 20 ? run.revision.slice(0, 12) : run.revision}`,
      ),
      el(
        'span',
        '',
        run.runId === task.currentRunId ? 'Current run' : 'Previous run',
      ),
    );
    if (run.nativeSnapshot)
      info.append(
        el(
          'span',
          '',
          `Observed ${relativeTime(run.nativeSnapshot.observedAt)}`,
        ),
      );
    if (run.nativeRef && run.nativeSnapshot?.nativeProjectId)
      info.append(
        link(
          'Open run in Archon ↗',
          `${state.archonBaseUrl}/console/p/${encodeURIComponent(run.nativeSnapshot.nativeProjectId)}/r/${encodeURIComponent(run.nativeRef.externalRunId)}`,
        ),
      );
    else if (run.nativeRef)
      info.append(
        link('Open Archon console ↗', `${state.archonBaseUrl}/console`),
      );
    card.append(
      top,
      info,
      el(
        'div',
        'evidence-note',
        snap?.evidence?.verified
          ? 'Retained stage evidence verified. Task completion also requires Temari acceptance.'
          : `Evidence incomplete${snap?.evidence?.issues?.length ? ` · ${snap.evidence.issues.join(' ')}` : '.'}`,
      ),
    );
    for (const operation of run.operations.filter(
      (o) => o.state !== 'CONFIRMED' || o.outcome === 'finished-before-cancel',
    ))
      card.append(
        el(
          'div',
          'blocker',
          `${operation.kind}: ${operation.state.toLowerCase()}. ${operation.reason ?? 'Reconcile the exact run before retrying.'}`,
        ),
      );
    for (const issue of snap?.issues ?? [])
      card.append(el('div', 'blocker', issue));
    detail.append(card);
  }
  const summaries = el('div', 'summary-grid');
  const workers = el('div', 'summary-panel');
  workers.append(el('h4', '', 'Worker outcomes'));
  const children = task.runSnapshots.flatMap((r) => r.children ?? []);
  for (const child of children) {
    const row = el('div', 'worker-row');
    const desc = el('span', '', child.assignmentId ?? child.taskId);
    desc.append(
      el(
        'div',
        'event-detail',
        `Attempt ${child.attempt}${child.result?.summary ? ` · ${child.result.summary}` : ''}`,
      ),
    );
    row.append(desc, badge(child.status));
    workers.append(row);
  }
  if (!children.length)
    workers.append(el('p', '', 'No delegated worker records attached.'));
  const sources = el('div', 'summary-panel');
  sources.append(el('h4', '', 'Source references'));
  const refs = task.runs.flatMap((r) => r.sourceRefs ?? []);
  for (const ref of refs) {
    const row = el('div', 'source-row');
    const name = el('span', 'source-label', ref.sourceId);
    name.append(
      el('div', 'event-detail', `${ref.publicationId} · ${ref.location}`),
    );
    row.append(name);
    sources.append(row);
  }
  if (!refs.length)
    sources.append(el('p', '', 'No Registrar publications attached.'));
  summaries.append(workers, sources);
  detail.append(
    section('Evidence & delegation'),
    summaries,
    section('Activity', `${task.events.length} retained events`),
  );
  const timeline = el('ol', 'timeline');
  for (const event of [...task.events].reverse()) {
    const row = el('li');
    const body = el('div');
    const change = event.change;
    body.append(
      el('div', 'event-title', eventTitles[change.type] ?? change.type),
    );
    const note = [
      event.actor,
      change.runId ?? change.run?.runId,
      change.snapshot?.status,
      change.reason ?? change.nextAction,
    ]
      .filter(Boolean)
      .join(' · ');
    body.append(el('div', 'event-detail', note));
    const time = el('time', '', relativeTime(event.at));
    time.dateTime = event.at;
    time.title = new Date(event.at).toLocaleString();
    row.append(body, time);
    timeline.append(row);
  }
  detail.append(timeline);
  window.scrollTo({ top: previousScroll });
}
async function refresh() {
  if (state.loading) return;
  state.loading = true;
  byId('refresh').disabled = true;
  try {
    const response = await fetch('/api/tasks', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok)
      throw new Error(data.error ?? 'Task state could not be read.');
    state.tasks = data.tasks;
    state.archonBaseUrl = data.archonBaseUrl;
    if (!state.selected && state.tasks.length)
      state.selected =
        state.tasks.find((t) => t.status !== 'DONE')?.taskId ??
        state.tasks[0].taskId;
    byId('archon-home').href = `${data.archonBaseUrl}/console`;
    byId('connection').textContent = 'Read-only · refreshed';
    byId('error').hidden = true;
    renderList();
    renderDetail();
  } catch (error) {
    byId('connection').textContent = 'Refresh failed';
    byId('error').textContent = error.message;
    byId('error').hidden = false;
  } finally {
    state.loading = false;
    byId('refresh').disabled = false;
  }
}
byId('refresh').addEventListener('click', refresh);
byId('search').addEventListener('input', renderList);
for (const button of document.querySelectorAll('[data-filter]'))
  button.addEventListener('click', () => {
    state.filter = button.dataset.filter;
    for (const item of document.querySelectorAll('[data-filter]'))
      item.setAttribute('aria-pressed', String(item === button));
    renderList();
  });
window.addEventListener('popstate', () => {
  state.selected = new URL(location.href).searchParams.get('task');
  renderList();
  renderDetail();
});
setInterval(() => {
  if (!document.hidden) refresh();
}, 10000);
refresh();
