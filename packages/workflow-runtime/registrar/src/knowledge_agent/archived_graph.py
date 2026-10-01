"""RG-001: immutable, archive-anchored graph generations and checked derived views.

No source bytes are read from live roots. A projection is never an archive authority.
"""
from __future__ import annotations

import json
import re

from knowledge_agent import source_archive as archive

MAX_GRAPH = 8 * 1024 * 1024
PROVENANCE = {'extracted', 'inferred', 'ambiguous'}


def _fields(value, fields, label):
    if not isinstance(value, dict) or set(value) != set(fields.split()):
        raise ValueError('invalid ' + label + ' fields')


def _list(value, low, high, label):
    if not isinstance(value, list) or not low <= len(value) <= high:
        raise ValueError('invalid ' + label)


def _text(value, size, label):
    if not isinstance(value, str) or not value.strip() or len(value) > size:
        raise ValueError('invalid ' + label)


def _clone(value):
    try:
        raw = archive.canonical(value)
        if len(raw) > MAX_GRAPH:
            raise ValueError('graph exceeds byte budget')
        return json.loads(raw)
    except (TypeError, RecursionError, UnicodeError) as exc:
        raise ValueError('invalid graph JSON') from exc


def _identity(value):
    return archive.digest(archive.canonical(value))


def _revision(registry, db, revision, source_ids=None):
    _fields(revision, 'schema selections', 'RevisionSet')
    if type(revision['schema']) is not int or revision['schema'] != 1:
        raise ValueError('unsupported RevisionSet schema')
    selections = revision['selections']
    _list(selections, 1, 100, 'RevisionSet selections')
    for selection in selections:
        _fields(selection, 'source_id generation manifest_sha256', 'selection')
        archive._id(selection['source_id'])
        archive._id(selection['generation'])
        archive._hash_id(selection['manifest_sha256'])
    ids = [s['source_id'] for s in selections]
    if source_ids is not None:
        if (not isinstance(source_ids, (list, tuple)) or len(source_ids) != len(ids)
                or any(not isinstance(s, str) for s in source_ids) or set(source_ids) != set(ids)):
            raise ValueError('graph requires exact authorized RevisionSet scope')
    manifests = archive._selection(registry, db, ids, {s['source_id']: s['generation'] for s in selections})
    pins = {s['source_id']: s['manifest_sha256'] for s in selections}
    for manifest in manifests:
        if _identity(manifest) != pins[manifest['source_id']]:
            raise ValueError('RevisionSet manifest pin mismatch')
    revision['selections'].sort(key=lambda s: s['source_id'])
    return {m['source_id']: m for m in manifests}


def _anchors(db, anchors, manifests, *, required=False):
    _list(anchors, int(required), 100, 'anchors')
    for a in anchors:
        _fields(a, 'source_id generation manifest_sha256 path original_sha256 representation_sha256 '
                'text_start text_end quote quote_sha256', 'anchor')
        archive._id(a['source_id'])
        m = manifests.get(a['source_id'])
        if m is None or a['generation'] != m['generation'] or a['manifest_sha256'] != _identity(m):
            raise ValueError('anchor outside RevisionSet')
        document = next((d for d in m['documents'] if d['path'] == a['path']), None)
        if document is None or not document['representation']:
            raise ValueError('anchor text unavailable')
        rep = document['representation']
        if (a['original_sha256'] != document['original']['sha256']
                or a['representation_sha256'] != rep['sha256']):
            raise ValueError('anchor content hash mismatch')
        text = archive._blob(db, rep['sha256'], rep['bytes']).decode('utf-8')
        start = archive._integer(a['text_start'], 0, len(text), 'anchor start')
        end = archive._integer(a['text_end'], start + 1, len(text), 'anchor end')
        if a['quote'] != text[start:end] or a['quote_sha256'] != archive.digest(text[start:end].encode()):
            raise ValueError('anchor quote mismatch')


