"""Atomic remote snapshots with typed, byte-checked normalized-text citations."""
from collections import Counter
from datetime import datetime, timezone
import hashlib
import importlib
import json
from pathlib import Path
import re
import time
import uuid

from knowledge_agent.knowledge_cache import canonical

KINDS = ('shortcut', 'notion')


class RemoteError(ValueError):
    def __init__(self, reason, retry_after=None):
        super().__init__(reason)
        self.retry_after = retry_after


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def now():
    return datetime.now(timezone.utc).isoformat()


def adapter(kind):
    if kind not in KINDS:
        raise RemoteError('unsupported-remote-source')
    return importlib.import_module('knowledge_agent.'+kind)


def engine(kind):
    # Include the provider and transport policy so old receipts cannot mask code changes.
    paths = [Path(__file__), Path(__file__).with_name('remote_access.py'), Path(adapter(kind).__file__)]
    return digest([hashlib.sha256(p.read_bytes()).hexdigest() for p in paths])


def add(registry, *, kind, selection, credential_profile, grant_file, label=None):
    from knowledge_agent.remote_access import load_grant, validate_profile
    selected = adapter(kind).validate_selection(selection)
    profile = validate_profile(kind, credential_profile)
    grant = Path(grant_file).expanduser().absolute()
    label = label if label is not None else kind+' selected sources'
    if not isinstance(label, str) or not label.strip() or len(label) > 256:
        raise RemoteError('invalid-source-label')
    source = dict(id=uuid.uuid4().hex, kind=kind, label=label, selection=selected,
        credential_profile=profile, grant_file=str(grant), enabled=True, root=None,
        scan_status='never', availability='unchecked', last_scan_at=None,
        last_attempt_at=None, generation=None, receipt=None, counts={})
    load_grant(source)
    with registry._writer(), registry._db() as db:
        for row in db.execute('SELECT data FROM sources'):
            existing = json.loads(row[0])
            if (existing.get('kind') == kind and existing.get('selection') == selected and
                    existing.get('credential_profile') == profile):
                raise RemoteError('remote-scope-already-registered')
            if existing.get('root') and Path(existing['root']) in grant.parents:
                raise RemoteError('grant-must-be-outside-content-roots')
        registry._save(db, source)
    return source


def unavailable_reason(source, registry_engine):
    from knowledge_agent.remote_access import load_grant
    try:
        load_grant(source)
    except RemoteError:
        return 'remote-access-not-authorized'
    receipt = source.get('receipt') or {}
    if not receipt:
        return source['scan_status']
    if (receipt.get('engine_sha256') != engine(source['kind']) or
            receipt.get('registry_engine_sha256') != registry_engine):
        return 'provider-version-changed'
    if source.get('access_blocked'):
        return 'remote-access-denied-refresh-required'
    return None


def _revision(doc, source, client):
    required = {'path', 'object_id', 'url', 'title', 'text', 'updated_at', 'gaps', 'raw_content_sha256'}
    if not isinstance(doc, dict) or not required <= set(doc):
        raise RemoteError('invalid-remote-document')
    if (not isinstance(doc['text'], str) or not doc['text'] or len(doc['text'].encode()) > 16*1024*1024 or
            not isinstance(doc['title'], str) or not isinstance(doc['gaps'], list) or
            any(not isinstance(g, str) or not re.fullmatch(r'[a-z0-9:_-]{1,256}',g) for g in doc['gaps']) or
            not isinstance(doc['raw_content_sha256'],str) or not re.fullmatch(r'[0-9a-f]{64}', doc['raw_content_sha256'])):
        raise RemoteError('invalid-remote-document')
    expected = ('stories/' if source['kind'] == 'shortcut' else 'pages/')+str(doc['object_id'])
    ids = source['selection'].get('story_ids', source['selection'].get('page_ids'))
    if doc['path'] != expected or str(doc['object_id']) not in {str(v) for v in ids}:
        raise RemoteError('remote-document-scope-mismatch')
    from urllib.parse import urlsplit
    url = urlsplit(doc['url'])
    allowed_hosts = ('app.shortcut.com',) if source['kind'] == 'shortcut' else ('www.notion.so','notion.so','app.notion.com')
    if (url.scheme != 'https' or url.hostname not in allowed_hosts or url.username or url.password or
            url.port not in (None,443) or url.query or url.fragment):
        raise RemoteError('invalid-document-url')
    if doc['updated_at'] is not None:
        try:
            stamp = datetime.fromisoformat(doc['updated_at'].replace('Z','+00:00'))
            if stamp.tzinfo is None:
                raise ValueError
        except (AttributeError, TypeError, ValueError):
            raise RemoteError('invalid-upstream-timestamp') from None
    # Persist only the documented admitted fields, never raw provider payloads.
    value = {k: doc[k] for k in required}
    value = client.sanitize(value)
    from knowledge_agent.testmo import redact
    value['text'] = redact(value['text'])
    value['title'] = redact(value['title'])
    value.update(kind=source['kind'], extraction='normalized-remote-text',
        interpretation='extractive-not-reviewed', redaction='credential-and-pattern-filtered')
    value['revision_sha256'] = digest(value)
    return value


