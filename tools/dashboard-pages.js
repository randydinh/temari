// Additional workspace views use only server-admitted identities.
const pages = {
  view: 'tasks',
  knowledge: null,
  schedules: null,
  selectedNode: null,
  loading: false,
  scheduleRequestId: null,
};
async function readDashboardJson(path) {
  const response = await fetch(path, { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error ?? 'Dashboard data is unavailable.');
  return data;
}
function pageError(error) {
  byId('error').textContent = error.message;
  byId('error').hidden = false;
}
async function selectDashboardView(view, updateUrl = true) {
  pages.view = ['tasks', 'schedules', 'knowledge'].includes(view)
    ? view
    : 'tasks';
  for (const button of document.querySelectorAll('[data-view]'))
    button.setAttribute(
      'aria-pressed',
      String(button.dataset.view === pages.view),
    );
  for (const key of ['tasks', 'schedules', 'knowledge'])
    byId(`${key}-page`).hidden = key !== pages.view;
  if (updateUrl) {
    const url = new URL(location.href);
    url.searchParams.set('view', pages.view);
    history.replaceState(null, '', url);
  }
  if (pages.view === 'knowledge') await loadKnowledge();
  if (pages.view === 'schedules') await loadSchedules();
}
for (const button of document.querySelectorAll('[data-view]'))
  button.addEventListener('click', () =>
    selectDashboardView(button.dataset.view).catch(pageError),
  );
window.addEventListener('popstate', () =>
  selectDashboardView(
    new URL(location.href).searchParams.get('view'),
    false,
  ).catch(pageError),
);
function mapQualifiers(qualifiers) {
  return (qualifiers ?? [])
    .map((value) => String(value).replaceAll('-', ' '))
    .join(' · ');
}
async function loadKnowledge() {
  byId('knowledge-status').textContent =
    'Checking configured Registrar publications…';
  try {
    pages.knowledge = await readDashboardJson('/api/knowledge');
    const kinds = [
      ...new Set(pages.knowledge.nodes.map((node) => node.kind)),
    ].sort();
    const selected = byId('map-kind').value;
    byId('map-kind').replaceChildren(el('option', '', 'All node types'));
    byId('map-kind').firstChild.value = '';
    for (const kind of kinds) {
      const option = el('option', '', kind);
      option.value = kind;
      byId('map-kind').append(option);
    }
    byId('map-kind').value = kinds.includes(selected) ? selected : '';
    renderKnowledge();
    if (
      pages.selectedNode &&
      pages.knowledge.nodes.some((node) => node.id === pages.selectedNode)
    )
      await selectKnowledgeNode(pages.selectedNode);
  } catch (error) {
    byId('knowledge-status').textContent = 'Map unavailable';
    pageError(error);
  }
}
function renderKnowledge() {
  const map = pages.knowledge;
  if (!map) return;
  const coverage = map.coverage;
  byId('knowledge-status').textContent =
    map.state === 'not-configured'
      ? 'No pinned publications configured.'
      : `${map.state} · ${map.nodes.length} nodes · ${map.edges.length} relationships${coverage ? ` · ${coverage.documentsReturned}/${coverage.documentsKnown} documents` : ''} · historical archive · current originals not checked${coverage?.truncated ? ' · bounded view' : ''}`;
  const needle = byId('map-search').value.trim().toLowerCase();
  const kind = byId('map-kind').value;
  const nodes = map.nodes.filter(
    (node) =>
      (!kind || node.kind === kind) &&
      (!needle ||
        node.label.toLowerCase().includes(needle) ||
        node.kind.includes(needle)),
  );
  const list = byId('knowledge-nodes');
  list.replaceChildren();
  for (const node of nodes) {
    const button = el(
      'button',
      `map-node-button${node.id === pages.selectedNode ? ' selected' : ''}`,
    );
    button.append(
      el('span', 'eyebrow', node.kind),
      el('span', 'node-label', node.label),
    );
    button.setAttribute('aria-pressed', String(node.id === pages.selectedNode));
    button.addEventListener('click', () =>
      selectKnowledgeNode(node.id).catch(pageError),
    );
    list.append(button);
  }
  if (!nodes.length)
    list.append(
      el(
        'p',
        'event-detail',
        map.state === 'not-configured'
          ? 'Configure explicit, pinned Registrar publications to see their paths and records.'
          : 'No nodes match this filter.',
      ),
    );
  const canvas = byId('knowledge-map');
  canvas.replaceChildren();
  if (nodes.length) {
    const visible = nodes.slice(0, 60);
    const groups = [
      'source',
      'publication',
      'path',
      'document',
      'graph',
      'entity',
      'assertion',
      'mention',
      'provenance',
      'gap',
    ].filter((type) => visible.some((node) => node.kind === type));
    const width = Math.max(720, groups.length * 220);
    const height = Math.max(
      260,
      ...groups.map(
        (type) => visible.filter((node) => node.kind === type).length * 62 + 74,
      ),
    );
    const svgNode = (tag, attributes = {}) => {
      const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [key, value] of Object.entries(attributes))
        node.setAttribute(key, String(value));
      return node;
    };
    const svg = svgNode('svg', {
      viewBox: `0 0 ${width} ${height}`,
      width,
      height,
      role: 'img',
      'aria-label':
        'Recorded source relationships; select a node below for details',
    });
    const positions = new Map();
    groups.forEach((type, column) => {
      const label = svgNode('text', {
        x: column * 220 + 20,
        y: 26,
        class: 'map-column-title',
      });
      label.textContent = type;
      svg.append(label);
      visible
        .filter((node) => node.kind === type)
        .forEach((node, row) =>
          positions.set(node.id, { x: column * 220 + 20, y: row * 62 + 46 }),
        );
    });
    for (const edge of map.edges) {
      const from = positions.get(edge.source),
        to = positions.get(edge.target);
      if (!from || !to) continue;
      const path = svgNode('path', {
        d: `M ${from.x + 178} ${from.y + 21} C ${from.x + 210} ${from.y + 21}, ${to.x - 32} ${to.y + 21}, ${to.x} ${to.y + 21}`,
        class: 'map-edge',
        tabindex: 0,
        role: 'button',
        'aria-label': `Relationship: ${edge.kind}`,
      });
      path.addEventListener('click', () =>
        selectKnowledgeNode(edge.source, edge.id).catch(pageError),
      );
      path.addEventListener('keydown', (event) => {
        if (['Enter', ' '].includes(event.key)) {
          event.preventDefault();
          selectKnowledgeNode(edge.source, edge.id).catch(pageError);
        }
      });
      const title = svgNode('title');
      title.textContent = `${edge.kind} · ${mapQualifiers(edge.qualifiers)}`;
      path.append(title);
      svg.append(path);
    }
    for (const node of visible) {
      const point = positions.get(node.id);
      const group = svgNode('g', {
        transform: `translate(${point.x},${point.y})`,
        class: `map-graphic-node ${node.id === pages.selectedNode ? 'selected' : ''}`,
        tabindex: 0,
        role: 'button',
        'aria-label': `${node.kind}: ${node.label}`,
      });
      group.append(svgNode('rect', { width: 178, height: 42, rx: 8 }));
      const title = svgNode('title');
      title.textContent = node.label;
      group.append(title);
      const text = svgNode('text', { x: 10, y: 25 });
      text.textContent =
        node.label.length > 23 ? `${node.label.slice(0, 22)}…` : node.label;
      group.append(text);
      group.addEventListener('click', () =>
        selectKnowledgeNode(node.id).catch(pageError),
      );
      group.addEventListener('keydown', (event) => {
        if (['Enter', ' '].includes(event.key)) {
          event.preventDefault();
          selectKnowledgeNode(node.id).catch(pageError);
        }
      });
      svg.append(group);
    }
    canvas.append(svg);
    if (nodes.length > visible.length)
      canvas.append(
        el(
          'p',
          'event-detail',
          `Drawing ${visible.length} of ${nodes.length} returned nodes. Use the list or filters to inspect the rest.`,
        ),
      );
  }
  const gaps = byId('knowledge-gaps');
  gaps.replaceChildren();
  if (map.gaps?.length) {
    gaps.append(section('Coverage gaps', `${map.gaps.length} reported`));
    for (const gap of map.gaps)
      gaps.append(
        el(
          'p',
          'blocker',
          `${gap.subject ?? gap.kind ?? 'Configuration'}: ${gap.detail ?? gap.reason}`,
        ),
      );
  }
}
async function selectKnowledgeNode(nodeId, edgeId = null) {
  const detail = await readDashboardJson(
    `/api/knowledge/node?node=${encodeURIComponent(nodeId)}`,
  );
  pages.selectedNode = nodeId;
  renderKnowledge();
  const panel = byId('knowledge-detail');
  panel.replaceChildren();
  panel.append(
    el('span', 'eyebrow', detail.node.kind),
    el('h2', '', detail.node.label),
    badge(detail.state),
    el('p', 'event-detail', mapQualifiers(detail.node.qualifiers)),
  );
  const expand = el('button', 'quiet', 'Expand connected records');
  expand.addEventListener('click', async () => {
    expand.disabled = true;
    try {
      pages.knowledge = await readDashboardJson(
        `/api/knowledge/expand?node=${encodeURIComponent(nodeId)}`,
      );
      renderKnowledge();
    } catch (error) {
      pageError(error);
    } finally {
      expand.disabled = false;
    }
  });
  panel.append(expand, section('Provenance'));
  for (const anchor of detail.node.anchors ?? []) {
    const row = el('div', 'provenance-card');
    const source =
      anchor.source?.sourceId ??
      anchor.source?.id ??
      anchor.source?.name ??
      'Registered source';
    row.append(
      el('p', '', `${anchor.role} · ${source}`),
      el('p', 'artifact-path', anchor.path ?? ''),
      el(
        'p',
        'event-detail',
        `Generation ${anchor.generation}\nManifest ${anchor.manifestSha256}\nPublication ${anchor.publicationId}`,
      ),
    );
    if (anchor.span)
      row.append(
        el(
          'p',
          'event-detail',
          `Span ${anchor.span.start}–${anchor.span.end} (${anchor.span.unit})`,
        ),
      );
    panel.append(row);
  }
  if (!detail.node.anchors?.length)
    panel.append(
      el('p', 'event-detail', 'No source anchor attached to this node.'),
    );
  panel.append(section('Connected relationships'));
  for (const edge of detail.edges ?? []) {
    const relationship = el('details', 'relationship-detail');
    relationship.open = edge.id === edgeId;
    relationship.append(
      el('summary', '', edge.kind),
      el('p', 'event-detail', mapQualifiers(edge.qualifiers)),
    );
    for (const anchor of edge.anchors ?? []) {
      relationship.append(
        el(
          'p',
          'artifact-path',
          `${anchor.role} · ${anchor.path ?? anchor.source?.sourceId ?? 'Registered source'}\nGeneration ${anchor.generation}\nManifest ${anchor.manifestSha256}\nPublication ${anchor.publicationId}${anchor.span ? `\nSpan ${anchor.span.start}–${anchor.span.end} (${anchor.span.unit})` : ''}`,
        ),
      );
    }
    if (!edge.anchors?.length)
      relationship.append(
        el(
          'p',
          'event-detail',
          'No source anchor attached to this relationship.',
        ),
      );
    panel.append(relationship);
  }
  if (Object.keys(detail.metadata ?? {}).length) {
    const metadata = el('details');
    metadata.append(
      el('summary', '', 'Recorded metadata'),
      el('pre', 'metadata-preview', JSON.stringify(detail.metadata, null, 2)),
    );
    panel.append(metadata);
  }
  for (const gap of detail.gaps ?? [])
    panel.append(el('p', 'blocker', gap.detail ?? gap.reason));
}
byId('map-search').addEventListener('input', renderKnowledge);
byId('map-kind').addEventListener('change', renderKnowledge);
byId('refresh-map').addEventListener('click', () =>
  loadKnowledge().catch(pageError),
);
async function loadSchedules() {
  try {
    pages.schedules = await readDashboardJson('/api/schedules');
    renderSchedules();
  } catch (error) {
    byId('schedule-clock').textContent = 'Schedule state is unavailable.';
    pageError(error);
  }
}
function renderSchedules() {
  const data = pages.schedules;
  const targets = data.targets ?? [];
  byId('new-schedule').disabled =
    !targets.length || state.dashboard?.mode !== 'writable';
  byId('schedule-clock').textContent =
    data.configured === false
      ? 'Scheduling is not configured for this dashboard.'
      : `Dispatch runs while the dashboard server is online. ${data.lastTickAt ? `Last tick ${new Date(data.lastTickAt).toLocaleString()}.` : 'Waiting for the first tick.'}${data.issue ? ` ${data.issue}` : ''}`;
  const list = byId('schedule-list');
  list.replaceChildren();
  for (const issue of data.issues ?? [])
    list.append(el('p', 'blocker', `${issue.scheduleId}: ${issue.message}`));
  for (const schedule of data.schedules ?? []) {
    const spec = schedule.spec ?? schedule;
    const card = el('article', 'schedule-card');
    card.append(
      section(spec.target?.title ?? spec.title, spec.id),
      badge(spec.status ?? spec.status ?? 'PAUSED'),
    );
    const cadence = spec.cadence;
    card.append(
      el(
        'p',
        'event-detail',
        cadence?.kind === 'once'
          ? `Once · ${new Date(cadence.at).toLocaleString()}`
          : cadence
            ? `Every ${Math.round(cadence.everyMs / 60000)} minutes · anchored ${new Date(cadence.anchor).toLocaleString()}`
            : 'Retained schedule',
      ),
    );
    if (schedule.nextDueAt)
      card.append(
        el(
          'p',
          '',
          `Next due ${new Date(schedule.nextDueAt).toLocaleString()}`,
        ),
      );
    const controls = el('div', 'control-actions');
    for (const action of schedule.actions ??
      (spec.status === 'CANCELLED'
        ? []
        : spec.status === 'ACTIVE'
          ? ['pause', 'cancel']
          : ['resume', 'cancel'])) {
      const button = el(
        'button',
        'quiet',
        {
          pause: 'Pause future runs',
          resume: 'Resume schedule',
          cancel: 'Cancel schedule',
        }[action] ?? action,
      );
      button.disabled = state.dashboard?.mode !== 'writable';
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await post(`/api/schedules/${encodeURIComponent(spec.id)}/actions`, {
            action,
            requestId: crypto.randomUUID(),
            expectedVersion: spec.version,
          });
          await loadSchedules();
        } catch (error) {
          pageError(error);
          await loadSchedules();
        } finally {
          button.disabled = false;
        }
      });
      controls.append(button);
    }
    card.append(controls, section('Occurrence history'));
    for (const occurrence of [...(schedule.occurrences ?? [])].reverse()) {
      const row = el('div', 'occurrence-row');
      row.append(
        badge(occurrence.state),
        el('span', '', new Date(occurrence.dueAt).toLocaleString()),
      );
      if (occurrence.taskId) {
        const link = el('a', '', 'Open task ↗');
        link.href = `/?task=${encodeURIComponent(occurrence.taskId)}&view=tasks`;
        row.append(link);
      }
      if (occurrence.coalescedCount)
        row.append(
          el(
            'span',
            'event-detail',
            `${occurrence.coalescedCount} older due slots coalesced`,
          ),
        );
      if (occurrence.issue)
        row.append(el('span', 'event-detail', occurrence.issue));
      card.append(row);
    }
    if (spec.lastDueAt)
      card.append(
        el(
          'p',
          'event-detail',
          `Last due ${new Date(spec.lastDueAt).toLocaleString()}`,
        ),
      );
    if (!schedule.occurrences?.length)
      card.append(el('p', 'event-detail', 'No due occurrences recorded yet.'));
    list.append(card);
  }
  if (!data.schedules?.length)
    list.append(
      el(
        'div',
        'empty-state',
        targets.length
          ? 'Schedule a configured check to retain its runs here.'
          : 'Add a configured verification recipe to enable scheduling.',
      ),
    );
}
byId('new-schedule').addEventListener('click', () => {
  pages.scheduleRequestId = crypto.randomUUID();
  const select = byId('schedule-target');
  select.replaceChildren();
  for (const target of pages.schedules.targets) {
    const option = el('option', '', target.title);
    option.value = target.id;
    select.append(option);
  }
  const local = new Date(Date.now() + 60000);
  local.setMinutes(local.getMinutes() - local.getTimezoneOffset());
  byId('schedule-at').value = local.toISOString().slice(0, 16);
  byId('schedule-error').hidden = true;
  byId('schedule-dialog').showModal();
});
byId('close-schedule').addEventListener('click', () =>
  byId('schedule-dialog').close(),
);
byId('schedule-cadence').addEventListener('change', () => {
  byId('schedule-interval-label').hidden =
    byId('schedule-cadence').value !== 'interval';
});
byId('schedule-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  byId('save-schedule').disabled = true;
  try {
    const at = new Date(byId('schedule-at').value).toISOString();
    await post('/api/schedules', {
      requestId: pages.scheduleRequestId,
      targetId: byId('schedule-target').value,
      cadence:
        byId('schedule-cadence').value === 'once'
          ? { kind: 'once', at }
          : {
              kind: 'interval',
              anchor: at,
              everyMs: Number(byId('schedule-interval').value) * 60000,
            },
    });
    byId('schedule-dialog').close();
    await loadSchedules();
  } catch (error) {
    byId('schedule-error').textContent = error.message;
    byId('schedule-error').hidden = false;
  } finally {
    byId('save-schedule').disabled = false;
  }
});
byId('refresh').addEventListener('click', () => {
  if (pages.view === 'knowledge') loadKnowledge();
  if (pages.view === 'schedules') loadSchedules();
});
let scheduleControlMode = null;
window.addEventListener('dashboard-refreshed', () => {
  if (pages.view === 'schedules' && pages.schedules && scheduleControlMode !== state.dashboard?.mode) {
    scheduleControlMode = state.dashboard?.mode;
    renderSchedules();
  }
});
setInterval(() => {
  if (
    !document.hidden &&
    pages.view === 'schedules' &&
    !byId('schedule-dialog').open
  )
    loadSchedules();
}, 10000);
selectDashboardView(
  new URL(location.href).searchParams.get('view'),
  false,
).catch(pageError);
