// Reconciliation records intent only. Tokens and unresolved requests stay in memory.
(() => {
  'use strict';
  const node = (id) => document.getElementById(id);
  const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
  const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
  const SHA = /^[a-f0-9]{64}$/u;
  const MAX_BYTES = 64 * 1024;
  const pending = new Map();
  const notices = new Map();
  const errors = new Map();
  const state = {
    configured: null, list: [], page: null, capabilities: {}, token: null,
    listLoading: null, listFresh: false, listError: '', setupReason: '',
    selected: null, detail: null, fresh: false, loading: false,
    generation: 0, request: 0, viewed: null,
  };
  const validId = (value) => typeof value === 'string' && ID.test(value);
  const validSha = (value) => typeof value === 'string' && SHA.test(value);
  const text = (value) => typeof value === 'string' ? value : '';
  const count = (value) => Number.isSafeInteger(value) && value >= 0;
  const reference = (value) => value?.schema === 1 && validId(value.id) && validSha(value.sha256) &&
    count(value.bytes) && typeof value.mediaType === 'string';
  const human = (value) => text(value).replaceAll('-', ' ').replaceAll('_', ' ');
  const stamp = (value) => {
    if (typeof value !== 'string' || !value) return 'Time unavailable';
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? 'Time unavailable' : date.toLocaleString();
  };
  const make = (tag, className = '', value = '') => {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = value;
    return element;
  };
  const problem = (message, status = 0, uncertain = false) =>
    Object.assign(new Error(message), { status, uncertain });
  function path(id, action) {
    if (!validId(id)) throw problem('Enter a valid retained attempt ID.');
    return '/api/reconciliation/' + encodeURIComponent(id) + '/' + action;
  }
  async function request(url, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST', cache: 'no-store', signal: controller.signal,
        headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-temari-token': state.token },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      let result;
      try { result = await response.json(); }
      catch { throw problem('The response could not be read. Reload retained state.', response.status, body !== undefined); }
      if (!response.ok) {
        if (response.status === 403) state.token = null;
        throw problem(text(result.error) || 'The request was refused.', response.status,
          body !== undefined && response.status >= 500);
      }
      return result;
    } catch (cause) {
      if (typeof cause?.uncertain === 'boolean') throw cause;
      throw problem(cause?.name === 'AbortError' ? 'The request timed out. Reload retained state.' :
        'The server could not be reached. Reload retained state.', 0, body !== undefined);
    } finally { clearTimeout(timeout); }
  }
  async function token() {
    if (state.token) return;
    const result = await request('/api/dashboard');
    if (!text(result.csrfToken)) throw problem('This dashboard does not admit reconciliation changes.');
    state.token = result.csrfToken;
  }
  function taskLink(taskId, label) {
    if (typeof taskId !== 'string' || !TASK_ID.test(taskId))
      return make('span', 'event-detail', 'Task identity unavailable');
    const link = make('a', '', label);
    const url = new URL(location.href);
    url.searchParams.set('view', 'tasks');
    url.searchParams.set('task', taskId);
    url.searchParams.delete('topic');
    link.href = url.pathname + url.search;
    link.addEventListener('click', (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (!window.dispatchEvent(new CustomEvent('temari-open-task', { detail: { taskId }, cancelable: true })))
        event.preventDefault();
    });
    return link;
  }
  function validateList(data) {
    if (typeof data?.configured !== 'boolean' || !Array.isArray(data.attempts) ||
      data.attempts.length > 50 || data.attempts.some((item) => !validId(item.attemptId)) ||
      new Set(data.attempts.map((item) => item.attemptId)).size !== data.attempts.length ||
      !count(data.page?.total) || !count(data.page?.omitted) ||
      data.page.total !== data.attempts.length + data.page.omitted || data.page.limit !== 50)
      throw problem('The retained attempt list is unavailable. Reload before using controls.');
    return data;
  }
  function validateReview(data, id) {
    if (data?.schema !== 1 || data.attempt?.attemptId !== id ||
      typeof data.review?.complete !== 'boolean' || !data.capabilities ||
      !['not-checked', 'matched', 'drift', 'unavailable'].includes(data.currentBinding?.state) ||
      !Array.isArray(data.currentBinding.changedFields))
      throw problem('The selected review response is unavailable. Reload before using controls.');
    if (data.review.complete) {
      const payload = data.review.payload;
      if (!validSha(data.review.sha256) || payload?.schema !== 1 || payload.attemptId !== id ||
        data.admission?.hostSelected !== true ||
        !payload.binding || !payload.plan || !payload.observation || !payload.scope ||
        payload.binding.taskId !== data.attempt.taskId || payload.binding.runId !== data.attempt.runId ||
        payload.binding.candidateId !== data.attempt.candidate?.id ||
        payload.binding.candidateSha256 !== data.attempt.candidate?.sha256 ||
        payload.binding.observationId !== payload.observation.observationId ||
        !text(payload.binding.taskVersion) || !text(payload.binding.revision) || !validSha(payload.binding.scopeSha256) ||
        !validId(payload.plan.planId) || !validId(payload.observation.observationId) ||
        !validSha(payload.plan.request?.canonicalRequestSha256) ||
        payload.plan.request.canonicalRequestDigestAlgorithm !== 'canonical-json-sha256-v1' ||
        !['sourceRoot', 'candidateRoot', 'baseHead', 'operationHead'].every((key) =>
          validId(payload.scope[key]?.id) && validSha(payload.scope[key]?.sha256)) ||
        !Array.isArray(payload.scope.affectedPaths) || !payload.scope.affectedPaths.length || payload.scope.affectedPaths.length > 128 ||
        payload.scope.affectedPaths.some((entry) => typeof entry.path !== 'string' ||
          !Array.isArray(entry.indexBlobs) || !Array.isArray(entry.unmergedStages) ||
          [...entry.indexBlobs, ...entry.unmergedStages].some((item) =>
            !item || !Number.isSafeInteger(item.stage) || typeof item.mode !== 'string' || typeof item.objectId !== 'string')) ||
        !Array.isArray(payload.scope.requiredChecks) || !Array.isArray(payload.plan.actions) ||
        !Array.isArray(payload.plan.evidence) || !Array.isArray(payload.observation.evidence) ||
        payload.scope.requiredChecks.some((item) => !item || !validId(item.id) || !validSha(item.definitionSha256)) ||
        payload.plan.actions.some((item) => !item || !validId(item.id) || !validId(item.targetId) || !['preserve', 'integrate'].includes(item.kind)) ||
        [...payload.plan.evidence, ...payload.observation.evidence].some((item) => !reference(item)) ||
        !reference(payload.scope.expectedComparison?.candidateEvidence) ||
        !reference(payload.scope.expectedComparison?.verificationEvidence) ||
        new TextEncoder().encode(JSON.stringify(payload)).length > MAX_BYTES)
        throw problem('The review is incomplete or too large for this panel. Confirmation is disabled.');
    }
    return data;
  }
  function matchesSaved(operation, detail) {
    const saved = detail.confirmation;
    return operation?.kind === 'confirm' && saved?.requestId === operation.body.requestId &&
      saved.planId === operation.planId && saved.observationId === operation.observationId &&
      saved.canonicalRequestSha256 === operation.canonicalRequestSha256;
  }
  function validatePostReview(data, id) {
    try { return validateReview(data, id); }
    catch {
      // The host may have persisted intent before emitting an invalid DTO.
      // Retain the exact request; a recovery GET or explicit retry must decide it.
      throw problem('The host response could not be validated. Reload retained state or retry only the exact request.', 0, true);
    }
  }
  function reconcileSaved(id, detail) {
    const operation = pending.get(id);
    if (!operation || operation.state === 'submitting' || operation.state === 'preparing') return;
    if (matchesSaved(operation, detail)) {
      pending.delete(id); errors.delete(id);
      notices.set(id, 'The exact saved request is confirmed: confirmation intent was recorded.');
    }
  }
  function row(target, label, value) {
    const item = make('div', 'reconciliation-field');
    item.append(make('dt', '', label), make('dd', '', text(value) || 'Not available'));
    target.append(item);
  }
  function evidence(target, label, values) {
    const section = make('section', 'reconciliation-evidence');
    section.append(make('h4', '', label));
    for (const ref of values) {
      const line = make('p');
      line.append(make('strong', '', text(ref.id) + ' '),
        make('span', '', text(ref.sha256) + ' · ' + String(ref.bytes) + ' bytes · ' + text(ref.mediaType)));
      section.append(line);
    }
    if (!values.length) section.append(make('p', 'event-detail', 'No references retained.'));
    target.append(section);
  }
  function renderMetadata(detail) {
    const target = node('reconciliation-metadata-body');
    target.replaceChildren();
    const payload = detail.review.payload;
    if (!detail.review.complete || !payload) {
      target.append(make('p', 'event-detail', human(detail.review.reasonCode) || 'A complete host-selected review is unavailable.'));
      return;
    }
    const fields = make('dl', 'reconciliation-fields');
    row(fields, 'Plan', payload.plan.planId);
    row(fields, 'Review digest', detail.review.sha256);
    row(fields, 'Observation', payload.observation.observationId);
    row(fields, 'Observed', stamp(payload.observation.observedAt));
    row(fields, 'Observation kind', human(payload.observation.kind));
    row(fields, 'Task / version', payload.binding.taskId + ' / ' + payload.binding.taskVersion);
    row(fields, 'Run / revision', payload.binding.runId + ' / ' + payload.binding.revision);
    row(fields, 'Scope digest', payload.binding.scopeSha256);
    row(fields, 'Candidate', payload.binding.candidateId + ' · ' + payload.binding.candidateSha256);
    for (const key of ['sourceRoot', 'candidateRoot', 'baseHead', 'operationHead'])
      row(fields, human(key.replace(/([A-Z])/g, ' $1').toLowerCase()), payload.scope[key].id + ' · ' + payload.scope[key].sha256);
    row(fields, 'Resolution intent', human(payload.scope.resolutionIntent));
    row(fields, 'Request digest algorithm', payload.plan.request.canonicalRequestDigestAlgorithm);
    row(fields, 'Retained declared request digest', payload.plan.request.canonicalRequestSha256);
    target.append(make('p', '', text(payload.plan.summary)), fields,
      make('p', 'event-detail', 'Check definitions and comparison references are requirements, not successful results. These identities do not prove candidate verification or source preservation.'));
    const actions = make('section');
    actions.append(make('h4', '', 'Proposed actions'));
    for (const action of payload.plan.actions)
      actions.append(make('p', '', text(action.id) + ' · ' + human(action.kind) + ' · target ' + text(action.targetId)));
    target.append(actions);
    const paths = make('section');
    paths.append(make('h4', '', 'Selected affected paths (' + payload.scope.affectedPaths.length + ')'));
    for (const entry of payload.scope.affectedPaths) {
      const box = make('details', 'reconciliation-path');
      box.append(make('summary', '', text(entry.path) + ' · ' + human(entry.classification)));
      const identities = make('dl', 'reconciliation-fields');
      row(identities, 'Path digest', entry.pathSha256);
      row(identities, 'Worktree kind / digest', text(entry.worktreeKind) + ' / ' + (text(entry.worktreeSha256) || 'none'));
      row(identities, 'Diff digest', entry.diffSha256);
      for (const [label, stages] of [['Index', entry.indexBlobs], ['Unmerged', entry.unmergedStages]])
        row(identities, label + ' stages', stages.map((item) => String(item.stage) + ' ' + text(item.mode) + ' ' + text(item.objectId)).join(' · ') || 'none');
      box.append(identities); paths.append(box);
    }
    target.append(paths);
    const checks = make('section');
    checks.append(make('h4', '', 'Required checks'));
    for (const check of payload.scope.requiredChecks)
      checks.append(make('p', '', text(check.id) + ' · definition ' + text(check.definitionSha256)));
    target.append(checks);
    evidence(target, 'Observation evidence identities', payload.observation.evidence);
    evidence(target, 'Plan evidence identities', payload.plan.evidence);
    evidence(target, 'Expected comparison identities', [
      payload.scope.expectedComparison.candidateEvidence, payload.scope.expectedComparison.verificationEvidence,
    ]);
  }
  function renderList() {
    const target = node('reconciliation-attempt-list');
    target.replaceChildren();
    for (const item of state.list) {
      const button = make('button', 'reconciliation-attempt');
      button.type = 'button'; button.dataset.reconciliationAttemptId = item.attemptId;
      button.setAttribute('aria-current', String(state.selected === item.attemptId));
      button.append(make('strong', '', item.attemptId),
        make('span', 'event-detail', human(item.state) + (item.confirmationRecorded ? ' · historic confirmation recorded' : '')),
        make('span', 'event-detail', item.hostSelectedForReview ? 'Host-selected for review' : 'Not selected for browser review'));
      if (item.hostSelectedForReview && text(item.summary))
        button.append(make('span', '', text(item.summary).slice(0, 512) + (item.summaryTruncated ? '…' : '')));
      button.addEventListener('click', () => select(item.attemptId));
      target.append(button);
    }
    if (!state.list.length) target.append(make('p', 'event-detail', state.listLoading ?
      'Reading retained attempts…' : state.configured ? 'No attempts in this retained listing. The host prepares new attempts.' : 'Retained attempts are unavailable in this setup.'));
    node('reconciliation-status').textContent = state.listError || (state.listLoading ?
      'Reading retained attempts…' : state.configured === null ? 'Reconciliation setup has not been checked.' :
        !state.configured ? state.setupReason || 'Reconciliation is not configured.' :
          state.list.length + ' retained attempt' + (state.list.length === 1 ? '' : 's') + ' shown.');
    node('reconciliation-coverage').hidden = !state.page?.omitted;
    node('reconciliation-coverage').textContent = state.page?.omitted ?
      'Showing ' + state.list.length + ' of ' + state.page.total + ' retained attempts; ' + state.page.omitted +
      ' older attempts omitted. Use an exact retained attempt ID to review an older record.' : '';
    node('refresh-reconciliation').disabled = Boolean(state.listLoading);
    node('reconciliation-lookup-button').disabled = !state.configured || !state.listFresh;
  }
  function canConfirm() {
    const detail = state.detail;
    return state.listFresh && state.configured && state.fresh && !state.loading &&
      detail?.admission?.hostSelected && detail.review.complete && validSha(detail.review.sha256) &&
      detail.capabilities.canRecordConfirmationIntent && state.capabilities.canRecordConfirmationIntent &&
      detail.attempt.retainedStatus === 'PENDING' && detail.attempt.state === 'awaiting-confirmation' &&
      detail.attempt.classification === 'requires-confirmation' && !detail.confirmation &&
      detail.currentBinding.state !== 'unavailable' &&
      state.viewed === detail.review.sha256 && !pending.has(state.selected);
  }
  function renderDetail() {
    const detail = state.detail;
    const operation = pending.get(state.selected);
    node('reconciliation-selected-title').textContent = state.selected || 'Select a retained attempt';
    node('reconciliation-detail').hidden = !state.selected;
    node('reconciliation-reload-review').disabled = !state.selected || state.loading;
    node('reconciliation-review-status').textContent = state.loading ? 'Reading the retained review…' :
      detail ? human(detail.attempt.state) + ' · ' + human(detail.attempt.classification) + ' · candidate not ready' :
        state.selected ? 'The retained review is unavailable.' : '';
    node('reconciliation-review-error').textContent = errors.get(state.selected) || '';
    node('reconciliation-review-error').hidden = !errors.get(state.selected);
    node('reconciliation-mutation-status').textContent = operation?.state === 'preparing' ? 'Preparing the local request…' :
      operation?.state === 'submitting' ? 'Waiting for the host response…' :
        operation?.state === 'uncertain' ? 'The response was lost. Nothing is automatically resent. Reload retained state or deliberately retry the same request.' :
          notices.get(state.selected) || '';
    node('reconciliation-retry').hidden = operation?.state !== 'uncertain';
    node('reconciliation-retry').disabled = !state.configured || !state.listFresh || state.loading;
    node('reconciliation-retry').textContent = operation?.kind === 'check' ? 'Repeat the current binding check' : 'Retry the same confirmation request';
    node('reconciliation-check').disabled = !state.configured || !state.listFresh || !state.fresh || state.loading ||
      !detail?.capabilities.canCheckCurrentBinding || !state.capabilities.canCheckCurrentBinding || Boolean(operation);
    node('reconciliation-confirm').disabled = !canConfirm();
    node('reconciliation-metadata').hidden = !detail?.review.complete;
    node('reconciliation-task-link').replaceChildren();
    node('reconciliation-binding-status').textContent = '';
    node('reconciliation-confirmation-status').replaceChildren();
    if (!detail) { node('reconciliation-metadata-body').replaceChildren(); return; }
    node('reconciliation-task-link').append(taskLink(detail.attempt.taskId, 'Open task ' + detail.attempt.taskId),
      make('span', 'event-detail', ' · retained run ' + text(detail.attempt.runId)));
    const binding = detail.currentBinding;
    node('reconciliation-binding-status').textContent = binding.state === 'not-checked' ?
      'Current binding not checked by this read. Confirmation always checks again.' :
        'Binding ' + human(binding.state) + ' · ' + stamp(binding.beganAt) + ' to ' + stamp(binding.endedAt) +
        (binding.changedFields?.length ? ' · changed: ' + binding.changedFields.map(human).join(', ') : '') +
        (binding.reasonCode ? ' · ' + human(binding.reasonCode) : '') +
        '. This observation does not establish an exclusive writer.';
    if (detail.attempt.state === 'blocked')
      node('reconciliation-confirmation-status').append(make('p', 'blocker',
        text(detail.attempt.blockedReason) || 'This retained attempt is blocked. The host must prepare a fresh attempt.'));
    if (detail.confirmation) {
      const saved = detail.confirmation;
      node('reconciliation-confirmation-status').append(make('p', '', 'Historic confirmation intent recorded · ' +
        text(saved.confirmationId) + ' · ' + stamp(saved.confirmedAt)),
      make('p', 'event-detail', (saved.requestId ? 'Local request ' + saved.requestId : 'External retained record; no local request identity') +
        ' · ' + human(saved.actorKind)));
    }
    if (!detail.admission?.hostSelected || !detail.review.complete)
      node('reconciliation-confirmation-status').append(make('p', 'event-detail',
        human(detail.admission?.reasonCode || detail.review.reasonCode) || 'A complete host-selected review is required to record intent.'));
    else if (state.viewed !== detail.review.sha256 && !detail.confirmation)
      node('reconciliation-confirmation-status').append(make('p', 'event-detail', 'Open the complete metadata review before recording confirmation intent.'));
    renderMetadata(detail);
  }
  function render() { renderList(); renderDetail(); }
  async function loadList() {
    if (state.listLoading) return state.listLoading;
    state.listError = '';
    state.listLoading = (async () => {
      try {
        const data = validateList(await request('/api/reconciliation'));
        state.configured = data.configured; state.listFresh = true;
        state.list = data.configured ? data.attempts : []; state.page = data.page;
        state.capabilities = data.capabilities || {}; state.setupReason = text(data.setupReason);
        if (!data.configured) { state.detail = null; state.fresh = false; state.viewed = null; }
      } catch (cause) {
        state.list = []; state.page = null; state.listFresh = false; state.capabilities = {};
        state.detail = null; state.fresh = false; state.viewed = null; state.listError = cause.message;
      } finally { state.listLoading = null; render(); }
    })();
    render();
    return state.listLoading;
  }
  async function loadReview(id = state.selected, options = {}) {
    if (!validId(id)) return;
    const generation = state.generation;
    const sequence = ++state.request;
    if (id === state.selected) { state.loading = true; state.fresh = false; renderDetail(); }
    try {
      const detail = validateReview(await request(path(id, 'review')), id);
      reconcileSaved(id, detail);
      if (generation !== state.generation || sequence !== state.request || id !== state.selected) return;
      if (state.detail?.review.sha256 !== detail.review.sha256) {
        state.viewed = null; node('reconciliation-metadata').open = false;
      }
      state.detail = detail; state.fresh = true;
      if (options.deliberate && !pending.has(id)) errors.delete(id);
    } catch (cause) {
      if (generation !== state.generation || sequence !== state.request || id !== state.selected) return;
      state.detail = null; state.fresh = false; state.viewed = null; errors.set(id, cause.message);
    } finally {
      if (generation === state.generation && sequence === state.request && id === state.selected) {
        state.loading = false; renderDetail();
      }
    }
  }
  async function select(id) {
    if (!validId(id)) {
      node('reconciliation-lookup-error').textContent = 'Enter a valid retained attempt ID.';
      node('reconciliation-lookup-error').hidden = false; return;
    }
    node('reconciliation-lookup-error').hidden = true;
    state.generation++; state.selected = id; state.detail = null; state.fresh = false;
    state.viewed = null; node('reconciliation-metadata').open = false;
    render();
    await loadReview(id);
  }
  async function mutate(operation) {
    const id = operation.id;
    if (pending.get(id) !== operation) return;
    operation.state = 'preparing'; errors.delete(id); renderDetail();
    try {
      await token();
      operation.state = 'submitting'; renderDetail();
      const data = await request(path(id, operation.kind === 'confirm' ? 'confirm-reviewed' : 'check-current-binding'), operation.body);
      if (operation.kind === 'confirm') {
        if (data.requestId !== operation.body.requestId || !['recorded', 'replayed', 'blocked', 'refused'].includes(data.outcome))
          throw problem('The confirmation response did not identify this request. Reload retained state.', 0, true);
        validatePostReview(data.review, id);
        if (['recorded', 'replayed'].includes(data.outcome) && !matchesSaved(operation, data.review))
          throw problem('The saved confirmation did not match this request. Reload retained state.', 0, true);
        pending.delete(id);
        notices.set(id, data.outcome === 'blocked' ? 'The current binding changed; confirmation was blocked.' :
          data.outcome === 'refused' ? 'Confirmation intent was refused: ' + human(data.reasonCode) :
            'Confirmation intent recorded' + (data.outcome === 'replayed' ? ' (exact saved request).' : '.'));
        if (id === state.selected) { state.detail = data.review; state.fresh = true; }
      } else {
        validatePostReview(data, id); pending.delete(id);
        notices.set(id, data.attempt.state === 'blocked' ? 'The binding check retained this attempt as blocked.' :
          data.currentBinding.state === 'unavailable' ? 'The current binding could not be observed.' : 'The binding check finished.');
        if (id === state.selected) { state.detail = data; state.fresh = true; }
      }
      // Ignore any older in-flight GET so it cannot replace this mutation result.
      if (id === state.selected) { state.request++; state.loading = false; }
      await loadList();
    } catch (cause) {
      if (cause.uncertain) operation.state = 'uncertain';
      else pending.delete(id);
      errors.set(id, cause.message);
      if (id === state.selected) { state.fresh = false; renderDetail(); }
      // Read recovery is safe; no confirmation or check is automatically resent.
      if (id === state.selected) await loadReview(id);
    } finally { if (id === state.selected) render(); }
  }
  function startCheck() {
    if (node('reconciliation-check').disabled || !state.selected || pending.has(state.selected)) return;
    const operation = { id: state.selected, kind: 'check', state: 'preparing', body: {} };
    pending.set(operation.id, operation); mutate(operation);
  }
  function startConfirmation() {
    if (!canConfirm()) return;
    const payload = state.detail.review.payload;
    const operation = {
      id: state.selected, kind: 'confirm', state: 'preparing',
      body: { requestId: crypto.randomUUID(), reviewSha256: state.detail.review.sha256 },
      planId: payload.plan.planId, observationId: payload.observation.observationId,
      canonicalRequestSha256: payload.plan.request.canonicalRequestSha256,
    };
    pending.set(operation.id, operation); mutate(operation);
  }
  async function activate() {
    await loadList();
    if (state.configured && state.selected) await loadReview();
  }
  node('refresh-reconciliation').addEventListener('click', activate);
  node('reconciliation-reload-review').addEventListener('click', () => loadReview(state.selected, { deliberate: true }));
  node('reconciliation-lookup-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!node('reconciliation-lookup-button').disabled) select(node('reconciliation-attempt-id').value.trim());
  });
  node('reconciliation-metadata').addEventListener('toggle', () => {
    if (node('reconciliation-metadata').open && state.fresh && state.detail?.review.complete)
      state.viewed = state.detail.review.sha256;
    renderDetail();
  });
  node('reconciliation-check').addEventListener('click', startCheck);
  node('reconciliation-confirm').addEventListener('click', startConfirmation);
  node('reconciliation-retry').addEventListener('click', () => {
    const operation = pending.get(state.selected);
    if (!node('reconciliation-retry').disabled && operation?.state === 'uncertain') mutate(operation);
  });
  window.TemariReconciliationUI = { activate };
  render();
})();
