// Additional workspace views use only server-admitted identities.
const pages = {
  view: 'tasks',
  knowledge: null,
  schedules: null,
  selectedNode: null,
  selectedSource: null,
  knowledgeView: 'sources',
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
function humanKind(kind) {
  return String(kind ?? 'record').replaceAll('-', ' ');
}
function sourceIdentity(anchor) {
  const source = anchor?.source ?? {};
  return source.sourceId ?? source.id ?? source.name ?? anchor?.publicationId ?? 'unassigned';
}
function sourceLabel(anchor) {
  const source = anchor?.source ?? {};
  return source.name ?? source.sourceId ?? source.id ?? anchor?.publicationId ?? 'Unassigned records';
}
function nodePath(node) {
  return node.anchors?.find((anchor) => anchor.path)?.path ?? node.label;
}
function mapDrives(map) {
  const drives = new Map();
  const add = (id, label, node = null) => {
    if (!drives.has(id)) drives.set(id, { id, label, node, records: [] });
    const drive = drives.get(id);
    if (node && !drive.node) drive.node = node;
    return drive;
  };
  for (const node of map.nodes.filter((node) => node.kind === 'source')) {
    const anchor = node.anchors?.[0];
    add(anchor ? sourceIdentity(anchor) : node.label, node.label, node);
  }
  for (const node of map.nodes.filter((node) => ['document', 'path'].includes(node.kind))) {
    const anchors = node.anchors?.filter((anchor) => anchor.path) ?? [];
    if (!anchors.length) add('unassigned', 'Unassigned records').records.push(node);
    for (const anchor of anchors)
      add(sourceIdentity(anchor), sourceLabel(anchor)).records.push(node);
  }
  return [...drives.values()].sort((a, b) => a.label.localeCompare(b.label));
}
function addTreeRecord(root, path, node) {
  const parts = String(path)
    .split('/')
    .filter(Boolean);
  let branch = root;
  const folderParts = node.kind === 'path' ? parts : parts.slice(0, -1);
  for (const part of folderParts) {
    if (!branch.folders.has(part))
      branch.folders.set(part, { folders: new Map(), files: [] });
    branch = branch.folders.get(part);
  }
  // Registrar path records describe folders, not a file beside that folder.
  if (node.kind === 'path') return;
  const file = parts.at(-1) ?? node.label;
  if (!branch.files.some((entry) => entry.node.id === node.id))
    branch.files.push({ name: file, node });
}
function driveTree(drive, needle, kind) {
  const root = { folders: new Map(), files: [] };
  for (const node of drive.records) {
    const path = nodePath(node);
    const matches =
      (!kind || node.kind === kind) &&
      (!needle || `${node.label} ${path} ${node.kind}`.toLowerCase().includes(needle));
    if (matches) addTreeRecord(root, path, node);
  }
  return root;
}
function renderTreeBranch(branch, target, depth = 0) {
  const folders = [...branch.folders.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [name, child] of folders) {
    const folder = el('details', 'source-folder');
    folder.open = depth < 1;
    const summary = el('summary', 'source-folder-summary');
    summary.append(el('span', 'folder-mark', '▸'), el('span', '', name));
    folder.append(summary);
    const contents = el('div', 'source-folder-contents');
    renderTreeBranch(child, contents, depth + 1);
    folder.append(contents);
    target.append(folder);
  }
  for (const entry of [...branch.files].sort((a, b) => a.name.localeCompare(b.name))) {
    const button = el(
      'button',
      `source-file${entry.node.id === pages.selectedNode ? ' selected' : ''}`,
    );
    button.type = 'button';
    button.append(el('span', 'file-mark', '•'), el('span', '', entry.name));
    button.setAttribute('aria-pressed', String(entry.node.id === pages.selectedNode));
    button.title = nodePath(entry.node);
    button.addEventListener('click', () =>
      selectKnowledgeNode(entry.node.id).catch(pageError),
    );
    target.append(button);
  }
}
function renderMetadata(metadata) {
  const labels = {
    graphAlias: 'Knowledge graph',
    graphId: 'Graph identifier',
    recordId: 'Record identifier',
    conceptType: 'Category',
    relationshipType: 'Relationship type',
    predicate: 'Connection',
    provenance: 'Evidence basis',
    lifecycle: 'Record status',
    publicationIds: 'Pinned publications',
    revisionSetId: 'Archived revision set',
    nativeGraphify: 'Graph extraction',
    supersedes: 'Supersedes',
  };
  const list = el('dl', 'metadata-list');
  for (const [key, raw] of Object.entries(metadata ?? {})) {
    if (raw === null || raw === undefined || raw === '' || key === 'graphId') continue;
    const value = Array.isArray(raw)
      ? raw.map((item) => humanKind(item)).join(', ')
      : typeof raw === 'object'
        ? 'Recorded details available'
        : humanKind(raw);
    list.append(el('dt', '', labels[key] ?? humanKind(key)), el('dd', '', value));
  }
  return list.childNodes.length ? list : null;
}
function selectKnowledgeView(view) {
  pages.knowledgeView = view === 'graph' ? 'graph' : 'sources';
  byId('knowledge-sources-view').setAttribute(
    'aria-pressed',
    String(pages.knowledgeView === 'sources'),
  );
  byId('knowledge-graph-view').setAttribute(
    'aria-pressed',
    String(pages.knowledgeView === 'graph'),
  );
  renderKnowledge();
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
      : `${map.state} · ${map.nodes.length} records · ${map.edges.length} connections${coverage ? ` · ${coverage.documentsReturned}/${coverage.documentsKnown} documents` : ''} · historical archive · current originals not checked${coverage?.truncated ? ' · bounded view' : ''}`;
  const needle = byId('map-search').value.trim().toLowerCase();
  const kind = byId('map-kind').value;
  const drives = mapDrives(map);
  if (pages.selectedSource && !drives.some((drive) => drive.id === pages.selectedSource))
    pages.selectedSource = null;
  const visibleDrives = pages.selectedSource
    ? drives.filter((drive) => drive.id === pages.selectedSource)
    : drives;
  const empty = byId('knowledge-empty');
  empty.replaceChildren();
  const sourceEmpty = !map.nodes.some((node) =>
    ['document', 'path'].includes(node.kind),
  );
  const showEmpty =
    map.state === 'not-configured' ||
    map.state === 'unavailable' ||
    (pages.knowledgeView === 'sources' && sourceEmpty);
  if (showEmpty) {
    const title =
      map.state === 'not-configured'
        ? 'No content source is connected yet'
        : map.state === 'unavailable'
          ? 'This knowledge connection needs attention'
          : 'No folders or files are available in this bounded view';
    const detail =
      map.state === 'not-configured'
        ? 'Choose an operator-published, pinned Registrar publication to make its retained folders, files and relationships available here.'
        : map.state === 'unavailable'
          ? 'The dashboard could not verify the configured pinned publication. It will not fall back to another source or latest version.'
          : 'Try a different pinned publication or expand the bounded catalog page. Source capture and refresh remain outside this dashboard.';
    empty.append(el('span', 'empty-symbol', '◎'), el('h2', '', title), el('p', '', detail));
    empty.hidden = false;
  } else empty.hidden = true;
  const driveList = byId('knowledge-drives');
  driveList.replaceChildren();
  const allDrives = el(
    'button',
    `drive-button${pages.selectedSource === null ? ' selected' : ''}`,
  );
  allDrives.type = 'button';
  allDrives.append(el('span', 'drive-mark', '⌘'), el('span', '', 'All sources'), el('span', 'drive-count', String(drives.length)));
  allDrives.setAttribute('aria-pressed', String(pages.selectedSource === null));
  allDrives.addEventListener('click', () => {
    pages.selectedSource = null;
    renderKnowledge();
  });
  driveList.append(allDrives);
  for (const drive of drives) {
    const button = el(
      'button',
      `drive-button${drive.id === pages.selectedSource ? ' selected' : ''}`,
    );
    button.type = 'button';
    button.append(el('span', 'drive-mark', '◫'), el('span', '', drive.label), el('span', 'drive-count', String(drive.records.length)));
    button.setAttribute('aria-pressed', String(drive.id === pages.selectedSource));
    button.addEventListener('click', () => {
      pages.selectedSource = drive.id;
      if (drive.node)
        selectKnowledgeNode(drive.node.id).catch(pageError);
      else renderKnowledge();
    });
    driveList.append(button);
  }
  if (!drives.length)
    driveList.append(el('p', 'event-detail', 'No verified sources to display.'));
  const browser = byId('knowledge-source-browser');
  const tree = byId('knowledge-tree');
  tree.replaceChildren();
  for (const drive of visibleDrives) {
    const section = el('section', 'source-drive');
    section.append(el('h3', '', drive.label));
    const root = driveTree(drive, needle, kind);
    const contents = el('div', 'source-drive-contents');
    renderTreeBranch(root, contents);
    section.append(contents);
    if (!contents.childNodes.length)
      section.append(el('p', 'event-detail', 'No retained files match this filter.'));
    tree.append(section);
  }
  if (!visibleDrives.length && !empty.hidden)
    tree.append(el('p', 'event-detail', 'A source drive will appear here after its publication is verified.'));
  browser.hidden = pages.knowledgeView !== 'sources' || !empty.hidden;
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
  if (!nodes.length && pages.knowledgeView === 'graph')
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
  canvas.hidden = pages.knowledgeView !== 'graph' || !empty.hidden;
  list.hidden = pages.knowledgeView !== 'graph' || !empty.hidden;
  if (nodes.length && pages.knowledgeView === 'graph' && empty.hidden) {
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
  const metadata = renderMetadata(detail.metadata);
  if (metadata) panel.append(section('Recorded details'), metadata);
  for (const gap of detail.gaps ?? [])
    panel.append(el('p', 'blocker', gap.detail ?? gap.reason));
}
byId('map-search').addEventListener('input', renderKnowledge);
byId('map-kind').addEventListener('change', renderKnowledge);
byId('refresh-map').addEventListener('click', () =>
  loadKnowledge().catch(pageError),
);
byId('knowledge-sources-view').addEventListener('click', () =>
  selectKnowledgeView('sources'),
);
byId('knowledge-graph-view').addEventListener('click', () =>
  selectKnowledgeView('graph'),
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