def refresh(registry, sid):
    from knowledge_agent.remote_access import ProfileClient, load_grant
    from knowledge_agent.source_registry import ENGINE as registry_engine, _tokens
    with registry._writer(), registry._db() as db:
        source = registry._source(db, sid)
        if not source['enabled']:
            raise RemoteError('source-disabled')
        previous_success = {k: source.get(k) for k in ('receipt', 'generation', 'counts', 'last_scan_at')}
        retry_at = (source.get('last_error') or {}).get('retry_not_before',0)
        if retry_at > time.time():
            return dict(status='unavailable',source_id=sid,reason='retry-deferred', inventory_preserved=True,
                retry_after_seconds=int(retry_at-time.time())+1)
        source.update(scan_status='scanning',last_attempt_at=now())
        registry._save(db,source)
        deadline = time.monotonic()+180
        try:
            grant = load_grant(source)
            client = ProfileClient(source)
            fetched = adapter(source['kind']).fetch(client,source)
            if not isinstance(fetched,list):
                raise RemoteError('invalid-document-list')
            revisions = [_revision(doc,source,client) for doc in fetched]
            paths = [r['path'] for r in revisions]
            ids = source['selection'].get('story_ids',source['selection'].get('page_ids'))
            if len(set(paths)) != len(paths) or {str(r['object_id']) for r in revisions} != {str(i) for i in ids}:
                raise RemoteError('incomplete-or-duplicate-selected-objects')
            if load_grant(source) != grant:
                raise RemoteError('grant-changed-during-refresh')
            if time.monotonic() >= deadline:
                raise RemoteError('refresh-deadline-exceeded')
            finished = now()
            provider_engine = engine(source['kind'])
            db.execute('CREATE TABLE IF NOT EXISTS remote_revisions (source_id TEXT, revision TEXT, data TEXT, PRIMARY KEY(source_id, revision))')
            db.execute('BEGIN IMMEDIATE')
            db.execute('DELETE FROM files WHERE source_id=?',(sid,))
            db.execute('DELETE FROM chunks WHERE source_id=?',(sid,))
            for revision in revisions:
                rev, path, body = revision['revision_sha256'], revision['path'], revision['text']
                stored = db.execute('SELECT data FROM remote_revisions WHERE source_id=? AND revision=?',(sid,rev)).fetchone()
                if stored is not None and json.loads(stored[0]) != revision:
                    raise RemoteError('cached-revision-changed')
                db.execute('INSERT OR IGNORE INTO remote_revisions VALUES (?, ?, ?)',(sid,rev,json.dumps(revision)))
                chunk_count=0
                for start in range(0,len(body),1200):
                    chunk_count+=1
                    text=body[start:start+1200]
                    chunk=dict(kind=source['kind'],sha256=rev,text_start=start,text_end=start+len(text),
                        extractor=provider_engine,chunk_sha256=hashlib.sha256(text.encode()).hexdigest())
                    terms=' '+' '.join(sorted(_tokens(text+' '+path)))+' '
                    db.execute('INSERT INTO chunks VALUES (?, ?, ?, ?, ?)',(sid,path,chunk_count,json.dumps(chunk),terms))
                item=dict(source_id=sid,path=path,object_id=revision['object_id'],sha256=rev,
                    status='indexed',observed_at=finished,gaps=revision['gaps'],chunks=chunk_count)
                db.execute('INSERT INTO files VALUES (?, ?, ?)',(sid,path,json.dumps(item)))
            gaps=dict(Counter(g for r in revisions for g in r['gaps']))
            receipt=dict(provider=source['kind'],engine_sha256=provider_engine,registry_engine_sha256=registry_engine,
                snapshot=digest(sorted(r['revision_sha256'] for r in revisions)),
                fetched_from=source['last_attempt_at'],fetched_to=finished,remote_freshness='unknown',
                consistency='paginated-observation-not-atomic',gaps=gaps,
                profile=source['credential_profile'],grant_id=grant['grant_id'],consumer=grant['consumer'],
                upstream_identity='not-independently-verified',source_permissions='implemented-requests-GET-only')
            source.update(scan_status='complete',availability='available',last_scan_at=finished,
                generation=uuid.uuid4().hex,counts={'indexed':len(revisions)},receipt=receipt,last_error=None,access_blocked=False)
            registry._save(db,source)
            if load_grant(source) != grant:
                raise RemoteError('grant-changed-during-refresh')
            if time.monotonic() >= deadline:
                raise RemoteError('refresh-deadline-exceeded')
            db.execute('COMMIT')
            return dict(status='complete',source_id=sid,generation=source['generation'],counts=source['counts'],receipt=receipt)
        except BaseException as exc:
            if db.in_transaction:
                db.execute('ROLLBACK')
            source.update(previous_success)
            interrupted=isinstance(exc,(KeyboardInterrupt,SystemExit))
            reason=str(exc) if isinstance(exc,RemoteError) else 'refresh-validation-or-storage-failed'
            # Only bounded diagnostic codes from trusted adapter code are persisted.
            if not re.fullmatch(r'[a-z0-9-]{1,120}',reason):
                reason='refresh-validation-or-storage-failed'
            retry=getattr(exc,'retry_after',None)
            retry=retry if type(retry) is int and 0<=retry<=86400 else None
            blocked=reason in ('http-401','http-403','http-404') or reason.startswith(('grant-','credential-','unsafe-grant'))
            source.update(scan_status='interrupted' if interrupted else 'unavailable',availability='unchecked',
                access_blocked=bool(source.get('access_blocked') or blocked),
                last_error=dict(reason=reason,retry_after_seconds=retry,retry_not_before=time.time()+(retry or 0)))
            registry._save(db,source)
            if interrupted:
                raise
            return dict(status='unavailable',source_id=sid,reason=reason,inventory_preserved=True,retry_after_seconds=retry)


