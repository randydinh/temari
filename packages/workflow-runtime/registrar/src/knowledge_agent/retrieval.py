"""Snapshot-bound document navigation. Matching coverage is not semantic completeness."""
from __future__ import annotations

import base64
from collections import Counter
import json
from pathlib import Path

from knowledge_agent.knowledge import _ExtractionError, _hash, _hash_file
from knowledge_agent.knowledge_cache import canonical


def _size(value):
    return len(json.dumps(value, ensure_ascii=False).encode())


def _budget(max_bytes):
    if type(max_bytes) is not int or not 1024 <= max_bytes <= 1048576:
        raise ValueError('budget must be 1024–1048576 bytes')


def _scope(registry, source_ids):
    if source_ids is not None and (not isinstance(source_ids, (list, tuple)) or not source_ids
            or len(source_ids) > 100 or any(not isinstance(s, str) or not s.strip() for s in source_ids)):
        raise ValueError('source_ids must be a nonempty list of IDs')
    all_sources = {s['id']: s for s in registry.list()}
    ids = sorted(all_sources if source_ids is None else set(source_ids))
    if set(ids) - all_sources.keys():
        raise ValueError('unknown source ID')
    return {sid: all_sources[sid] for sid in ids}


def _corpus(registry, source_ids):
    """Validate indexed documents, retaining failed candidates in the snapshot/gaps.

    Membership is from the last scan: this deliberately does not traverse new files
    or excluded descendants, nor refresh remote sources as a search side effect.
    """
    from knowledge_agent.source_registry import ENGINE, _tokens
    sources = _scope(registry, source_ids)
    gaps, documents, observations, report = Counter(), {}, [], []
    extracted = {}
    remote_grants = {}
    for sid, source in sources.items():
        inventory = registry.inventory(sid)
        counts = dict(Counter(item['status'] for item in inventory))
        report.append(dict(id=sid, generation=source['generation'], enabled=source['enabled'],
            scan_status=source['scan_status'], last_scan_at=source['last_scan_at'], inventory=counts))
        observations.append([sid, inventory])
        receipt = source.get('receipt') or {}
        reason = None
        if not source['enabled']:
            reason = 'disabled'
        elif source.get('kind') in ('shortcut', 'notion'):
            from knowledge_agent.remote_sources import unavailable_reason
            reason = unavailable_reason(source, ENGINE)
        elif source.get('kind') == 'testmo':
            from knowledge_agent.testmo import ENGINE as testmo_engine
            if not receipt:
                reason = source['scan_status']
            elif receipt.get('engine_sha256') != testmo_engine or receipt.get('registry_engine_sha256') != ENGINE:
                reason = 'provider-version-changed'
        elif source['scan_status'] not in ('complete', 'partial'):
            reason = source['scan_status']
        elif receipt.get('engine_sha256') != ENGINE:
            reason = 'provider-version-changed'
        if reason:
            gaps[(sid, reason)] += 1
            continue
        if source.get('kind') in ('shortcut', 'notion'):
            from knowledge_agent.remote_access import load_grant
            remote_grants[sid] = load_grant(source)
            observations.append([sid, 'authorization', remote_grants[sid]])
        for kind, count in counts.items():
            if kind != 'indexed':
                gaps[(sid, kind)] += count
        if source.get('kind') in ('testmo', 'shortcut', 'notion') and source['scan_status'] != 'complete':
            gaps[(sid, source['scan_status'])] += 1
        if source.get('kind') in ('shortcut', 'notion'):
            for gap, count in receipt.get('gaps', {}).items():
                gaps[(sid, gap)] += count
        with registry._db() as db:
            chunks = list(db.execute('SELECT path, data FROM chunks WHERE source_id=? ORDER BY path, ordinal', (sid,)))
        indexed = {item['path']: item for item in inventory if item['status'] == 'indexed'}
        failed = set()
        for relative, raw in chunks:
            key = (sid, relative)
            if relative not in indexed or key in failed:
                continue
            chunk = json.loads(raw)
            try:
                body, citation = registry._verify_chunk(source, relative, chunk, extracted)
            except _ExtractionError as exc:
                reason = exc.reason
            except (OSError, ValueError, KeyError):
                reason = 'source-or-index-unavailable'
            else:
                doc = documents.setdefault(key, dict(source_id=sid, path=relative,
                    sha256=chunk['sha256'], generation=source['generation'],
                    duplicate_group=chunk['sha256'], chunks=[], words=set()))
                if source.get('kind') != 'testmo':
                    doc['text'] = extracted[(sid, relative, chunk['sha256'])]['text']
                doc['chunks'].append((body, citation))
                doc['words'].update(_tokens(body + ' ' + relative))
                continue
            gaps[(sid, reason)] += 1
            failed.add(key)
            documents.pop(key, None)
            observations.append([sid, relative, reason])
        for relative, item in indexed.items():
            key = (sid, relative)
            if key not in documents and key not in failed:
                # Empty documents remain discoverable through their filename.
                if item.get('chunks') == 0 and source.get('kind') not in ('testmo', 'shortcut', 'notion'):
                    try:
                        if _hash_file(registry._source_file(source, relative)) != item['sha256']:
                            raise OSError('changed')
                        documents[key] = dict(source_id=sid, path=relative, sha256=item['sha256'],
                            generation=source['generation'], duplicate_group=item['sha256'],
                            chunks=[], words=_tokens(relative))
                    except OSError:
                        gaps[(sid, 'source-or-index-unavailable')] += 1
                else:
                    gaps[(sid, 'index-missing')] += 1
    # Recheck bytes after extraction, including documents not selected by ranking.
    for key, doc in list(documents.items()):
        source = sources[doc['source_id']]
        if source.get('kind') in ('testmo', 'shortcut', 'notion'):
            continue  # verify_chunk checks immutable cached revisions, not remote state.
        try:
            if _hash_file(registry._source_file(source, doc['path'])) != doc['sha256']:
                raise OSError('changed')
        except OSError:
            documents.pop(key)
            gaps[(source['id'], 'source-changed-during-lookup')] += 1
    for sid, grant in remote_grants.items():
        from knowledge_agent.remote_access import load_grant
        if load_grant(sources[sid]) != grant:
            raise ValueError('remote authorization changed during lookup; retry')
    if _scope(registry, source_ids) != sources:
        raise ValueError('registry snapshot changed during lookup; restart')
    from knowledge_agent.evidence import policy_state
    from knowledge_agent.providers import configuration
    snapshot = _hash(canonical(dict(engine=ENGINE, policy=policy_state(registry)[1], provider=configuration(registry)[1], sources=sources, observations=observations,
        documents=sorted([*key, d['sha256']] for key, d in documents.items()), gaps=_gaps(gaps))))
    return documents, sources, report, gaps, snapshot