def _payload(registry, db, payload, source_ids=None):
    _fields(payload, 'schema revision_set parent nodes assertions', 'graph')
    if type(payload['schema']) is not int or payload['schema'] != 1:
        raise ValueError('unsupported graph schema')
    manifests = _revision(registry, db, payload['revision_set'], source_ids)
    if payload['parent'] is not None:
        archive._hash_id(payload['parent'])
    _list(payload['nodes'], 1, 500, 'nodes')
    _list(payload['assertions'], 0, 1000, 'assertions')
    ids = set()
    for node in payload['nodes'] + payload['assertions']:
        if not isinstance(node, dict):
            raise ValueError('invalid graph record')
        archive._id(node.get('id'))
        if node['id'] in ids:
            raise ValueError('duplicate graph ID')
        ids.add(node['id'])
        if not isinstance(node.get('provenance'), str) or node['provenance'] not in PROVENANCE:
            raise ValueError('invalid provenance class')
    nodes = {n['id']: n for n in payload['nodes']}
    for node in nodes.values():
        _fields(node, 'id kind label provenance anchors', 'node')
        if node['kind'] not in ('entity', 'mention'):
            raise ValueError('invalid node kind')
        _text(node['label'], 512, 'label')
        _anchors(db, node['anchors'], manifests, required=True)
    assertions = {a['id']: a for a in payload['assertions']}
    for a in assertions.values():
        _fields(a, 'id kind subject predicate object support contrary provenance lifecycle supersedes', 'assertion')
        if a['kind'] not in ('relationship', 'identity-link'):
            raise ValueError('invalid assertion kind')
        if not isinstance(a['subject'], str) or not isinstance(a['object'], str) or a['subject'] not in nodes or a['object'] not in nodes:
            raise ValueError('dangling assertion endpoint')
        if not isinstance(a['predicate'], str) or not re.fullmatch('[a-z][a-z0-9_-]{0,63}', a['predicate']):
            raise ValueError('invalid predicate')
        if a['kind'] == 'identity-link' and (a['predicate'] not in ('alias', 'rename', 'equivalence') or a['subject'] == a['object']):
            raise ValueError('invalid identity link')
        if a['lifecycle'] not in ('active', 'retracted', 'supersedes'):
            raise ValueError('invalid lifecycle')
        _anchors(db, a['support'], manifests, required=True)
        _anchors(db, a['contrary'], manifests)
        _list(a['supersedes'], 0, 100, 'supersedes')
        for target in a['supersedes']:
            archive._id(target)
            if target not in assertions or target == a['id']:
                raise ValueError('invalid supersession endpoint')
        if (len(set(a['supersedes'])) != len(a['supersedes'])
                or (a['lifecycle'] == 'supersedes' and not a['supersedes'])
                or (a['lifecycle'] == 'active' and a['supersedes'])):
            raise ValueError('invalid supersession lifecycle')
    # Iterative DFS keeps a 1000-record chain independent of Python recursion limits.
    done = set()
    for start in assertions:
        stack, visiting = [(start, False)], set()
        while stack:
            key, leaving = stack.pop()
            if leaving:
                visiting.remove(key)
                done.add(key)
            elif key in visiting:
                raise ValueError('supersession cycle')
            elif key not in done:
                visiting.add(key)
                stack.append((key, True))
                stack.extend((target, False) for target in assertions[key]['supersedes'])
    payload['nodes'].sort(key=lambda n: n['id'])
    payload['assertions'].sort(key=lambda n: n['id'])
    return manifests


def _stored(db, table, key):
    archive._hash_id(key)
    row = db.execute(f'SELECT data FROM {table} WHERE id=?', (key,)).fetchone()
    if row is None:
        raise ValueError('unknown graph or RevisionSet')
    raw = bytes(row[0])
    if len(raw) > MAX_GRAPH or archive.digest(raw) != key:
        raise ValueError('graph storage integrity mismatch')
    value = json.loads(raw)
    if archive.canonical(value) != raw:
        raise ValueError('noncanonical graph storage')
    return value