def revision_text(registry, source, path, sha):
    with registry._db() as db:
        inventory = [(p, json.loads(data)) for p, data in db.execute(
            'SELECT path, data FROM files WHERE source_id=? ORDER BY path',(source['id'],))]
        selected = next((item for p,item in inventory if p==path),None)
        if (selected is None or selected.get('status')!='indexed' or selected.get('sha256')!=sha or
                any(item.get('path')!=p or item.get('source_id')!=source['id'] or item.get('status')!='indexed'
                    for p,item in inventory) or
                digest(sorted(item['sha256'] for _,item in inventory))!=source['receipt']['snapshot']):
            raise RemoteError('cached-revision-not-current')
        row=db.execute('SELECT data FROM remote_revisions WHERE source_id=? AND revision=?',(source['id'],sha)).fetchone()
    if row is None:
        raise RemoteError('cached-revision-missing')
    value=json.loads(row[0]); claimed=value.pop('revision_sha256')
    if digest(value)!=claimed or sha!=claimed or value['path']!=path or value['kind']!=source['kind']:
        raise RemoteError('cached-revision-changed')
    return value


def verify_chunk(registry, source, path, chunk):
    value=revision_text(registry,source,path,chunk['sha256'])
    if chunk.get('kind', source['kind'])!=source['kind'] or chunk['extractor']!=engine(source['kind']):
        raise RemoteError('provider-version-changed')
    text=value['text']; start,end=chunk['text_start'],chunk['text_end']
    if type(start) is not int or type(end) is not int or not 0<=start<end<=len(text):
        raise RemoteError('cached-span-changed')
    body=text[start:end]
    if hashlib.sha256(body.encode()).hexdigest()!=chunk['chunk_sha256']:
        raise RemoteError('cached-span-changed')
    receipt=source['receipt']; first=text[:start].count('\n')+1
    return body,dict(kind=source['kind'],source_id=source['id'],path=path,sha256=chunk['sha256'],
        object_id=value['object_id'],url=value['url'],title=value['title'],updated_at=value['updated_at'],
        raw_content_sha256=value['raw_content_sha256'],text_start=start,text_end=end,quote=body,
        start=first,end=first+body.count('\n')-int(body.endswith('\n')),extraction=value['extraction'],
        fetched_from=receipt['fetched_from'],fetched_to=receipt['fetched_to'],remote_freshness='unknown',
        refresh_status=source['scan_status'],gaps=value['gaps'],interpretation=value['interpretation'],
        redaction=value['redaction'],profile_id=source['credential_profile']['profile_id'])
