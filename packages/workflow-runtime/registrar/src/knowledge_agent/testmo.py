"""Explicit GET-only Testmo snapshots in the shared local registry.

Imported text is untrusted data. Normalization is extractive, not a behavior reviewer.
No network calls occur during retrieval. Only sanitized content is persisted.
"""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import stat
import time
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler

from knowledge_agent.knowledge_cache import canonical

ENGINE = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
DETAILS = ('custom_description', 'custom_precondition', 'custom_expected', 'custom_reproduction_steps')
SECRET_NAME = re.compile(r'password|passwd|secret|credential|token|api.?key', re.I)
MAX_PAGES = 50
MAX_REQUESTS = 250
MAX_BODY = 4 * 1024 * 1024
MAX_TOTAL_BYTES = 32 * 1024 * 1024


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def now():
    return datetime.now(timezone.utc).isoformat()


def origin(value):
    url = urlsplit(value)
    if (url.scheme != 'https' or not url.hostname or url.username or url.password or
            url.path not in ('', '/') or url.query or url.fragment or url.port not in (None, 443)):
        raise ValueError('Testmo instance must be an HTTPS origin without credentials, path or query')
    return 'https://' + url.hostname.lower()


def positive(value):
    if type(value) is not int or value <= 0:
        raise ValueError('Testmo IDs must be positive integers')
    return value


class TestmoError(ValueError):
    def __init__(self, reason, retry_after=None):
        super().__init__(reason)
        self.retry_after = retry_after


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class TestmoClient:
    def __init__(self, instance, credential_file):
        self.instance = origin(instance)
        path = Path(credential_file).expanduser().absolute()
        if any(p.is_symlink() for p in (path, *path.parents)):
            raise ValueError('credential symlinks are not admitted')
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, 'r') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
                raise ValueError('credential must be an owner-only regular file')
            self._token = stream.read(8193).strip()
        if not self._token or len(self._token) > 8192 or any(ord(c) <= 32 or ord(c) >= 127 for c in self._token):
            raise ValueError('invalid credential format')
        self.opener = build_opener(NoRedirect())
        self.requests = 0
        self.response_bytes = 0
        self.deadline = time.monotonic() + 180

    def get(self, path, params=None):
        if not re.fullmatch(r'/(folders/\d+|projects/\d+/(cases|templates|fields|states))', path):
            raise TestmoError('endpoint-not-admitted')
        self.requests += 1
        if self.requests > MAX_REQUESTS or time.monotonic() >= self.deadline:
            raise TestmoError('request-budget-exceeded')
        url = self.instance + '/api/v1' + path + ('?' + urlencode(params) if params else '')
        request = Request(url, headers={'Authorization': 'Bearer ' + self._token,
                                       'Accept': 'application/json'}, method='GET')
        try:
            with self.opener.open(request, timeout=min(25, max(0.1, self.deadline - time.monotonic()))) as response:
                raw = response.read(MAX_BODY + 1)
                self.response_bytes += len(raw)
                if len(raw) > MAX_BODY or self.response_bytes > MAX_TOTAL_BYTES:
                    raise TestmoError('response-size-limit')
                result = json.loads(raw)
                if not isinstance(result, dict):
                    raise TestmoError('invalid-response-shape')
                return result
        except HTTPError as exc:
            retry = None
            if exc.code == 429:
                value = exc.headers.get('Retry-After', '')
                try:
                    retry = max(0, int(value))
                except ValueError:
                    try:
                        retry = max(0, int((parsedate_to_datetime(value) - datetime.now(timezone.utc)).total_seconds()) + 1)
                    except (ValueError, TypeError, OverflowError):
                        retry = 60
            raise TestmoError('http-' + str(exc.code), retry_after=retry) from None
        except (URLError, OSError):
            raise TestmoError('network-or-tls-error') from None
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise TestmoError('invalid-json') from None


