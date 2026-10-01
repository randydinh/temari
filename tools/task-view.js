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
  dashboard: null,
  mutating: false,
  drafts: new Map(),
  goalRequestId: null,
  expanded: new Set(),
};
const stages = ['investigate', 'plan', 'build', 'review', 'verify', 'deliver'];
// Keep terminal escape sequences out of the browser preview; retain raw artifacts.
const plainLog = (value) => value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
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
  CANCELLING: 'Stopping agents',
  PREPARED: 'Ready to start',
  STARTING: 'Starting',
  COMPLETE: 'Findings ready',
  RECOVERY_REQUIRED: 'Recovery required',
};
function displayedStatus(task) {
  const control = state.dashboard?.config?.controls?.[task.taskId];
  if (control?.planning && !control.implementation) {
    if (['STARTING', 'RUNNING'].includes(control.planning.state))
      return 'RUNNING';
    if (
      ['BLOCKED', 'RECOVERY_REQUIRED'].includes(control.planning.state) ||
      control.planning.integrityIssue
    )
      return 'BLOCKED';
  }
  const execution = control?.implementation ?? control?.swarm;
  if (!execution) return task.status;
  if (
    execution.integrityIssue ||
    ['RECOVERY_REQUIRED', 'FAILED'].includes(execution.state)
  )
    return 'BLOCKED';
  if (execution.state === 'PREPARED') return 'OPEN';
  if (['STARTING', 'RUNNING'].includes(execution.state))
    return execution.workers.some(({ events }) =>
      events.some((event) => event.type === 'task-cancellation-requested'),
    )
      ? 'CANCELLING'
      : 'RUNNING';
  if (control.implementation) {
    const results = [
      execution.integration?.status,
      execution.review?.result?.status,
      ...execution.workers.map(({ task: child }) => child.status),
    ];
    if (results.some((result) => ['BLOCKED', 'FAILED'].includes(result)))
      return 'BLOCKED';
    if (results.includes('ISSUES')) return 'ISSUES';
  }
  return task.status;
}
const badge = (status, label) =>
  el(
    'span',
    `badge ${String(status).toLowerCase()}`,
    label ?? statusNames[status] ?? status,
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
          : state.dashboard?.mode === 'writable'
            ? 'No tasks yet. Choose New goal to get started.'
            : 'No tasks yet. Register a task with Temari to see it here.',
      ),
    );
    return;
  }
  for (const task of visible) {
    const card = el('button', 'task-card');
    card.setAttribute('aria-current', String(task.taskId === state.selected));
    const top = el('div', 'task-card-top');
    top.append(
      el('span', 'task-title', task.title),
      badge(displayedStatus(task)),
    );
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
  const control = state.dashboard?.config?.controls?.[task?.taskId];
  const detailKey = JSON.stringify([
    task ?? null,
    state.archonBaseUrl,
    control,
    state.mutating,
  ]);
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
  title.append(el('h2', '', task.title), badge(displayedStatus(task)));
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
  detail.append(next);
  if (control) detail.append(renderControls(task, control));
  detail.append(renderContinuation(task));
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
  if (!control?.swarm && !control?.implementation && !control?.planning)
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
  if (!control?.swarm && !control?.implementation && !control?.planning)
    detail.append(stageGrid);
  detail.append(section('Runs', 'One goal, retained history'));
  if (control?.progress?.length) {
    const progress = el('div', 'native-progress');
    progress.append(
      section('Execution logs', 'Native captures · verified at closeout'),
    );
    for (const capture of control.progress) {
      const row = el('details', 'log-capture');
      row.append(el('summary', '', `${capture.stage} · ${capture.summary}`));
      row.append(el('pre', '', plainLog(capture.stdout) || '(No stdout)'));
      if (capture.stderr) row.append(el('pre', '', plainLog(capture.stderr)));
      if (capture.outputTruncated)
        row.append(
          el(
            'p',
            'event-detail',
            'Preview shortened. Full output is retained in the run artifacts.',
          ),
        );
      progress.append(row);
    }
    detail.append(progress);
  }
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
      badge(
        run.runId === task.currentRunId && control?.implementation
          ? control.implementation.state
          : run.runId === task.currentRunId && control?.swarm
            ? control.swarm.state
            : (run.nativeSnapshot?.status ?? snap?.receiptStatus ?? 'PENDING'),
        run.runId === task.currentRunId &&
          control?.implementation?.state === 'COMPLETE'
          ? 'Candidate ready'
          : undefined,
      ),
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
        run.runId === task.currentRunId && control?.implementation
          ? 'Worker patches, combined verification, and independent review are retained with the integration candidate. Temari reviews the candidate against the goal.'
          : run.runId === task.currentRunId && control?.swarm
            ? 'Investigation findings are retained per agent. Temari reviews them before deciding the next step.'
            : snap?.evidence?.verified
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
    const [response, dashboardResponse] = await Promise.all([
      fetch('/api/tasks', { cache: 'no-store' }),
      fetch('/api/dashboard', { cache: 'no-store' }),
    ]);
    const data = await response.json();
    const dashboard = await dashboardResponse.json();
    if (!response.ok)
      throw new Error(data.error ?? 'Task state could not be read.');
    if (!dashboardResponse.ok)
      throw new Error(
        dashboard.error ?? 'Dashboard controls could not be read.',
      );
    state.dashboard = dashboard;
    state.tasks = data.tasks;
    state.archonBaseUrl = data.archonBaseUrl;
    if (!state.selected && state.tasks.length)
      state.selected =
        state.tasks.find((t) => t.status !== 'DONE')?.taskId ??
        state.tasks[0].taskId;
    byId('archon-home').href = `${data.archonBaseUrl}/console`;
    byId('connection').textContent =
      `${dashboard.mode === 'writable' ? 'Local controls' : 'Read-only'} · refreshed`;
    byId('new-goal').hidden = dashboard.mode !== 'writable';
    byId('error').hidden = true;
    renderList();
    renderDetail();
    window.dispatchEvent(new Event('dashboard-refreshed'));
  } catch (error) {
    byId('connection').textContent = 'Refresh failed';
    byId('error').textContent = error.message;
    byId('error').hidden = false;
  } finally {
    state.loading = false;
    byId('refresh').disabled = false;
  }
}
async function post(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-temari-token': state.dashboard.csrfToken,
    },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      result.error ?? 'The operation failed. Refresh the task before retrying.',
    );
  return result;
}
async function perform(task, action, extra = {}) {
  if (state.mutating) return;
  state.mutating = true;
  renderDetail();
  let failure;
  try {
    await post(`/api/tasks/${encodeURIComponent(task.taskId)}/actions`, {
      action,
      requestId: crypto.randomUUID(),
      expectedVersion: task.version,
      ...extra,
    });
    if (action === 'update') state.drafts.delete(task.taskId);
  } catch (error) {
    failure = error.message;
  } finally {
    state.mutating = false;
    await refresh();
  }
  if (failure) {
    byId('error').textContent = failure;
    byId('error').hidden = false;
  }
}
function ownershipList(owns) {
  const list = el('ul', 'ownership-list');
  for (const scope of owns ?? [])
    list.append(el('li', '', `${scope.kind} · ${scope.path}`));
  return list;
}
function retainedArtifacts(paths) {
  const artifacts = el('details', 'worker-artifacts');
  artifacts.append(
    el('summary', '', `Retained logs and artifacts (${paths.length})`),
  );
  for (const path of paths) artifacts.append(el('p', 'artifact-path', path));
  return artifacts;
}
function renderWorkerOutcomes(task, workers) {
  const outcomes = el('div', 'swarm-outcomes');
  for (const { assignment, task: child, events } of workers) {
    const row = el('details', 'log-capture');
    const key = `${task.taskId}/${assignment.id}`;
    row.open = state.expanded.has(key);
    row.addEventListener('toggle', () => {
      if (row.isConnected)
        row.open ? state.expanded.add(key) : state.expanded.delete(key);
    });
    const summary = el('summary');
    summary.append(
      el(
        'span',
        '',
        `${assignment.id} · ${assignment.role ?? 'implementer'} · attempt ${child.attempt} `,
      ),
      badge(child.status),
    );
    row.append(summary);
    row.append(
      el('p', 'event-detail', assignment.brief?.context ?? assignment.goal),
    );
    if (assignment.owns?.length) {
      row.append(el('p', 'event-detail', 'Owns these paths:'));
      row.append(ownershipList(assignment.owns));
    }
    if (child.result?.summary)
      row.append(el('pre', '', plainLog(child.result.summary)));
    if (child.error) row.append(el('p', 'blocker', child.error));
    if (
      events.some((event) => event.type === 'task-cancellation-requested') &&
      ![
        'CANCELLED',
        'SUCCEEDED',
        'FAILED',
        'ISSUES',
        'BLOCKED',
        'DROPPED',
      ].includes(child.status)
    )
      row.append(
        el(
          'p',
          'event-detail',
          'Stop requested. Waiting for the worker process to exit.',
        ),
      );
    const history = el('ul', 'worker-history');
    for (const event of events.filter(
      (item) => item.type !== 'task-lease-renewed',
    ))
      history.append(
        el(
          'li',
          '',
          `${new Date(event.at).toLocaleTimeString()} · ${event.type.replace(/^task-/, '').replaceAll('-', ' ')}`,
        ),
      );
    row.append(history);
    const paths = child.result?.evidencePaths ?? [];
    if (paths.length) row.append(retainedArtifacts(paths));
    outcomes.append(row);
  }
  return outcomes;
}
const implementationPhases = [
  ['prepared', 'Prepared'],
  ['implementing', 'Implementers'],
  ['integrating', 'Integration'],
  ['verifying', 'Verification'],
  ['reviewing', 'Independent review'],
  ['complete', 'Candidate ready'],
];
function renderImplementation(task, control) {
  const implementation = control.implementation;
  const panel = el('div', 'implementation-work');
  const limits = control.limits;
  panel.append(
    el(
      'p',
      'event-detail',
      `${limits.totalWorkers} implementers · at most ${limits.maxConcurrency} running at once · ${Math.round(limits.timeoutMs / 1000)}s per attempt · one attempt per implementer · independent reviewer after combined verification.`,
    ),
  );
  const phases = el('ol', 'implementation-phases');
  phases.setAttribute('aria-label', 'Implementation progress');
  const currentPhase = implementationPhases.findIndex(
    ([phase]) => phase === implementation.phase,
  );
  implementationPhases.forEach(([phase, title], index) => {
    const row = el(
      'li',
      phase === implementation.phase
        ? 'current'
        : index < currentPhase
          ? 'reached'
          : '',
      title,
    );
    if (phase === implementation.phase)
      row.setAttribute('aria-current', 'step');
    phases.append(row);
  });
  panel.append(phases);
  if (implementation.statusNote)
    panel.append(el('p', 'event-detail', implementation.statusNote));
  if (implementation.integrityIssue)
    panel.append(el('p', 'blocker', implementation.integrityIssue));
  if (implementation.state === 'RECOVERY_REQUIRED')
    panel.append(
      el(
        'p',
        'blocker',
        'Temari needs to reconcile the retained worker identities and integration artifacts before work can continue.',
      ),
    );
  panel.append(
    section('Implementer outcomes', 'Isolated workspaces · assigned ownership'),
    renderWorkerOutcomes(task, implementation.workers),
  );
  const integration = implementation.integration;
  if (integration) {
    const candidate = el('section', 'integration-candidate');
    const heading = section('Integration candidate');
    if (integration.status) heading.append(badge(integration.status));
    candidate.append(heading);
    if (integration.integrationPath)
      candidate.append(
        el('p', 'event-detail', 'Review this integration workspace:'),
        el('p', 'artifact-path', integration.integrationPath),
      );
    if (integration.integratedCommit)
      candidate.append(
        el('p', 'event-detail', 'Exact candidate commit:'),
        el('p', 'artifact-path', integration.integratedCommit),
      );
    if (integration.patches?.length) {
      const patches = el('details', 'worker-artifacts');
      patches.append(
        el(
          'summary',
          '',
          `Retained worker patches (${integration.patches.length})`,
        ),
      );
      for (const patch of integration.patches) {
        patches.append(el('p', 'event-detail', patch.assignmentId));
        const paths = el('ul', 'ownership-list');
        for (const path of patch.changedPaths) paths.append(el('li', '', path));
        patches.append(
          paths,
          el('p', 'artifact-path', patch.patchPath),
          el('p', 'artifact-path', `sha256 ${patch.sha256}`),
        );
      }
      candidate.append(patches);
    }
    candidate.append(section('Combined verification'));
    if (!integration.verification?.length)
      candidate.append(
        el('p', 'event-detail', 'Waiting for the integrated candidate.'),
      );
    for (const check of integration.verification ?? []) {
      const row = el('div', 'verification-check');
      const command = el(
        'span',
        'verification-command',
        [check.program, ...check.args].join(' '),
      );
      row.append(
        command,
        badge(
          check.code === 0 ? 'PASS' : check.code == null ? 'PENDING' : 'FAILED',
        ),
      );
      if (check.logPath) row.append(el('p', 'artifact-path', check.logPath));
      candidate.append(row);
    }
    if (integration.receiptPath)
      candidate.append(retainedArtifacts([integration.receiptPath]));
    panel.append(candidate);
  }
  const review = implementation.review;
  const reviewPanel = el('section', 'implementation-review');
  const reviewHeading = section(
    'Independent review',
    'Temari reviews the result against the goal',
  );
  if (review?.result?.status) reviewHeading.append(badge(review.result.status));
  reviewPanel.append(reviewHeading);
  if (review?.assignment)
    reviewPanel.append(
      el(
        'p',
        'event-detail',
        `${review.assignment.id} · ${review.assignment.goal ?? review.assignment.brief?.context ?? 'Review the verified integration candidate.'}`,
      ),
    );
  if (review?.revision)
    reviewPanel.append(
      el('p', 'artifact-path', `Reviewed commit ${review.revision}`),
    );
  if (review?.result?.summary)
    reviewPanel.append(el('pre', '', plainLog(review.result.summary)));
  else
    reviewPanel.append(
      el(
        'p',
        'event-detail',
        'Review findings will be retained after combined verification.',
      ),
    );
  if (review?.result?.evidencePaths?.length)
    reviewPanel.append(retainedArtifacts(review.result.evidencePaths));
  if (
    implementation.state === 'COMPLETE' &&
    !implementation.integrityIssue &&
    integration?.status === 'PASS' &&
    integration.integratedCommit &&
    review?.result?.status === 'PASS' &&
    review.revision === integration.integratedCommit
  )
    reviewPanel.append(
      el(
        'p',
        'review-required',
        'The candidate is ready for Temari to assess the findings, verification, and original goal. This task still needs review.',
      ),
    );
  panel.append(reviewPanel);
  return panel;
}
function renderControls(task, control) {
  const panel = el('section', 'task-controls');
  panel.append(
    section(
      'Work on this task',
      control.implementation
        ? (control.planTitle ?? 'Parallel implementation')
        : control.swarm
          ? 'Read-only agent swarm'
          : control.planning
            ? 'Temari goal planning'
            : (control.recipe ?? 'Needs planning'),
    ),
  );
  if (control.message) {
    const message = control.swarm?.integrityIssue
      ? control.message
      : control.swarm?.state === 'PREPARED'
        ? 'Ready to start. Each agent will investigate a complementary perspective.'
        : control.swarm?.state === 'RUNNING'
          ? 'Agents are working. You can leave this page and return to their retained results.'
          : control.message;
    panel.append(el('p', 'event-detail', message));
  }
  if (control.issue) panel.append(el('p', 'blocker', control.issue));
  if (control.verifiedRevision)
    panel.append(
      el(
        'p',
        'event-detail',
        `Prepared revision ${control.verifiedRevision.slice(0, 12)}`,
      ),
    );
  if (control.planning) panel.append(renderGoalPlanning(control));
  if (control.implementation) panel.append(renderImplementation(task, control));
  if (control.swarm) {
    const limits = control.limits;
    panel.append(
      el(
        'p',
        'event-detail',
        `${limits.totalWorkers} agents · at most ${limits.maxConcurrency} running at once · ${Math.round(limits.timeoutMs / 1000)}s per attempt · at most 2 attempts each. Dollar usage is unavailable.`,
      ),
    );
    const swarm = control.swarm;
    panel.append(
      el(
        'p',
        'event-detail',
        `Execution: ${statusNames[swarm.state] ?? swarm.state.toLowerCase()}. Findings require coordinator review.`,
      ),
    );
    if (swarm.state === 'RECOVERY_REQUIRED')
      panel.append(
        el(
          'p',
          'blocker',
          'Supervisor ownership needs recovery. Ask Temari to reconcile retained process identity and artifacts before restarting work.',
        ),
      );
    panel.append(renderWorkerOutcomes(task, swarm.workers));
  }
  const actions = el('div', 'control-actions');
  const labels = {
    start: 'Start verification',
    observe: 'Check execution',
    resume: 'Resume run',
    cancel: 'Cancel run',
    verify: 'Verify evidence',
    'swarm-start': 'Start agents',
    'swarm-cancel': 'Cancel agents',
    'planner-start': 'Start planner',
    'prepare-plan': 'Prepare this plan',
    'implementation-start': 'Start implementers',
    'implementation-cancel': 'Cancel implementation',
  };
  for (const [action, label] of Object.entries(labels)) {
    if (!control.actions.includes(action)) continue;
    const button = el(
      'button',
      ['start', 'swarm-start', 'implementation-start'].includes(action)
        ? 'primary'
        : 'quiet',
      label,
    );
    button.disabled = state.mutating;
    button.addEventListener('click', () =>
      perform(
        task,
        action,
        action === 'prepare-plan'
          ? { proposalSha256: control.planning.proposalSha256 }
          : {},
      ),
    );
    actions.append(button);
  }
  panel.append(actions);
  const drafts = state.drafts.get(task.taskId) ?? {
    nextAction: task.nextAction ?? '',
    blocker: task.blocker ?? '',
    reason: '',
    baseVersion: task.version,
    dirty: new Set(),
  };
  if (!drafts.dirty.size) {
    drafts.nextAction = task.nextAction ?? '';
    drafts.blocker = task.blocker ?? '';
    drafts.baseVersion = task.version;
  }
  state.drafts.set(task.taskId, drafts);
  if (!control.implementation && control.actions.includes('accept')) {
    const review = el('div', 'acceptance');
    review.append(el('h4', '', 'Review the result'));
    review.append(
      el(
        'p',
        '',
        'Evidence passes. Confirm that the result satisfies this task’s goal.',
      ),
    );
    const reason = el('textarea');
    reason.rows = 3;
    reason.value = drafts.reason;
    reason.setAttribute('aria-label', 'Acceptance reason');
    reason.placeholder = 'Why does this result satisfy the goal?';
    reason.addEventListener('input', () => {
      drafts.reason = reason.value;
    });
    const accept = el('button', 'primary', 'Accept result');
    accept.disabled = state.mutating;
    accept.addEventListener('click', () => {
      if (!reason.value.trim()) {
        reason.focus();
        return;
      }
      perform(task, 'accept', { reason: reason.value.trim() });
    });
    review.append(reason, accept);
    panel.append(review);
  }
  if (control.actions.includes('update')) {
    const metadata = el('details', 'task-notes');
    metadata.append(el('summary', '', 'Update next action or blocker'));
    const conflict =
      drafts.dirty.size > 0 && drafts.baseVersion !== task.version;
    metadata.open = conflict || drafts.dirty.size > 0;
    const nextLabel = el('label', '', 'Next action');
    const next = el('textarea');
    next.rows = 2;
    next.value = drafts.nextAction;
    next.setAttribute('aria-label', 'Next action');
    next.addEventListener('input', () => {
      drafts.nextAction = next.value;
      drafts.dirty.add('nextAction');
    });
    nextLabel.append(next);
    const blockerLabel = el('label', '', 'Blocker');
    const blocker = el('textarea');
    blocker.rows = 2;
    blocker.value = drafts.blocker;
    blocker.setAttribute('aria-label', 'Blocker');
    blocker.addEventListener('input', () => {
      drafts.blocker = blocker.value;
      drafts.dirty.add('blocker');
    });
    blockerLabel.append(blocker);
    const save = el('button', 'quiet', 'Save update');
    save.disabled = state.mutating || conflict;
    save.addEventListener('click', () => {
      if (!drafts.dirty.size) return;
      perform(task, 'update', {
        expectedVersion: drafts.baseVersion,
        ...Object.fromEntries(
          [...drafts.dirty].map((field) => [
            field,
            drafts[field].trim() || null,
          ]),
        ),
      });
    });
    if (conflict) {
      metadata.append(
        el(
          'p',
          'blocker',
          'This task changed while you were editing. Review the latest values before saving your draft.',
        ),
      );
      metadata.append(
        el(
          'p',
          'event-detail',
          `Current next action: ${task.nextAction || '(empty)'}\nCurrent blocker: ${task.blocker || '(empty)'}`,
        ),
      );
      const keep = el('button', 'quiet', 'Keep my draft against this version');
      keep.addEventListener('click', () => {
        drafts.baseVersion = task.version;
        state.renderedDetail = null;
        renderDetail();
      });
      const discard = el('button', 'quiet', 'Discard my draft');
      discard.addEventListener('click', () => {
        state.drafts.delete(task.taskId);
        state.renderedDetail = null;
        renderDetail();
      });
      metadata.append(keep, discard);
    }
    metadata.append(nextLabel, blockerLabel, save);
    panel.append(metadata);
  }
  return panel;
}
function renderGoalPlanning(control) {
  const draft = control.planning;
  const panel = el('section', 'planning-result');
  panel.append(
    section('Goal plan', draft.policyId),
    badge(draft.state, draft.state === 'READY' ? 'Proposal ready' : undefined),
  );
  if (draft.integrityIssue)
    panel.append(el('p', 'blocker', draft.integrityIssue));
  if (!control.policyCurrent)
    panel.append(
      el(
        'p',
        'blocker',
        'Configured policy changed. Prepare a new goal against the current policy.',
      ),
    );
  if (draft.proposal) {
    panel.append(
      el('h3', '', draft.proposal.title),
      el('p', '', draft.proposal.summary),
    );
    const policy = state.dashboard.config.planning?.policies.find(
      (item) => item.id === draft.policyId,
    );
    for (const assignment of draft.proposal.assignments) {
      const row = el('div', 'plan-assignment');
      row.append(el('h4', '', assignment.slotId), el('p', '', assignment.goal));
      const slot = policy?.slots.find((item) => item.id === assignment.slotId);
      if (slot) row.append(ownershipList(slot.owns));
      const criteria = el('ul');
      for (const item of [
        ...new Set([
          ...(slot?.mandatoryCriteria ?? []),
          ...assignment.acceptanceCriteria,
        ]),
      ])
        criteria.append(el('li', '', item));
      row.append(criteria);
      panel.append(row);
    }
    panel.append(
      el(
        'p',
        'event-detail',
        'Independent implementers → integrate patches → configured checks → independent review. Dependent coding waves are not admitted by this policy.',
      ),
    );
    panel.append(el('p', 'artifact-path', `Proposal ${draft.proposalSha256}`));
  }
  const evidence = el('details');
  evidence.append(el('summary', '', 'Planner evidence'));
  for (const ref of draft.evidenceRefs)
    evidence.append(el('p', 'artifact-path', `${ref.path} · ${ref.sha256}`));
  if (!draft.evidenceRefs.length)
    evidence.append(
      el(
        'p',
        'event-detail',
        'Evidence is retained when the bounded planner call ends.',
      ),
    );
  panel.append(evidence);
  return panel;
}
const planningOptionPrefix = '__planning__:';
function selectedPlanningPolicy() {
  const value = byId('goal-recipe').value;
  return value.startsWith(planningOptionPrefix)
    ? state.dashboard.config.planning?.policies.find(
        (item) => item.id === value.slice(planningOptionPrefix.length),
      )
    : null;
}
const implementationOptionPrefix = '__implementation__:';
function selectedImplementationPlan() {
  const selection = byId('goal-recipe').value;
  if (!selection.startsWith(implementationOptionPrefix)) return null;
  return (
    state.dashboard.config.implementation?.plans.find(
      (plan) => plan.id === selection.slice(implementationOptionPrefix.length),
    ) ?? null
  );
}
function renderImplementationPreview(plan) {
  const preview = byId('implementation-preview');
  preview.replaceChildren();
  preview.hidden = !plan;
  if (!plan) return;
  const config = state.dashboard.config.implementation;
  preview.append(section('Configured implementation plan', plan.title));
  if (plan.description) preview.append(el('p', '', plan.description));
  preview.append(
    el(
      'p',
      'event-detail',
      `${plan.assignments.length} implementers · at most ${config.maxConcurrency} running at once · ${Math.round(config.timeoutMs / 1000)}s per attempt.`,
    ),
  );
  for (const assignment of plan.assignments) {
    const card = el('div', 'plan-assignment');
    card.append(
      el('h4', '', `${assignment.id} · implementer`),
      el('p', '', assignment.goal),
      ownershipList(assignment.owns),
    );
    preview.append(card);
  }
  const verification = el('div', 'plan-assignment');
  verification.append(el('h4', '', 'Combined verification'));
  for (const check of plan.verification)
    verification.append(
      el('p', 'artifact-path', [check.program, ...check.args].join(' ')),
    );
  preview.append(verification);
  const reviewer = el('div', 'plan-assignment');
  reviewer.append(
    el('h4', '', `${plan.reviewer.id} · independent reviewer`),
    el('p', '', plan.reviewer.goal),
  );
  preview.append(reviewer);
}
function selectGoalRecipe() {
  const swarm = byId('goal-recipe').value === '__swarm__';
  const implementation = selectedImplementationPlan();
  const planning = selectedPlanningPolicy();
  const recipe = state.dashboard.config.recipes.find(
    (item) => item.id === byId('goal-recipe').value,
  );
  byId('goal-title').value = recipe?.title ?? implementation?.title ?? '';
  byId('goal-text').value = recipe?.goal ?? '';
  byId('goal-title').readOnly = Boolean(recipe);
  byId('goal-text').readOnly = Boolean(recipe);
  byId('swarm-options').hidden = !swarm;
  renderImplementationPreview(
    planning
      ? {
          ...planning,
          assignments: planning.slots.map((slot) => ({
            id: slot.id,
            goal: slot.description,
            owns: slot.owns,
          })),
        }
      : implementation,
  );
  if (planning)
    byId('implementation-preview').firstChild.textContent =
      'Planning policy · ' + planning.title;
  byId('save-goal').textContent = planning
    ? 'Plan my goal'
    : implementation
      ? 'Prepare implementation'
      : swarm
        ? 'Prepare agents'
        : recipe
          ? 'Prepare verification'
          : 'Save goal';
  byId('goal-help').textContent = planning
    ? 'Temari reads the pinned clean workspace and proposes bounded assignments within this policy. Review the validated proposal, then prepare and start its parallel implementation.'
    : implementation
      ? 'Describe the overall goal for this configured plan. Each implementer works in an isolated workspace with the ownership shown above. Their patches are integrated, verified, and independently reviewed before Temari assesses the candidate.'
      : swarm
        ? 'Prepare 2–4 agents against a pinned, clean workspace. Review the task, then start the investigation.'
        : recipe
          ? 'This runs the configured checks against a pinned, clean workspace. Review the prepared task, then start it.'
          : 'Your goal will be saved with a continuation brief. Temari prepares the execution plan before work starts.';
}
function selectConcurrency() {
  const bound = Math.min(
    Number(byId('swarm-workers').value),
    state.dashboard.config.swarm.maxConcurrency,
  );
  const select = byId('swarm-concurrency');
  select.replaceChildren();
  for (let count = 1; count <= bound; count++) {
    const option = el('option', '', count);
    option.value = count;
    select.append(option);
  }
  select.value = String(bound);
}
byId('new-goal').addEventListener('click', () => {
  state.goalRequestId = crypto.randomUUID();
  const select = byId('goal-recipe');
  select.replaceChildren();
  const general = el('option', '', 'New goal for Temari');
  general.value = '';
  select.append(general);
  if (state.dashboard.config.swarm) {
    const option = el('option', '', 'Investigate with parallel agents');
    option.value = '__swarm__';
    select.append(option);
    const workers = byId('swarm-workers');
    workers.replaceChildren();
    for (
      let count = 2;
      count <= state.dashboard.config.swarm.maxWorkers;
      count++
    ) {
      const item = el('option', '', count);
      item.value = count;
      workers.append(item);
    }
    selectConcurrency();
  }
  for (const policy of state.dashboard.config.planning?.policies ?? []) {
    const option = el('option', '', `Let Temari plan · ${policy.title}`);
    option.value = `${planningOptionPrefix}${policy.id}`;
    select.append(option);
  }
  for (const plan of state.dashboard.config.implementation?.plans ?? []) {
    const option = el(
      'option',
      '',
      `Implement with parallel agents · ${plan.title}`,
    );
    option.value = `${implementationOptionPrefix}${plan.id}`;
    select.append(option);
  }
  for (const recipe of state.dashboard.config.recipes) {
    const option = el('option', '', recipe.title);
    option.value = recipe.id;
    select.append(option);
  }
  if (state.dashboard.config.planning?.policies.length)
    select.value = `${planningOptionPrefix}${state.dashboard.config.planning.policies[0].id}`;
  byId('goal-workspace').textContent = state.dashboard.config.workspaceRoot;
  byId('goal-error').hidden = true;
  selectGoalRecipe();
  byId('goal-dialog').showModal();
});
byId('close-goal').addEventListener('click', () => byId('goal-dialog').close());
byId('goal-recipe').addEventListener('change', () => {
  state.goalRequestId = crypto.randomUUID();
  selectGoalRecipe();
});
byId('swarm-workers').addEventListener('change', selectConcurrency);
byId('goal-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  byId('save-goal').disabled = true;
  try {
    const recipeId = byId('goal-recipe').value;
    const implementation = selectedImplementationPlan();
    const planning = selectedPlanningPolicy();
    const task = await post('/api/tasks', {
      requestId: state.goalRequestId,
      ...(planning
        ? {
            mode: 'planning',
            policyId: planning.id,
            title: byId('goal-title').value.trim(),
            goal: byId('goal-text').value.trim(),
          }
        : implementation
          ? {
              mode: 'implementation',
              planId: implementation.id,
              title: byId('goal-title').value.trim(),
              goal: byId('goal-text').value.trim(),
            }
          : recipeId === '__swarm__'
            ? {
                mode: 'swarm',
                title: byId('goal-title').value.trim(),
                goal: byId('goal-text').value.trim(),
                workerCount: Number(byId('swarm-workers').value),
                maxConcurrency: Number(byId('swarm-concurrency').value),
              }
            : recipeId
              ? { recipeId }
              : {
                  title: byId('goal-title').value.trim(),
                  goal: byId('goal-text').value.trim(),
                }),
    });
    state.selected = task.taskId;
    const url = new URL(location.href);
    url.searchParams.set('task', task.taskId);
    history.replaceState(null, '', url);
    state.filter = 'all';
    for (const button of document.querySelectorAll('[data-filter]'))
      button.setAttribute(
        'aria-pressed',
        String(button.dataset.filter === 'all'),
      );
    byId('goal-dialog').close();
    await refresh();
  } catch (error) {
    byId('goal-error').textContent = error.message;
    byId('goal-error').hidden = false;
  } finally {
    byId('save-goal').disabled = false;
  }
});
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
  if (!document.hidden && !state.mutating) {
    const task = state.tasks.find((item) => item.taskId === state.selected);
    const run = task?.runs.find((item) => item.runId === task.currentRunId);
    const control = state.dashboard?.config?.controls?.[task?.taskId];
    if (
      run?.nativeRef &&
      control?.actions.includes('observe') &&
      (!run.nativeSnapshot ||
        ['RUNNING', 'QUEUED'].includes(run.nativeSnapshot.status))
    )
      perform(task, 'observe');
    else refresh();
  }
}, 10000);
refresh();