def _cursor(snapshot, request, offset):
    return base64.urlsafe_b64encode(canonical(dict(snapshot=snapshot, request=request, offset=offset))).decode()


def _offset(cursor, snapshot, request):
    if cursor is None:
        return 0
    try:
        if not isinstance(cursor, str) or len(cursor) > 2048:
            raise ValueError()
        value = json.loads(base64.b64decode(cursor, altchars=b'-_', validate=True))
        if set(value) != {'snapshot', 'request', 'offset'} or type(value['offset']) is not int or value['offset'] < 0:
            raise ValueError()
    except (ValueError, TypeError, UnicodeError):
        raise ValueError('invalid continuation cursor') from None
    if value['snapshot'] != snapshot:
        raise ValueError('corpus snapshot changed; restart discovery')
    if value['request'] != request:
        raise ValueError('continuation request changed; restart discovery')
    return value['offset']


def _gaps(gaps):
    return [dict(source_id=sid, reason=reason, count=count) for (sid, reason), count in sorted(gaps.items())]


def discover(registry, query, *, source_ids=None, variants=(), limit=20, max_bytes=16000, cursor=None, mode='exact'):
    from knowledge_agent.source_registry import _tokens
    _budget(max_bytes)
    if mode not in ('exact','semantic','relationship'):
        raise ValueError('mode must be exact, semantic or relationship')
    if (not isinstance(query, str) or not 1 <= len(query.encode()) <= 512 or not _tokens(query)
            or type(limit) is not int or not 1 <= limit <= 200
            or not isinstance(variants, (tuple, list)) or len(variants) > 20
            or any(not isinstance(v, str) or not 1 <= len(v.encode()) <= 512 or not _tokens(v) for v in variants)):
        raise ValueError('query/variants require bounded words; document limit must be 1–200')
    queries = list(dict.fromkeys([query, *variants]))
    terms = set().union(*(_tokens(q) for q in queries))
    documents, sources, report, gaps, snapshot = _corpus(registry, source_ids)
    from knowledge_agent.evidence import policy_view
    _,applicability,conflicts,_ = policy_view(registry,documents)
    request = _hash(canonical(dict(queries=queries, scope=None if source_ids is None else sorted(set(source_ids)), mode=mode)))
    offset = _offset(cursor, snapshot, request)
    hits = []
    provider_hits,provider_receipt = None,None
    if mode != 'exact':
        from knowledge_agent.providers import rank
        ranked,gap,provider_receipt = rank(registry,documents,' '.join(queries),mode,snapshot)
        provider_hits = {(h['source_id'],h['path']):h for h in ranked}
        if gap:
            gaps[('',gap['reason'])] += gap.get('count',1)
    for key,doc in documents.items():
        matched = sorted(terms & doc['words'])
        if (bool(matched) if provider_hits is None else key in provider_hits):
            score = len(matched) + 2 * len(terms & _tokens(Path(doc['path']).stem))
            retrieval = dict(kind='exact',score=score,matched_terms=matched)
            if provider_hits is not None:
                retrieval = dict(kind=mode,score=provider_hits[key]['score'],via=provider_hits[key]['via'])
            hits.append({k: v for k, v in doc.items() if k not in ('chunks', 'words', 'text')} | dict(
                chunk_count=len(doc['chunks']), retrieval=retrieval,
                applicability=applicability.get(key,'not-declared'),
                declared_conflicts=[name for name,rows in conflicts.items()
                    if any((row['source_id'],row['path'])==key for row in rows)]))
    hits.sort(key=lambda d: (-d['retrieval']['score'], d['source_id'], d['path']))
    if offset > len(hits):
        raise ValueError('continuation offset exceeds matches')
    if not hits:
        gaps[('', 'no-match')] += 1
    result = dict(schema=1, operation='discover', status='partial', query=query, variants=list(variants),
        snapshot=snapshot, documents=hits[offset:offset + limit], sources=report, gaps=_gaps(gaps),
        freshness='indexed membership as of last scan; local bytes checked; remote freshness unknown',
        coverage={}, next_cursor=None)
    if provider_receipt is not None:
        result['provider_receipt'] = provider_receipt

    def update():
        consumed = offset + len(result['documents'])
        remaining = len(hits) - consumed
        result['coverage'] = dict(indexed_documents=len(documents), matched=len(hits), returned=len(result['documents']),
            consumed=consumed, remaining=remaining, enumeration_exhausted=remaining == 0,
            semantic_recall='not-evaluated')
        result['next_cursor'] = _cursor(snapshot, request, consumed) if remaining else None
        result['status'] = 'partial' if gaps or remaining else 'complete'

    update()
    while _size(result) > max_bytes and result['documents']:
        result['documents'].pop()
        update()
    if _size(result) > max_bytes or (not result['documents'] and offset < len(hits)):
        raise ValueError('budget cannot hold discovery metadata and one document; increase max_bytes or narrow scope')
    if _corpus(registry,source_ids)[-1] != snapshot:
        raise ValueError('corpus snapshot changed during provider retrieval; restart')
    return result