def _load(registry, db, graph_id, source_ids, *, operator_parent=False):
    if source_ids is None and not operator_parent:
        raise ValueError('graph reads require explicit source scope')
    payload = _stored(db, 'graph_generations', graph_id)
    manifests = _payload(registry, db, payload, source_ids)
    if _stored(db, 'revision_sets', _identity(payload['revision_set'])) != payload['revision_set']:
        raise ValueError('RevisionSet integrity mismatch')
    if _identity(payload) != graph_id:
        raise ValueError('noncanonical graph generation')
    _record_identities(db, payload)
    return payload, manifests


def _insert(db, table, value):
    key, raw = _identity(value), archive.canonical(value)
    row = db.execute(f'SELECT data FROM {table} WHERE id=?', (key,)).fetchone()
    if row is not None and bytes(row[0]) != raw:
        raise ValueError('immutable graph identity collision')
    if row is None:
        db.execute(f'INSERT INTO {table}(id,data) VALUES (?,?)', (key, raw))
    return key


def _insert_graph(db, payload):
    return _insert(db, 'graph_generations', payload)


def _record_identities(db, payload, *, publish=False):
    for record in payload['nodes'] + payload['assertions']:
        if record['kind'] in ('entity', 'mention'):
            identity = {k: record[k] for k in ('kind', 'provenance')}
            if record['kind'] == 'mention':
                identity['anchors'] = record['anchors']
        else:
            identity = {k: v for k, v in record.items() if k != 'lifecycle'}
        raw = archive.canonical(identity)
        row = db.execute('SELECT data FROM graph_record_identities WHERE id=?', (record['id'],)).fetchone()
        if row is not None and bytes(row[0]) != raw:
            raise ValueError('stable graph record identity collision')
        if row is None:
            if not publish:
                raise ValueError('missing graph record identity')
            db.execute('INSERT INTO graph_record_identities VALUES (?,?)', (record['id'], raw))
        if publish and record['kind'] not in ('entity', 'mention'):
            retired = db.execute('SELECT 1 FROM graph_retractions WHERE id=?',
                                 (record['id'],)).fetchone()
            if retired and record['lifecycle'] != 'retracted':
                raise ValueError('retracted assertion ID cannot reactivate')
            if record['lifecycle'] == 'retracted':
                db.execute('INSERT OR IGNORE INTO graph_retractions VALUES (?)', (record['id'],))


def _lineage(registry, db, payload):
    parent = None
    if payload['parent']:
        parent, _ = _load(registry, db, payload['parent'], None, operator_parent=True)
    old_nodes = {n['id']: n for n in parent['nodes']} if parent else {}
    old_assertions = {a['id']: a for a in parent['assertions']} if parent else {}
    for node in payload['nodes']:
        if node['id'] in old_assertions or (node['id'] in old_nodes and node['kind'] != old_nodes[node['id']]['kind']):
            raise ValueError('stable node identity changed kind')
    current = {a['id']: a for a in payload['assertions']}
    if not set(old_assertions) <= set(current):
        raise ValueError('retain parent assertions; use explicit retraction')
    for a in current.values():
        old = old_assertions.get(a['id'])
        if a['id'] in old_nodes:
            raise ValueError('stable identity changed kind')
        if old:
            meaning = lambda item: {k: v for k, v in item.items() if k != 'lifecycle'}
            if meaning(a) != meaning(old):
                raise ValueError('assertion meaning changed under stable ID')
            if old['lifecycle'] == 'retracted' and a['lifecycle'] != 'retracted':
                raise ValueError('republication requires a new assertion ID')
        elif a['lifecycle'] == 'retracted':
            raise ValueError('retraction requires parent assertion')


