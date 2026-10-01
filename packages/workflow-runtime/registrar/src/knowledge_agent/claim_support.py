"""Bounded claim checks. Source identity, semantic support and truth are separate."""
from knowledge_agent.evidence import policy_view, required_context
from knowledge_agent.retrieval import _budget, _corpus, _size, _gaps
from knowledge_agent.structure import sections


def verified_citation(citation, docs, sources):
    """Verify actual source bytes and normalized spans, never caller coverage flags."""
    key = (citation['source_id'], citation['path'])
    doc = docs.get(key)
    start, end, quote = citation['text_start'], citation['text_end'], citation['quote']
    text = doc.get('text', '') if doc else ''
    if (key[0] not in sources or not doc or doc['sha256'] != citation['sha256']
            or type(start) is not int or type(end) is not int or not 0 <= start < end <= len(text)
            or not isinstance(quote, str) or text[start:end] != quote
            or citation.get('extraction') != doc['chunks'][0][1]['extraction']):
        raise ValueError('invalid-or-unavailable-citation')
    first = text[:start].count('\n') + 1
    last = first + quote.count('\n') - int(quote.endswith('\n'))
    if citation.get('start', first) != first or citation.get('end', last) != last:
        raise ValueError('invalid-or-unavailable-citation')
    return key, doc, start, end, quote


def _covered(start, end, citations):
    position = start
    for left, right in sorted((c['text_start'], c['text_end']) for c in citations):
        if right <= position:
            continue
        if left > position:
            break
        position = right
        if position >= end:
            return True
    return position >= end


def validate_claims(registry, claims, *, source_ids, consumed=(), context=(), as_of=None, max_bytes=16000):
    _budget(max_bytes)
    if source_ids is None or not isinstance(claims,list) or len(claims) > 20:
        raise ValueError('claim validation requires explicit scope and at most twenty claims')
    if not isinstance(consumed, (list, tuple)):
        raise ValueError('consumed evidence must be a list of source citations')
    seen = set()
    for claim in claims:
        if (not isinstance(claim,dict) or set(claim) != {'id','text','kind','citations'}
                or any(not isinstance(claim[k],str) or not claim[k] or len(claim[k]) > 8000 for k in ('id','text'))
                or claim['id'] in seen or claim['kind'] not in ('quotation','source-claim','statement','inference')
                or not isinstance(claim['citations'],list) or len(claim['citations']) > 20):
            raise ValueError('invalid bounded claim request')
        seen.add(claim['id'])
    docs, sources, _, gaps, snapshot = _corpus(registry,source_ids)
    policies, states, conflicts, policy_hash = policy_view(registry,docs,context,as_of)
    consumed_by_document = {}
    rejected_consumption = []
    for index, citation in enumerate(consumed):
        try:
            key, *_ = verified_citation(citation, docs, sources)
            consumed_by_document.setdefault(key, []).append(citation)
        except (KeyError, TypeError, ValueError, IndexError):
            rejected_consumption.append(dict(index=index, reason='invalid-or-unavailable-consumed-citation'))
    result = dict(status='partial', snapshot=snapshot, policy_sha256=policy_hash, claims=[],
        gaps=_gaps(gaps), pending_claims=[], method='deterministic-span-and-declared-context-check',
        consumed_evidence_issues=rejected_consumption,
        limitations=['undeclared conflicts and applicability are not exhaustively detected',
            'paraphrases/inferences require semantic review; no model judgment or source truth is certified'])
    for claim in claims:
        issues, verified, conflict_keys = [], [], set()
        for citation in claim['citations']:
            try:
                key, doc, start, end, quote = verified_citation(citation, docs, sources)
                text = doc.get('text', '')
                verified.append(citation)
                if states.get(key,'not-declared') not in ('not-declared','applicable'):
                    issues.append(states[key])
                outline = sections(text)
                containing = [s for s in outline if s['text_start'] <= start < s['text_end']]
                if containing and not containing[-1]['operative']:
                    issues.append('non-operative-section')
                if claim['kind']=='source-claim':
                    # Attributed assertions need complete sentence boundaries. Literal
                    # quotations can be shorter but never certify their interpretation.
                    before, after = text[:start].rstrip(' \t'),text[end:].lstrip(' \t')
                    if ((before and before[-1] not in '\n.!?') or
                            (after and after[0] != '\n' and quote[-1] not in '.!?')):
                        issues.append('partial-sentence')
            except (KeyError,TypeError,ValueError,IndexError):
                issues.append('invalid-or-unavailable-citation')
        roots = [dict(source_id=c['source_id'], path=c['path']) for c in verified]
        closure = required_context(roots, docs, sources, policies, states, policy_hash)
        context_gaps = list(closure['gaps'])
        for entry in closure['entries']:
            if not entry['required']:
                continue
            selection = entry['selection']
            key = (selection['source_id'], selection['path'])
            citations = consumed_by_document.get(key, []) + [c for c in verified
                if (c['source_id'], c['path']) == key]
            if not _covered(entry['text_start'], entry['text_end'], citations):
                context_gaps.append(dict(selection=selection, reason='required-context-not-consumed',
                    text_start=entry['text_start'], text_end=entry['text_end']))
        issues.extend(gap['reason'] for gap in context_gaps if gap['reason'] not in issues)
        conflict_keys.update(name for name, rows in conflicts.items()
            if any((r['source_id'], r['path']) in closure['documents'] for r in rows))
        integrity = 'verified' if verified and len(verified) == len(claim['citations']) else 'failed'
        exact = any(claim['text'] == c['quote'] for c in verified)
        if integrity == 'failed':
            verdict, support = 'unsupported', 'unverified-citations'
        elif conflict_keys:
            verdict, support = 'needs-review', 'conflicted'
        elif issues:
            verdict, support = 'needs-review', 'context-unresolved'
        elif claim['kind'] in ('quotation','source-claim'):
            verdict, support = ('supported','supported-quotation') if exact else ('unsupported','not-quoted')
        else:
            verdict, support = 'needs-review', 'semantic-review-required'
        row = dict(id=claim['id'],verdict=verdict,source_integrity=integrity,semantic_support=support,
            source_reliability='not-assessed', answer_correctness='not-established', issues=issues,
            required_context_gaps=context_gaps,
            conflicts={k:conflicts[k] for k in sorted(conflict_keys)})
        result['claims'].append(row)
    if not claims:
        result['gaps'].append(dict(reason='no-claims'))
    result['status'] = 'complete' if (claims and not result['gaps'] and
        all(row['verdict'] == 'supported' for row in result['claims'])) else 'partial'
    if _size(result) > max_bytes:
        result['status'] = 'partial'
        result['gaps'].append(dict(reason='claim-result-budget'))
        while _size(result) > max_bytes and result['claims']:
            result['pending_claims'].append(result['claims'].pop()['id'])
    if _size(result) > max_bytes:
        raise ValueError('budget cannot hold claim gap report')
    if _corpus(registry,source_ids)[-1] != snapshot:
        raise ValueError('corpus snapshot changed during claim validation; retry')
    result['status'] = 'complete' if (claims and not result['gaps'] and not result['pending_claims']
        and all(row['verdict'] == 'supported' for row in result['claims'])) else 'partial'
    return result