def read_document(registry, source_id, path, *, offset=0, max_chars=8000, max_bytes=16000,
                  expected_generation=None, expected_sha256=None, section=None):
    _budget(max_bytes)
    if type(offset) is not int or offset < 0 or type(max_chars) is not int or not 1 <= max_chars <= 1048576:
        raise ValueError('invalid read offset or character budget')
    if not isinstance(path, str) or not path or Path(path).is_absolute() or '..' in Path(path).parts:
        raise ValueError('read requires an admitted source-relative path')
    if offset and (expected_generation is None or expected_sha256 is None):
        raise ValueError('read continuation requires expected_generation and expected_sha256')
    documents, sources, _, gaps, snapshot = _corpus(registry, [source_id])
    source = sources[source_id]
    if expected_generation is not None and source['generation'] != expected_generation:
        raise ValueError('document generation changed; restart read')
    doc = documents.get((source_id, path))
    if doc is None:
        raise ValueError('document is not available in the admitted index; inspect inventory/gaps')
    if expected_sha256 is not None and expected_sha256 != doc['sha256']:
        raise ValueError('document bytes changed; restart read')
    if source.get('kind') == 'testmo':
        raise ValueError('use typed search citations for Testmo fields; local document read is unsupported')
    text = doc.get('text', '')
    base, stop, selected_section = 0, len(text), None
    if section is not None:
        from knowledge_agent.structure import sections
        selected_section = next((s for s in sections(text) if s['anchor'] == section), None)
        if selected_section is None:
            raise ValueError('missing-section')
        base, stop = selected_section['text_start'], selected_section['text_end']
    if offset > stop - base:
        raise ValueError('read offset exceeds document')
    template = doc['chunks'][0][1] if doc['chunks'] else dict(source_id=source_id, path=path,
        sha256=doc['sha256'], extraction='empty-text')
    result = dict(schema=1, operation='read', status='partial', source_id=source_id, path=path,
        generation=source['generation'], sha256=doc['sha256'], snapshot=snapshot, total_chars=stop-base,
        offset=offset, next_offset=None, record={}, gaps=[])
    if selected_section:
        result['section'] = selected_section

    def fill(count):
        end = base + offset + count
        body = text[base+offset:end]
        first = text[:base+offset].count('\n') + 1
        citation = dict(template, text_start=base+offset, text_end=end, start=first,
            end=first + body.count('\n') - int(body.endswith('\n')), quote=body)
        if selected_section:
            citation['section'] = selected_section['anchor']
        result['record'] = dict(body=body, support=('cached-remote-revision-and-spans-verified'
            if source.get('kind') in ('shortcut', 'notion') else 'source-bytes-and-spans-verified'), citations=[citation])
        result['next_offset'] = end-base if end < stop else None
        result['status'] = 'partial' if end < stop else 'complete'

    count = min(max_chars, stop - base - offset)
    fill(count)
    if _size(result) > max_bytes:
        low, high = 0, count
        while low < high:
            mid = (low + high + 1) // 2
            fill(mid)
            if _size(result) <= max_bytes:
                low = mid
            else:
                high = mid - 1
        count = low
        fill(count)
    if _size(result) > max_bytes or (count == 0 and base + offset < stop):
        raise ValueError('budget cannot hold read metadata and text; increase max_bytes')
    if source.get('kind') in ('shortcut', 'notion'):
        from knowledge_agent.remote_sources import revision_text, unavailable_reason
        from knowledge_agent.source_registry import ENGINE
        revision_text(registry, source, path, doc['sha256'])
        changed = unavailable_reason(source, ENGINE) is not None
    else:
        changed = _hash_file(registry._source_file(source,path)) != doc['sha256']
    if _scope(registry,[source_id]) != sources or changed:
        raise ValueError('document changed during read; retry')
    return result