def publish_graph(registry, batch):
    payload = _clone(batch)
    with registry._writer(), registry._db() as db:
        db.execute('BEGIN IMMEDIATE')
        try:
            manifests = _payload(registry, db, payload)
            _lineage(registry, db, payload)
            graph_id = _identity(payload)
            revision_id = _identity(payload['revision_set'])
            existing = db.execute('SELECT data FROM graph_generations WHERE id=?',
                                  (graph_id,)).fetchone()
            if existing is not None:
                # A past active generation remains an immutable valid snapshot after
                # a later generation retires its assertion ID. Replay may only
                # return that exact stored generation, never publish a new reuse.
                if bytes(existing[0]) != archive.canonical(payload):
                    raise ValueError('immutable graph identity collision')
                _load(registry, db, graph_id, list(manifests))
            else:
                revision_id = _insert(db, 'revision_sets', payload['revision_set'])
                _record_identities(db, payload, publish=True)
                graph_id = _insert_graph(db, payload)
            for sid, manifest in manifests.items():
                archive._recheck(registry, db, sid, manifest)
            db.execute('COMMIT')
        except BaseException:
            db.execute('ROLLBACK')
            raise
    return dict(schema=1, status='complete', graph_id=graph_id, revision_set_id=revision_id)


def retract_graph(registry, graph_id, *, source_ids, assertion_ids):
    """Retire selected active assertions in a new pinned graph generation.

    The caller selects the exact parent and records its review rationale outside
    the graph. This operation changes lifecycle only; all original anchors and
    the prior generation remain immutable and readable.
    """
    archive._hash_id(graph_id)
    _list(assertion_ids, 1, 100, 'retraction IDs')
    if len(set(assertion_ids)) != len(assertion_ids):
        raise ValueError('duplicate retraction ID')
    for assertion_id in assertion_ids:
        archive._id(assertion_id)
    with registry._db() as db:
        parent, _ = _load(registry, db, graph_id, source_ids)
        draft = _clone(parent)
    selected = set(assertion_ids)
    active = {a['id'] for a in draft['assertions'] if a['lifecycle'] != 'retracted'}
    if not selected <= active:
        raise ValueError('retraction requires active parent assertions')
    draft['parent'] = graph_id
    for assertion in draft['assertions']:
        if assertion['id'] in selected:
            assertion['lifecycle'] = 'retracted'
    published = publish_graph(registry, draft)
    return dict(**published, parent_graph_id=graph_id, retracted_assertion_ids=sorted(selected))


def _recheck(registry, db, manifests):
    for sid, manifest in manifests.items():
        archive._recheck(registry, db, sid, manifest)


def read_graph(registry, graph_id, *, source_ids, limit=20, max_bytes=16000, cursor=None, node_id=None):
    archive._integer(limit, 1, 200, 'graph limit')
    archive._integer(max_bytes, 1024, archive.MAX_RESPONSE, 'response bytes')
    with registry._db() as db:
        payload, manifests = _load(registry, db, graph_id, source_ids)
        nodes, assertions = payload['nodes'], payload['assertions']
        if node_id is not None:
            archive._id(node_id)
            if node_id not in {n['id'] for n in nodes}:
                raise ValueError('unknown expansion node')
            assertions = [a for a in assertions if node_id in (a['subject'], a['object'])]
            neighbors = {node_id} | {a[k] for a in assertions for k in ('subject', 'object')}
            nodes = [n for n in nodes if n['id'] in neighbors]
        records = nodes + assertions
        binding = dict(graph_id=graph_id, revision_set_id=_identity(payload['revision_set']),
            source_ids=sorted(source_ids), node_id=node_id,
            configuration={sid: m['configuration_sha256'] for sid, m in manifests.items()})
        offset = archive._resume(cursor, binding) if cursor is not None else 0
        if offset > len(records):
            raise ValueError('invalid graph continuation offset')
        end = min(offset + limit, len(records))
        while True:
            result = dict(schema=1, graph_id=graph_id, revision_set_id=binding['revision_set_id'],
                evidence='archived-snapshot', current_original='not-checked',
                consistency='declared-selection-not-atomic', records=records[offset:end],
                offset=offset, total_records=len(records), exhausted=end == len(records),
                next_cursor=archive._cursor(binding, end) if end < len(records) else None)
            if len(archive.canonical(result)) <= max_bytes:
                break
            end -= 1
            if end <= offset:
                raise ValueError('graph response budget cannot fit a record')
        _recheck(registry, db, manifests)
        return archive.bounded(result, max_bytes)