class TextHTML(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.hidden = 0

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self.hidden += 1
        if tag in ('p', 'div', 'li', 'br', 'tr', 'h1', 'h2', 'h3') and not self.hidden:
            self.parts.append('\n')
        if tag in ('td', 'th') and not self.hidden:
            self.parts.append(' ')

    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self.hidden = max(0, self.hidden - 1)
        if tag in ('p', 'div', 'li', 'tr', 'h1', 'h2', 'h3') and not self.hidden:
            self.parts.append('\n')

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def redact(text):
    text = re.sub(r'(?i)https?://[^\s/@]+:[^\s/@]+@', 'https://[REDACTED]@', text)
    text = re.sub(r'''(?i)\b(password|passwd|secret|credential|token|api[-_ ]?key)\b\s+(?:is\s+)?["'“][^"'”\n]+["'”]''',
                  r'\1 [REDACTED]', text)
    text = re.sub(r'(?im)\b(password|passwd|secret|credential|api[-_ ]?key|access[-_ ]?token)\b\s*[:=]\s*[^\n]+',
                  r'\1: [REDACTED]', text)
    text = re.sub(r'(?i)\bbearer\s+[a-z0-9._~+/=-]+', 'Bearer [REDACTED]', text)
    text = re.sub(r'\b[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}\b', '[REDACTED EMAIL]', text)
    return text


def plain(value, *, redact_content=True):
    if value is None:
        return ''
    if not isinstance(value, str):
        raise TestmoError('invalid-text-field')
    parser = TextHTML()
    parser.feed(value)
    parser.close()
    text = '\n'.join(line.strip() for line in ''.join(parser.parts).splitlines())
    text = re.sub(r'\n+', '\n', text).strip()
    return redact(text) if redact_content else text


def normalize_case(row, source, definitions):
    if not isinstance(row.get('name'), str):
        raise TestmoError('missing-case-title')
    fields = {'name': redact(row['name'])}
    redacted_fields = ['name'] if fields['name'] != row['name'] else []
    allowed = [*DETAILS, *source.get('custom_fields', [])]
    gaps = ['attachments-not-imported', 'title-clarity-not-assessed', 'title-body-agreement-not-assessed',
            'application-behavior-not-verified', 'execution-not-imported']
    for key in dict.fromkeys(allowed):
        if SECRET_NAME.search(key):
            raise TestmoError('secret-field-not-admitted')
        value = plain(row.get(key))
        if value:
            fields[key] = value
            if value != plain(row.get(key), redact_content=False):
                redacted_fields.append(key)
    steps = row.get('custom_steps') or []
    if not isinstance(steps, list):
        raise TestmoError('invalid-steps-shape')
    for index, step in enumerate(steps):
        if not isinstance(step, dict):
            raise TestmoError('invalid-step')
        for key in ('content', 'expected'):
            value = plain(step.get(key))
            if value:
                fields[f'custom_steps[{index}].{key}'] = value
                if value != plain(step.get(key), redact_content=False):
                    redacted_fields.append(f'custom_steps[{index}].{key}')
        if set(step) - {'content', 'expected', 'id'}:
            gaps.append('unmapped-step-fields')
    omitted = sorted(k for k, v in row.items() if k.startswith('custom_') and
                     k not in {*allowed, 'custom_steps'} and v)
    if omitted:
        gaps.append('custom-fields-not-admitted')
    for key in DETAILS:
        if key not in fields:
            gaps.append('unknown-' + key.removeprefix('custom_'))
    # Do not persist raw prose or execution metadata. Hash full response separately in memory.
    raw_content = {k: v for k, v in row.items() if k in {
        'id', 'project_id', 'repo_id', 'folder_id', 'template_id', 'name'} or k.startswith('custom_')}
    revision = dict(case_id=row['id'], project_id=row['project_id'], repository_id=row['repo_id'],
                    folder_id=row['folder_id'], template_id=row.get('template_id'), fields=fields,
                    raw_content_sha256=digest(raw_content), definitions_sha256=digest(definitions),
                    admission_sha256=ENGINE, gaps=sorted(set(gaps)),
                    redacted_fields=redacted_fields,
                    interpretation='extractive; title clarity and title/body agreement not-assessed',
                    review_status='not-reviewed', execution_status='not-imported')
    revision['revision_sha256'] = digest(revision)
    return revision


def pages(client, path, params=None, *, unpaginated=False):
    page, total, seen, rows, ids = 1, None, set(), [], set()
    while page is not None:
        if type(page) is not int or page < 1 or page in seen or len(seen) >= MAX_PAGES:
            raise TestmoError('invalid-pagination-progress')
        seen.add(page)
        payload = client.get(path, dict(params or {}, page=page, per_page=100))
        if unpaginated and isinstance(payload, dict) and isinstance(payload.get('result'), list) and not ({'total', 'next_page', 'page'} & payload.keys()):
            payload = dict(payload, total=len(payload['result']), next_page=None, page=1)
        if (not isinstance(payload, dict) or not isinstance(payload.get('result'), list) or
                not {'total', 'next_page'} <= payload.keys() or
                type(payload['total']) is not int or payload['total'] < 0 or
                payload.get('page', page) != page):
            raise TestmoError('invalid-pagination-shape')
        if total is None:
            total = payload['total']
        if total != payload['total']:
            raise TestmoError('pagination-total-changed')
        batch = payload['result']
        for row in batch:
            if (not isinstance(row, dict) or type(row.get('id')) is not int or row['id'] <= 0 or row['id'] in ids):
                raise TestmoError('duplicate-or-invalid-id')
            ids.add(row['id'])
        rows.extend(batch)
        if len(rows) > total or (payload['next_page'] is not None and not batch):
            raise TestmoError('pagination-total-mismatch')
        page = payload['next_page']
    if len(rows) != total:
        raise TestmoError('pagination-total-mismatch')
    return rows


def fetch(client, source):
    pid, rid, selected = source['project_id'], source['repository_id'], source['folder_id']
    folders = {}

    def folder(fid):
        positive(fid)
        if fid not in folders:
            row = client.get(f'/folders/{fid}').get('result')
            if (not isinstance(row, dict) or row.get('id') != fid or
                    row.get('project_id') != pid or row.get('repo_id') != rid):
                raise TestmoError('folder-scope-mismatch')
            folders[fid] = row
        return folders[fid]

    folder(selected)
    definitions = {}
    for name in ('templates', 'fields', 'states'):
        definitions[name] = pages(client, f'/projects/{pid}/{name}',
                                  {'entity': 'repository_case'} if name == 'fields' else None,
                                  unpaginated=name in ('templates', 'states'))
    rows = pages(client, f'/projects/{pid}/cases', dict(folder_id=selected, recursive='true', expands='fields'))
    result = []
    for row in rows:
        if row.get('project_id') != pid or row.get('repo_id') != rid:
            raise TestmoError('case-scope-mismatch')
        fid, visited = row.get('folder_id'), set()
        while fid != selected:
            if fid in visited or len(visited) >= 100 or type(fid) is not int or fid <= 0:
                raise TestmoError('case-outside-selected-folder')
            visited.add(fid)
            fid = folder(fid).get('parent_id')
        result.append(normalize_case(row, source, definitions))
    return result, digest(definitions)


def add(registry, *, instance, project_id, repository_id, folder_id, credential_file,
        label='Testmo snapshot', custom_fields=()):
    instance = origin(instance)
    project_id, repository_id, folder_id = map(positive, (project_id, repository_id, folder_id))
    credential = Path(credential_file).expanduser().absolute()
    if not credential.is_file() or credential.is_symlink() or credential.stat().st_mode & 0o077:
        raise ValueError('credential must be an existing owner-only regular file')
    credential = credential.resolve(strict=True)
    if not isinstance(label, str) or not label.strip() or len(label) > 256:
        raise ValueError('label must be 1–256 characters')
    if len(custom_fields) > 30 or any(not re.fullmatch(r'custom_[a-zA-Z0-9_]+', f) or SECRET_NAME.search(f)
                                     for f in custom_fields):
        raise ValueError('custom fields must be explicit non-secret custom_* keys')
    with registry._writer(), registry._db() as db:
        existing = [json.loads(r[0]) for r in db.execute('SELECT data FROM sources')]
        for item in existing:
            if item.get('kind') == 'testmo' and (item['instance'], item['project_id'], item['folder_id']) == (instance, project_id, folder_id):
                raise ValueError('Testmo scope already registered')
            if item.get('root') and (Path(item['root']) == credential or Path(item['root']) in credential.parents):
                raise ValueError('credential must be outside registered content roots')
        source = dict(id=uuid.uuid4().hex, kind='testmo', label=label, instance=instance,
                      project_id=project_id, repository_id=repository_id, folder_id=folder_id,
                      credential_file=str(credential), custom_fields=list(custom_fields), enabled=True,
                      root=None, scan_status='never', availability='unchecked', last_scan_at=None,
                      last_attempt_at=None, generation=None, receipt=None, counts={})
        registry._save(db, source)
        return source


def refresh(registry, sid):
    with registry._writer(), registry._db() as db:
        source = registry._source(db, sid)
        if not source['enabled']:
            raise ValueError('source is disabled')
        retry_at = (source.get('last_error') or {}).get('retry_not_before', 0)
        if retry_at > time.time():
            return dict(status='unavailable', source_id=sid, reason='retry-deferred',
                        inventory_preserved=True, retry_after_seconds=int(retry_at - time.time()) + 1)
        source.update(scan_status='scanning', last_attempt_at=now())
        registry._save(db, source)
        try:
            client = TestmoClient(source['instance'], source['credential_file'])
            revisions, definitions = fetch(client, source)
            finished = now()
            db.execute('CREATE TABLE IF NOT EXISTS testmo_revisions (source_id TEXT, revision TEXT, data TEXT, PRIMARY KEY(source_id, revision))')
            db.execute('BEGIN IMMEDIATE')
            previous = {p: json.loads(d) for p, d in db.execute('SELECT path, data FROM files WHERE source_id=?', (sid,))}
            db.execute('DELETE FROM chunks WHERE source_id=?', (sid,))
            observed = set()
            for revision in revisions:
                rev = revision['revision_sha256']
                path = f"cases/{revision['case_id']}"
                observed.add(path)
                db.execute('INSERT OR IGNORE INTO testmo_revisions VALUES (?, ?, ?)', (sid, rev, json.dumps(revision)))
                item = dict(source_id=sid, path=path, case_id=revision['case_id'], sha256=rev,
                            raw_content_sha256=revision['raw_content_sha256'], status='indexed',
                            observed_at=finished, gaps=revision['gaps'])
                db.execute('INSERT OR REPLACE INTO files VALUES (?, ?, ?)', (sid, path, json.dumps(item)))
                ordinal = 0
                for locator, value in revision['fields'].items():
                    # Small field chunks retain exact character positions in normalized admitted text.
                    for start in range(0, len(value), 1200):
                        body = value[start:start + 1200]
                        ordinal += 1
                        chunk = dict(kind='testmo', sha256=rev, locator=locator, text_start=start,
                                     text_end=start + len(body), extractor=ENGINE,
                                     chunk_sha256=hashlib.sha256(body.encode()).hexdigest())
                        from knowledge_agent.source_registry import _tokens
                        terms = ' ' + ' '.join(sorted(_tokens(body))) + ' '
                        db.execute('INSERT INTO chunks VALUES (?, ?, ?, ?, ?)', (sid, path, ordinal, json.dumps(chunk), terms))
            for path, item in previous.items():
                if path not in observed:
                    item.update(status='no-longer-visible-in-scope', observed_at=finished)
                    db.execute('INSERT OR REPLACE INTO files VALUES (?, ?, ?)', (sid, path, json.dumps(item)))
            counts = dict(indexed=len(revisions), no_longer_visible=len(set(previous) - observed))
            from knowledge_agent.source_registry import ENGINE as registry_engine
            receipt = dict(provider='testmo', engine_sha256=ENGINE, definitions_sha256=definitions,
                           registry_engine_sha256=registry_engine,
                           snapshot=digest(sorted(r['revision_sha256'] for r in revisions)),
                           fetched_from=source['last_attempt_at'], fetched_to=finished,
                           remote_freshness='unknown', consistency='paginated-observation-not-atomic',
                           gaps=dict(Counter(g for r in revisions for g in r['gaps'])))
            source.update(scan_status='complete', availability='available', last_scan_at=finished,
                          generation=uuid.uuid4().hex, counts=counts, receipt=receipt, last_error=None)
            registry._save(db, source)
            db.execute('COMMIT')
            return dict(status='complete', source_id=sid, counts=counts, receipt=receipt)
        except BaseException as exc:
            if db.in_transaction:
                db.execute('ROLLBACK')
            interrupted = isinstance(exc, (KeyboardInterrupt, SystemExit))
            reason = str(exc) if isinstance(exc, TestmoError) else 'refresh-validation-or-storage-failed'
            source.update(scan_status='interrupted' if interrupted else 'unavailable',
                          availability='unchecked', last_error=dict(reason=reason,
                          retry_after_seconds=getattr(exc, 'retry_after', None),
                          retry_not_before=time.time() + (getattr(exc, 'retry_after', None) or 0)))
            registry._save(db, source)
            if interrupted:
                raise
            return dict(status='unavailable', source_id=sid, reason=reason, inventory_preserved=True,
                        retry_after_seconds=getattr(exc, 'retry_after', None))


def verify_chunk(registry, source, path, chunk):
    with registry._db() as db:
        row = db.execute('SELECT data FROM testmo_revisions WHERE source_id=? AND revision=?',
                         (source['id'], chunk['sha256'])).fetchone()
    if row is None:
        raise ValueError('cached revision missing')
    revision = json.loads(row[0])
    rev = revision.pop('revision_sha256')
    if digest(revision) != rev or rev != chunk['sha256'] or chunk['extractor'] != ENGINE:
        raise ValueError('cached revision changed')
    if path != f"cases/{revision['case_id']}":
        raise ValueError('case identity mismatch')
    text = revision['fields'][chunk['locator']]
    body = text[chunk['text_start']:chunk['text_end']]
    if hashlib.sha256(body.encode()).hexdigest() != chunk['chunk_sha256']:
        raise ValueError('cached span changed')
    cite = dict(kind='testmo', source_id=source['id'], path=path, instance=source['instance'],
                project_id=source['project_id'], repository_id=source['repository_id'],
                selected_folder_id=source['folder_id'], case_id=revision['case_id'],
                folder_id=revision['folder_id'], locator=chunk['locator'], sha256=rev,
                raw_content_sha256=revision['raw_content_sha256'],
                field_sha256=hashlib.sha256(text.encode()).hexdigest(),
                text_start=chunk['text_start'], text_end=chunk['text_end'], quote=body,
                evidence='title-derived' if chunk['locator'] == 'name' else 'detail-derived',
                fetched_from=source['receipt']['fetched_from'], fetched_to=source['receipt']['fetched_to'],
                remote_freshness='unknown', refresh_status=source['scan_status'],
                interpretation=revision['interpretation'], gaps=revision['gaps'],
                redacted_fields=revision['redacted_fields'],
                review_status='not-reviewed', execution_status='not-imported')
    return body, cite
