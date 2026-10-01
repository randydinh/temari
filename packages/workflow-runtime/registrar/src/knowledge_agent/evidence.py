"""Caller-selected evidence maps, required sections and declared dependencies.

Policy is local configuration, never instructions parsed out of imported sources.
The older Collection reader's exact selection, applicability and requires semantics
are retained conceptually, using registry document identities and verified spans.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import tempfile
from datetime import date

from knowledge_agent.knowledge import _hash
from knowledge_agent.knowledge_cache import canonical
from knowledge_agent.structure import sections


def _reference(row):
    if (not isinstance(row, dict) or set(row) - {'source_id', 'path', 'section'}
            or not all(isinstance(row.get(k), str) and row[k] for k in ('source_id', 'path'))
            or Path(row['path']).is_absolute() or '..' in Path(row['path']).parts
            or ('section' in row and (not isinstance(row['section'], str) or not row['section']))):
        raise ValueError('invalid evidence document/section reference')
    return row


def _validate(policy):
    if (not isinstance(policy, dict) or set(policy) != {'schema','documents'} or type(policy['schema']) is not int
            or policy['schema'] != 1 or not isinstance(policy['documents'], list) or len(policy['documents']) > 100):
        raise ValueError('invalid evidence policy')
    seen = set()
    for row in policy['documents']:
        if not isinstance(row, dict) or set(row) - {'source_id','path','sha256','required_sections','requires',
                'applies_to','valid_from','valid_until','supersedes','claims'}:
            raise ValueError('invalid evidence policy document')
        _reference({k:row[k] for k in ('source_id','path') if k in row})
        key = (row['source_id'], row['path'])
        if key in seen or not isinstance(row.get('sha256'), str) or not re.fullmatch('[0-9a-f]{64}', row['sha256']):
            raise ValueError('policy documents require unique identities and SHA-256')
        seen.add(key)
        required = row.get('required_sections', [])
        requires = row.get('requires', [])
        if (not isinstance(required, list) or len(required) > 20 or any(not isinstance(s, str) or not s for s in required)
                or not isinstance(requires, list) or len(requires) > 20):
            raise ValueError('invalid bounded section/dependency list')
        for dependency in requires:
            _reference(dependency)
        tags = row.get('applies_to', [])
        if not isinstance(tags, list) or len(tags) > 20 or any(not isinstance(t,str) or not t for t in tags):
            raise ValueError('invalid applicability tags')
        for field in ('valid_from','valid_until'):
            if field in row:
                _date(row[field])
        if row.get('valid_from') and row.get('valid_until') and row['valid_from'] >= row['valid_until']:
            raise ValueError('valid_until is an exclusive bound after valid_from')
        for field in ('supersedes','claims'):
            if not isinstance(row.get(field, []), list) or len(row.get(field, [])) > 20:
                raise ValueError('invalid bounded policy list')
        for ref in row.get('supersedes', []):
            _reference(ref)
            if 'section' in ref:
                raise ValueError('supersession identifies a document')
        keys = set()
        for claim in row.get('claims', []):
            if (not isinstance(claim,dict) or set(claim) != {'key','value','section','quote'}
                    or any(not isinstance(claim[k],str) or not claim[k] for k in ('key','section','quote'))
                    or claim['key'] in keys or type(claim['value']) not in (str,int,bool)):
                raise ValueError('invalid declared claim')
            keys.add(claim['key'])
    graph = {(r['source_id'],r['path']): [(x['source_id'],x['path']) for x in r.get('supersedes',[])] for r in policy['documents']}
    visited, active = set(), set()
    def walk(key):
        if key in active:
            raise ValueError('supersession cycle')
        if key not in graph:
            raise ValueError('supersession target must have a retained policy record')
        if key not in visited:
            active.add(key)
            for child in graph[key]:
                walk(child)
            active.remove(key)
            visited.add(key)
    for key in graph:
        walk(key)


def _date(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise ValueError('date must use YYYY-MM-DD')
    return date.fromisoformat(value)


def applicability(row, doc, context=(), as_of=None):
    if not isinstance(context,(tuple,list)) or any(not isinstance(t,str) or not t for t in context):
        raise ValueError('context must contain applicability tags')
    if as_of is not None:
        _date(as_of)
    if not row:
        return 'not-declared'
    if doc is None or row['sha256'] != doc['sha256']:
        return 'policy-source-changed'
    if not set(row.get('applies_to',[])) <= set(context):
        return 'inapplicable'
    if row.get('valid_from') or row.get('valid_until'):
        if as_of is None:
            return 'applicability-date-required'
        if (row.get('valid_from') and as_of < row['valid_from']) or (row.get('valid_until') and as_of >= row['valid_until']):
            return 'outside-effective-period'
    return 'applicable'


def policy_view(registry, docs, context=(), as_of=None):
    policy, fingerprint = policy_state(registry)
    rows = {(r['source_id'],r['path']):r for r in policy['documents']}
    states = {key:applicability(row,docs.get(key),context,as_of) for key,row in rows.items()}
    # Only an applicable and current successor affects present applicability.
    superseded = set()
    for key,row in rows.items():
        if states[key] == 'applicable':
            superseded.update((s['source_id'],s['path']) for s in row.get('supersedes',[]))
    for key in superseded:
        if states.get(key) == 'applicable':
            states[key] = 'superseded'
    assertions = {}
    for key,row in rows.items():
        if states[key] != 'applicable':
            continue
        text = docs[key].get('text','')
        anchors = {s['anchor']:s for s in sections(text)}
        for assertion in row.get('claims',[]):
            section = anchors.get(assertion['section'])
            if not section or assertion['quote'] not in text[section['content_start']:section['text_end']]:
                states[key] = 'policy-claim-quote-mismatch'
                continue
            assertions.setdefault(assertion['key'],[]).append(dict(assertion,source_id=key[0],path=key[1]))
    conflicts = {key:claims for key,claims in assertions.items() if len({canonical(c['value']) for c in claims}) > 1}
    return rows, states, conflicts, fingerprint


def policy_state(registry):
    path = registry.workspace / 'evidence-policy.json'
    if path.is_symlink():
        raise ValueError('evidence policy symlinks are not admitted')
    if not path.exists():
        return {'schema':1,'documents':[]}, None
    if path.stat().st_size > 1048576:
        raise ValueError('evidence policy too large')
    raw = path.read_bytes()
    value = json.loads(raw)
    _validate(value)
    return value, _hash(raw)


def configure(registry, policy):
    from knowledge_agent.retrieval import _corpus
    _validate(policy)
    raw = canonical(policy)
    if len(raw) > 1048576:
        raise ValueError('evidence policy too large')
    with registry._writer():
        docs, _, _, _, _ = _corpus(registry, None)
        for row in policy['documents']:
            doc = docs.get((row['source_id'], row['path']))
            if not doc or doc['sha256'] != row['sha256']:
                raise ValueError('policy source is unavailable or changed')
            anchors = {s['anchor']:s for s in sections(doc.get('text',''))}
            for claim in row.get('claims',[]):
                section = anchors.get(claim['section'])
                if not section or not section['operative'] or claim['quote'] not in doc['text'][section['content_start']:section['text_end']]:
                    raise ValueError('declared claim quote is not in an operative source section')
        path = registry.workspace / 'evidence-policy.json'
        if path.is_symlink():
            raise ValueError('evidence policy symlinks are not admitted')
        fd, temporary = tempfile.mkstemp(dir=registry.workspace, prefix='.evidence-')
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    return dict(status='complete', documents=len(policy['documents']), policy_sha256=_hash(raw))


def outline(registry, source_id, path, *, offset=0, limit=50, max_bytes=16000, expected_generation=None):
    from knowledge_agent.retrieval import _budget, _corpus, _size
    _budget(max_bytes)
    if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 200:
        raise ValueError('invalid outline pagination')
    docs, sources, _, _, _ = _corpus(registry, [source_id])
    doc = docs.get((source_id, path))
    generation = sources[source_id]['generation']
    if not doc:
        raise ValueError('document unavailable')
    if (offset and expected_generation is None) or (expected_generation is not None and generation != expected_generation):
        raise ValueError('outline continuation requires unchanged generation')
    rows = sections(doc.get('text',''))
    if offset > len(rows):
        raise ValueError('outline offset exceeds sections')
    result = dict(status='partial', source_id=source_id, path=path, generation=generation,
        sha256=doc['sha256'], total=len(rows), sections=rows[offset:offset+limit], next_offset=None)
    def update():
        end = offset + len(result['sections'])
        result['next_offset'] = end if end < len(rows) else None
        result['status'] = 'partial' if result['next_offset'] is not None else 'complete'
    update()
    while _size(result) > max_bytes and result['sections']:
        result['sections'].pop()
        update()
    if _size(result) > max_bytes or (not result['sections'] and offset < len(rows)):
        raise ValueError('budget cannot hold an outline entry')
    return result


def required_context(selections, docs, sources, configured, states, policy_hash):
    """Resolve declared prerequisites against one caller's scoped corpus/policy view.

    Expansion and validation share this traversal. Roots are selected evidence, not
    implicitly required whole documents. A declared edge/section is required even
    if a cycle also names a root. Caller annotations bound the finite graph.
    """
    result = dict(entries=[], gaps=[], dependencies=[], documents=set())
    queue = [(selection, False) for selection in selections]
    visited, expanded, required = set(), set(), set()
    while queue:
        selection, prerequisite = queue.pop(0)
        key = (selection['source_id'], selection['path'])
        identity = (*key, selection.get('section'))
        if prerequisite:
            required.add(identity)
        if identity in visited:
            continue
        visited.add(identity)
        result['documents'].add(key)
        if key[0] not in sources:
            result['gaps'].append(dict(selection=selection, reason='dependency-outside-scope'))
            continue
        doc = docs.get(key)
        if not doc:
            result['gaps'].append(dict(selection=selection, reason='document-unavailable'))
            continue
        metadata = configured.get(key)
        state = states.get(key,'not-declared')
        if state not in ('applicable','not-declared','policy-source-changed'):
            result['gaps'].append(dict(selection=selection,reason=state))
            continue
        if metadata and metadata['sha256'] != doc['sha256']:
            result['gaps'].append(dict(selection=selection, reason='policy-source-changed'))
            metadata = None
        if metadata and key not in expanded:
            expanded.add(key)
            for anchor in metadata.get('required_sections', []):
                queue.append((dict(source_id=key[0],path=key[1],section=anchor), True))
            for dependency in metadata.get('requires', []):
                queue.append((dependency, True))
                result['dependencies'].append(dict(origin=dict(source_id=key[0],path=key[1]), target=dependency,
                    kind='requires', provenance='caller-declared', policy_sha256=policy_hash))
        text = doc.get('text', '')
        start, end = 0, len(text)
        if selection.get('section'):
            section = next((s for s in sections(text) if s['anchor'] == selection['section']), None)
            if section is None:
                reason = 'missing-required-section' if prerequisite else 'missing-section'
                result['gaps'].append(dict(selection=selection, reason=reason))
                continue
            if not section['operative']:
                result['gaps'].append(dict(selection=selection, reason='non-operative-section'))
                continue
            start, end = section['text_start'], section['text_end']
        result['entries'].append(dict(selection=selection, text_start=start, text_end=end, applicability=state))
    for entry in result['entries']:
        selection = entry['selection']
        entry['required'] = (selection['source_id'], selection['path'], selection.get('section')) in required
    return result


def expand(registry, selections, *, source_ids, max_bytes=16000, max_documents=20, context=(), as_of=None):
    from knowledge_agent.retrieval import _budget, _corpus, _size, _gaps
    _budget(max_bytes)
    if (not isinstance(selections, list) or not 1 <= len(selections) <= 20
            or type(max_documents) is not int or not 1 <= max_documents <= 100 or source_ids is None):
        raise ValueError('expansion requires 1–20 selections, explicit scope and a bounded document count')
    for selection in selections:
        _reference(selection)
    docs, sources, _, gaps, snapshot = _corpus(registry, source_ids)
    configured, states, conflicts, policy_hash = policy_view(registry, docs, context, as_of)
    closure = required_context(selections, docs, sources, configured, states, policy_hash)
    result = dict(status='partial', snapshot=snapshot, policy_sha256=policy_hash, records=[],
        gaps=_gaps(gaps) + closure['gaps'], dependencies=closure['dependencies'], pending=[])
    for entry in closure['entries']:
        selection = entry['selection']
        key = (selection['source_id'], selection['path'])
        doc = docs[key]
        if len(result['records']) >= max_documents:
            result['pending'].append(selection)
            continue
        try:
            read = registry.read_document(*key, section=selection.get('section'),
                expected_generation=doc['generation'], expected_sha256=doc['sha256'], max_bytes=max_bytes)
            if read.get('section') and not read['section']['operative']:
                raise ValueError('non-operative-section')
        except ValueError as exc:
            result['gaps'].append(dict(selection=selection, reason=str(exc)))
            continue
        if read['next_offset'] is not None:
            result['gaps'].append(dict(selection=selection,reason='section-read-incomplete',next_offset=read['next_offset']))
        result['records'].append(dict(read['record'], source_id=key[0], path=key[1], section=selection.get('section'),
            applicability=entry['applicability']))
    if conflicts:
        result['gaps'].append(dict(reason='conflicting-declared-claims',conflicts=conflicts))
    # Pending selections are concrete named work; no dropped evidence is called complete.
    if result['pending']:
        result['gaps'].append(dict(reason='expansion-document-budget'))
    result['status'] = 'partial' if result['gaps'] or result['pending'] else 'complete'
    if _size(result) > max_bytes:
        result['status'] = 'partial'
        result['gaps'].append(dict(reason='expansion-byte-budget'))
        while _size(result) > max_bytes and result['records']:
            row = result['records'].pop()
            result['pending'].append({k:row[k] for k in ('source_id','path','section') if row.get(k) is not None})
    if _size(result) > max_bytes:
        raise ValueError('budget cannot hold expansion gap and pending report; increase max_bytes')
    if _corpus(registry, source_ids)[-1] != snapshot:
        raise ValueError('corpus snapshot changed during expansion; restart')
    result['status'] = 'partial' if result['gaps'] or result['pending'] else 'complete'
    return result