def _projection(payload):
    nodes = []
    for record in payload['nodes'] + payload['assertions']:
        # ID-qualified provider labels prevent a provider's label deduplication.
        nodes.append(dict(id=record['id'], label=record['id'], attributes=record))
    edges = [dict(source=a[key], target=a['id'], type='subject') if key == 'subject'
             else dict(source=a['id'], target=a[key], type='object')
             for a in payload['assertions'] for key in ('subject', 'object')]
    return dict(schema=1, directed=True, nodes=sorted(nodes, key=lambda n: n['id']),
                edges=sorted(edges, key=archive.canonical))


def graph_projection(registry, graph_id, *, source_ids):
    with registry._db() as db:
        payload, manifests = _load(registry, db, graph_id, source_ids)
        result = dict(schema=1, graph_id=graph_id, projection=_projection(payload),
            native=dict(status='unavailable', gap='native-graphify-adapter-not-configured'))
        _recheck(registry, db, manifests)
        return archive.bounded(result)


def check_graph_projection(registry, graph_id, projection, *, source_ids):
    actual = _clone(projection)
    _fields(actual, 'schema directed nodes edges', 'projection')
    _list(actual['nodes'], 1, 1500, 'projection nodes')
    _list(actual['edges'], 0, 2000, 'projection edges')
    try:
        actual['nodes'].sort(key=lambda n: n['id'])
        actual['edges'].sort(key=archive.canonical)
    except (KeyError, TypeError) as exc:
        raise ValueError('invalid projection') from exc
    expected = graph_projection(registry, graph_id, source_ids=source_ids)['projection']
    if archive.canonical(actual) != archive.canonical(expected):
        raise ValueError('checked projection topology or attributes mismatch')
    return dict(schema=1, graph_id=graph_id, status='verified', native_proof=False)


def _okf(payload):
    import yaml
    gid = _identity(payload)
    rid = _identity(payload['revision_set'])
    files = {}
    for record in payload['nodes'] + payload['assertions']:
        meta = dict(type=record['kind'], registrar=dict(profile=1, graph_id=gid,
                    revision_set_id=rid, record=record))
        links = '' if record['kind'] in ('entity', 'mention') else (
            f"\n[subject]({record['subject']}.md) → [object]({record['object']}.md)\n")
        files[record['id'] + '.md'] = '---\n' + yaml.safe_dump(meta, allow_unicode=True, sort_keys=True) + '---\n' + links
    return dict(schema=1, format='OKF', version='0.2', profile='registrar.archived-graph', profile_version=1,
        graph_id=gid, revision_set_id=rid, graph=payload,
        files=files, file_sha256={p: archive.digest(v.encode()) for p, v in files.items()},
        omissions=['original-source-bytes', 'access-grants', 'native-provider-proof'])


def export_graph_okf(registry, graph_id, *, source_ids):
    with registry._db() as db:
        payload, manifests = _load(registry, db, graph_id, source_ids)
        result = _okf(payload)
        if len(archive.canonical(result)) > 4 * MAX_GRAPH:
            raise ValueError('OKF package exceeds byte budget')
        _recheck(registry, db, manifests)
        return result


def import_graph_okf(registry, package):
    # Never interpret Markdown or imported instructions; exact profile re-render is
    # the validator for all extensions, navigation links and file membership.
    try:
        if len(archive.canonical(package)) > 4 * MAX_GRAPH:
            raise ValueError('OKF package exceeds byte budget')
        payload = _clone(package['graph'])
        expected = _okf(payload)
        if archive.canonical(expected) != archive.canonical(package):
            raise ValueError('OKF profile mismatch')
    except (KeyError, TypeError, RecursionError) as exc:
        raise ValueError('invalid OKF package') from exc
    return publish_graph(registry, payload)
