"""SA-001: explicit, bounded local history. SQLite is the sole archive authority.

Manifests are canonical JSON bytes. Blobs are originals or exact UTF-8 representations;
all origins remain separate manifest entries even when bytes deduplicate. No live reads
or current engine fingerprints are necessary to use a published representation.
"""
from __future__ import annotations

import base64
from contextlib import closing, contextmanager
from datetime import datetime, timezone
import errno
import fnmatch
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import sys
import tempfile
import uuid

from knowledge_agent.knowledge import _path

MAX_RESPONSE = 1024 * 1024
MAX_BUNDLE = 192 * 1024 * 1024
BM25_RANKER = 'sqlite-fts5-bm25-v1'
BM25_TOKENIZER = 'unicode61 remove_diacritics 0'
BM25_MAX_TERMS = 32
BM25_MAX_SOURCES = 8
BM25_MAX_DOCUMENTS = 10000
BM25_MAX_TEXT_BYTES = 64 * 1024 * 1024
DEFAULT_LIMITS = dict(entries=1000, file_bytes=8*1024*1024, total_bytes=64*1024*1024,
                      text_bytes=8*1024*1024)
POLICY = dict(name='registrar-bounded-extraction', version=1, timeout_seconds=10,
              memory_bytes=512*1024*1024, zip_members=1000, zip_expanded_bytes=32*1024*1024)
DDL = [
    'CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY, data TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS files(source_id TEXT, path TEXT, data TEXT NOT NULL, PRIMARY KEY(source_id,path))',
    'CREATE TABLE IF NOT EXISTS chunks(source_id TEXT, path TEXT, ordinal INTEGER, data TEXT NOT NULL, tokens TEXT, PRIMARY KEY(source_id,path,ordinal))',
    'CREATE TABLE IF NOT EXISTS knowledge_generations(id TEXT PRIMARY KEY, source_id TEXT NOT NULL, source_generation TEXT NOT NULL, extractor_revision TEXT NOT NULL, payload_sha256 TEXT NOT NULL, data TEXT NOT NULL)',
    'CREATE INDEX IF NOT EXISTS knowledge_generations_source ON knowledge_generations(source_id,source_generation)',
    'CREATE TABLE IF NOT EXISTS revision_sets(id TEXT PRIMARY KEY, data BLOB NOT NULL)',
    'CREATE TABLE IF NOT EXISTS graph_record_identities(id TEXT PRIMARY KEY, data BLOB NOT NULL)',
    'CREATE TABLE IF NOT EXISTS graph_retractions(id TEXT PRIMARY KEY)',
    'CREATE TABLE IF NOT EXISTS graph_generations(id TEXT PRIMARY KEY, data BLOB NOT NULL)',
    'CREATE TABLE IF NOT EXISTS archive_blobs(sha256 TEXT PRIMARY KEY, data BLOB NOT NULL)',
    'CREATE TABLE IF NOT EXISTS archive_generations(id TEXT PRIMARY KEY, source_id TEXT NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, manifest BLOB NOT NULL, UNIQUE(source_id,request_key))',
]


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode('utf-8')


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def _ddl(db, statement):
    db.execute(statement)


def migrate(db):
    # Caller holds writer lock; re-read version after lock acquisition.
    version = db.execute('PRAGMA user_version').fetchone()[0]
    if version not in (0, 1, 2, 3, 4):
        raise ValueError('unsupported registry schema')
    if version == 4 and db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='graph_retractions'").fetchone():
        return
    db.execute('BEGIN IMMEDIATE')
    try:
        for statement in DDL:
            _ddl(db, statement)
        if version == 4:
            # A phase-2 schema-4 workspace can already contain retractions. The
            # backfill and table creation commit together before publication.
            for graph_id, raw in db.execute('SELECT id,data FROM graph_generations'):
                if digest(bytes(raw)) != graph_id:
                    raise ValueError('graph storage integrity mismatch during migration')
                payload = json.loads(raw)
                if canonical(payload) != bytes(raw):
                    raise ValueError('noncanonical graph storage during migration')
                for assertion in payload['assertions']:
                    if assertion['lifecycle'] == 'retracted':
                        _id(assertion['id'])
                        db.execute('INSERT OR IGNORE INTO graph_retractions VALUES (?)',
                                   (assertion['id'],))
        db.execute('PRAGMA user_version=4')
        db.execute('COMMIT')
    except BaseException:
        db.execute('ROLLBACK')
        raise


def bounded(value, max_bytes=MAX_RESPONSE):
    _integer(max_bytes, 1024, MAX_RESPONSE, 'response bytes')
    if len(canonical(value)) > max_bytes:
        raise ValueError('archive response exceeds byte budget; use a smaller page')
    return value


def _integer(value, low, high, label):
    if type(value) is not int or not low <= value <= high:
        raise ValueError('invalid ' + label)
    return value


def _id(value):
    if not isinstance(value, str) or not re.fullmatch('[0-9a-f]{32}', value):
        raise ValueError('invalid archive generation')
    return value


def _hash_id(value):
    if not isinstance(value, str) or not re.fullmatch('[0-9a-f]{64}', value):
        raise ValueError('invalid archive hash')
    return value


def _config(source):
    if not source.get('root') or source.get('kind') in ('testmo', 'shortcut', 'notion'):
        raise ValueError('archive requires a registered local source')
    return dict(source_id=source['id'], root=source['root'], recursive=source['recursive'], exclude=source['exclude'])


def _origin(source):
    return digest(canonical(dict(source_id=source['id'], root=source['root'])))


def _access(source, manifest=None):
    config = _config(source)
    if not source['enabled']:
        raise ValueError('source is disabled')
    if manifest is not None and manifest['configuration_sha256'] != digest(canonical(config)):
        # Refuse the whole manifest rather than disclose now-excluded membership.
        raise ValueError('archive admission configuration changed')
    return config


def _capture_policy():
    from knowledge_agent import knowledge, macos_ocr, structure
    return dict(POLICY, implementation_sha256=digest(canonical({
        'knowledge': digest(Path(knowledge.__file__).read_bytes()),
        'structure': digest(Path(structure.__file__).read_bytes()),
        'worker': digest(Path(__file__).with_name('archive_worker.py').read_bytes()),
        'macos_ocr': digest(Path(macos_ocr.__file__).read_bytes()),
        'extractors': {key: knowledge._signature(value) for key, value in knowledge.DEFAULT_EXTRACTORS.items()},
    })))


def _limits(limits):
    if limits is None:
        return dict(DEFAULT_LIMITS)
    if not isinstance(limits, dict) or set(limits) - set(DEFAULT_LIMITS):
        raise ValueError('invalid archive limits')
    result = dict(DEFAULT_LIMITS, **limits)
    for key, value in result.items():
        _integer(value, 1, DEFAULT_LIMITS[key], key)
    return result


@contextmanager
def _directory(path):
    """Open each absolute parent without following a symlink, including ancestors."""
    path = Path(os.path.abspath(path))
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


def _read_file(root, relative, limit):
    _path(relative)
    with _directory(Path(root) / Path(relative).parent) as parent:
        fd = os.open(Path(relative).name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        with os.fdopen(fd, 'rb') as stream:
            before = os.fstat(stream.fileno())
            if not stat.S_ISREG(before.st_mode):
                raise ValueError('source is not a regular file')
            if before.st_size > limit:
                return None, before.st_size
            raw = stream.read(limit + 1)
            after = os.fstat(stream.fileno())
            if len(raw) > limit:
                return None, after.st_size
            if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
                    after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
                raise ValueError('source changed during read')
            return raw, len(raw)


def _enumerate(source, limit):
    result = []
    def walk(relative=''):
        directory = Path(source['root']) / relative
        with _directory(directory) as fd:
            with os.scandir(fd) as stream:
                children = []
                for entry in stream:
                    children.append((entry.name, entry.is_symlink(), entry.is_dir(follow_symlinks=False), entry.is_file(follow_symlinks=False)))
                    if len(result) + len(children) > limit:
                        raise ValueError('archive enumeration limit exceeded')
            for name, symlink, is_dir, is_file in sorted(children):
                path = f'{relative}/{name}' if relative else name
                if len(path.encode()) > 4096:
                    raise ValueError('archive path limit exceeded')
                _path(path)
                excluded = any(fnmatch.fnmatchcase(path, p) or ('/' not in p and fnmatch.fnmatchcase(name, p)) for p in source['exclude'])
                kind = ('excluded' if excluded else 'symlink' if symlink else
                        'directory' if is_dir and source['recursive'] else 'not-recursive' if is_dir else
                        'file' if is_file else 'not-regular-file')
                result.append((path, kind))
                if len(result) > limit:
                    raise ValueError('archive enumeration limit exceeded')
                if kind == 'directory':
                    walk(path)
    walk()
    return sorted(result)


def _extract(raw, path, text_limit, ocr_mode='none'):
    # Child output is a file with RLIMIT_FSIZE, never an unbounded communicate pipe.
    with tempfile.TemporaryDirectory(prefix='registrar-extract-') as temp:
        original, output = Path(temp)/'original', Path(temp)/'result'
        original.write_bytes(raw)
        command = [sys.executable, '-m', 'knowledge_agent.archive_worker', str(original), str(output), path, str(text_limit), ocr_mode]
        try:
            child = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, timeout=POLICY['timeout_seconds'], check=False)
        except subprocess.TimeoutExpired:
            return dict(status='limited', reason='extraction-timeout')
        if child.returncode or not output.exists():
            return dict(status='limited', reason='extraction-resource-boundary')
        if output.stat().st_size > text_limit * 6 + 65536:
            return dict(status='limited', reason='extraction-output-limit')
        value = json.loads(output.read_bytes())
        if value.get('status') == 'captured' and len(value['text'].encode()) > text_limit:
            return dict(status='limited', reason='extraction-output-limit')
        return value


def _put_blob(db, key, raw):
    if digest(raw) != key:
        raise ValueError('archive blob hash mismatch')
    old = db.execute('SELECT data FROM archive_blobs WHERE sha256=?', (key,)).fetchone()
    if old is not None and bytes(old[0]) != raw:
        raise ValueError('archive blob identity collision')
    db.execute('INSERT OR IGNORE INTO archive_blobs VALUES (?,?)', (key, raw))


def _publish(db, manifest, blobs):
    # Validate even internally produced metadata before publishing any blob.
    try:
        def get_blob(key, length):
            value = blobs[key]
            if len(value) != length or digest(value) != key:
                raise ValueError('archive publication blob mismatch')
            return value
        _validate_manifest(manifest, get_blob)
    except (KeyError, TypeError, UnicodeError, RecursionError) as exc:
        raise ValueError('invalid archive publication manifest') from exc
    raw = canonical(manifest)
    for key, value in blobs.items():
        _put_blob(db, key, value)
    row = (manifest['generation'], manifest['source_id'], manifest['request_key'], manifest['request_fingerprint'], digest(raw), raw)
    old = db.execute('SELECT * FROM archive_generations WHERE id=? OR (source_id=? AND request_key=?)',
                     (row[0], row[1], row[2])).fetchall()
    if old and (len(old) != 1 or tuple(old[0]) != row):
        raise ValueError('archive generation identity collision')
    db.execute('INSERT OR IGNORE INTO archive_generations VALUES (?,?,?,?,?,?)', row)


def _receipt(manifest, replayed=False):
    return bounded(dict(schema=1, status='complete', source_id=manifest['source_id'], generation=manifest['generation'],
        manifest_sha256=digest(canonical(manifest)), request_key=manifest['request_key'],
        request_fingerprint=manifest['request_fingerprint'], observed_at=manifest['observed_at'],
        replayed=replayed, preservation=manifest['preservation'], counts=manifest['counts'],
        evidence='archived-snapshot', current_original='not-checked'))


def capture_source(registry, source_id, *, request_key, limits=None, ocr_mode='none'):
    if not isinstance(request_key, str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}', request_key):
        raise ValueError('request key requires 1–128 ASCII identity characters')
    if ocr_mode not in ('none', 'macos-vision'):
        raise ValueError('unsupported archive OCR mode')
    limits = _limits(limits)
    with registry._writer(), registry._db() as db:
        source = registry._source(db, source_id)
        config = _access(source)
        binding = dict(configuration_sha256=digest(canonical(config)), limits=limits,
                       policy=_capture_policy(), ocr_mode=ocr_mode)
        fingerprint = digest(canonical(binding))
        old = db.execute('SELECT id,fingerprint FROM archive_generations WHERE source_id=? AND request_key=?',
                         (source_id, request_key)).fetchone()
        if old:
            if old[1] != fingerprint:
                raise ValueError('request key has different capture settings')
            return _receipt(_load(registry, db, source_id, old[0]), True)
        observed = datetime.now(timezone.utc).isoformat()
        generation = uuid.uuid4().hex
        membership = _enumerate(source, limits['entries'])
        documents, blobs, checks, total, text_total = [], {}, {}, 0, 0
        for path, kind in membership:
            item = dict(path=path, observation=observed, status='excluded', reason=kind,
                        original=None, representation=None, gaps=[])
            if kind == 'file':
                try:
                    raw, length = _read_file(source['root'], path, limits['file_bytes'])
                except OSError:
                    raw, length = None, None
                    item.update(status='unavailable', reason='source-unavailable')
                else:
                    if raw is None or total + length > limits['total_bytes']:
                        item.update(status='limited', reason='original-byte-limit')
                        checks[path] = (None, length)
                    else:
                        total += length
                        original_hash = digest(raw)
                        blobs[original_hash] = raw
                        checks[path] = (original_hash, length)
                        item.update(status='captured', reason=None, original=dict(sha256=original_hash, bytes=length))
                        remaining_text = DEFAULT_LIMITS['total_bytes'] - text_total
                        if remaining_text:
                            text_limit = min(limits['text_bytes'], remaining_text)
                            extracted = (_extract(raw, path, text_limit, ocr_mode) if ocr_mode != 'none'
                                         else _extract(raw, path, text_limit))
                        else:
                            extracted = dict(status='limited', reason='generation-text-byte-limit')
                        if extracted['status'] == 'captured':
                            text = extracted.pop('text').encode('utf-8')
                            text_total += len(text)
                            text_hash = digest(text)
                            blobs[text_hash] = text
                            item['representation'] = dict(version=1, original_sha256=original_hash,
                                sha256=text_hash, bytes=len(text), coordinate_space='unicode-codepoints',
                                encoding='utf-8', extraction=extracted['extraction'],
                                extractor_signature=extracted['extractor_signature'], settings=extracted['settings'],
                                omissions=extracted['gaps'])
                        item['gaps'] = extracted.get('gaps', [extracted.get('reason', 'extraction-unavailable')])
                        item['extraction_status'] = extracted['status']
            if item['status'] in ('limited', 'unavailable'):
                item['gaps'] = [item['reason']]
            documents.append(item)
        if membership != _enumerate(source, limits['entries']):
            raise ValueError('source membership changed during capture')
        for path, (sha, length) in checks.items():
            raw, current_length = _read_file(source['root'], path, limits['file_bytes'])
            if current_length != length or (sha is not None and (raw is None or digest(raw) != sha)):
                raise ValueError('source bytes changed during capture')
        counts = {status: sum(d['status'] == status for d in documents)
                  for status in ('captured', 'excluded', 'unsupported', 'unavailable', 'limited')}
        manifest = dict(schema=1, canonicalization='json-sorted-compact-utf8', hash_algorithm='sha256',
            source_id=source_id, generation=generation, origin_binding=_origin(source),
            request_key=request_key, request_fingerprint=fingerprint, **binding,
            observed_at=observed, documents=documents, counts=counts,
            preservation='incomplete' if counts['limited'] or counts['unavailable'] else 'complete-admitted',
            capabilities=dict(retrieval='exact-lexical', visual='unsupported',
                              ocr='unsupported' if ocr_mode == 'none' else 'macos-vision-optional',
                              asset_inventory='partial-or-unknown', structural_navigation='unsupported'))
        if len(canonical(manifest)) > 4*MAX_RESPONSE:
            raise ValueError('archive manifest size limit')
        db.execute('BEGIN IMMEDIATE')
        try:
            if registry._source(db, source_id) != source:
                raise ValueError('source configuration changed during capture')
            _publish(db, manifest, blobs)
            db.execute('COMMIT')
        except BaseException:
            db.execute('ROLLBACK')
            raise
        return _receipt(manifest)


def _blob(db, key, length):
    _hash_id(key)
    size = db.execute('SELECT length(data) FROM archive_blobs WHERE sha256=?', (key,)).fetchone()
    if size is None or size[0] != length or not 0 <= length <= DEFAULT_LIMITS['file_bytes']:
        raise ValueError('archive blob integrity mismatch')
    row = db.execute('SELECT data FROM archive_blobs WHERE sha256=?', (key,)).fetchone()
    if row is None or len(row[0]) != length or digest(row[0]) != key:
        raise ValueError('archive blob integrity mismatch')
    return bytes(row[0])


def _required(value, fields, label):
    if not isinstance(value, dict) or not set(fields.split()).issubset(value):
        raise ValueError('invalid archive ' + label)


def _strings(value, label):
    if not isinstance(value, list) or any(not isinstance(v, str) or not 1 <= len(v) <= 128 for v in value):
        raise ValueError('invalid archive ' + label)


def _timestamp(value):
    if not isinstance(value, str) or len(value) > 80:
        raise ValueError('invalid archive observation')
    if datetime.fromisoformat(value).tzinfo is None:
        raise ValueError('archive observation requires timezone')


def _validate_manifest(manifest, get_blob):
    _required(manifest, 'schema canonicalization hash_algorithm policy generation limits configuration_sha256 '
        'request_fingerprint documents request_key origin_binding source_id observed_at counts preservation capabilities', 'manifest')
    _timestamp(manifest['observed_at'])
    _required(manifest['capabilities'], 'retrieval visual ocr asset_inventory structural_navigation', 'capabilities')
    if any(not isinstance(v, str) or not v for v in manifest['capabilities'].values()):
        raise ValueError('invalid archive capabilities')
    if not isinstance(manifest, dict) or not isinstance(manifest.get('policy'), dict):
        raise ValueError('invalid archive manifest or extraction policy')
    if manifest.get('schema') != 1 or manifest.get('canonicalization') != 'json-sorted-compact-utf8' or manifest.get('hash_algorithm') != 'sha256':
        raise ValueError('unsupported archive manifest')
    if manifest.get('policy', {}).get('version') != 1 or manifest['policy'].get('name') != POLICY['name']:
        raise ValueError('unsupported archive extraction policy')
    _required(manifest['policy'], 'name version timeout_seconds memory_bytes zip_members zip_expanded_bytes implementation_sha256', 'policy')
    _hash_id(manifest['policy']['implementation_sha256'])
    for key in ('timeout_seconds', 'memory_bytes', 'zip_members', 'zip_expanded_bytes'):
        _integer(manifest['policy'][key], 1, POLICY[key], 'policy ' + key)
    _id(manifest['generation'])
    limits = _limits(manifest['limits'])
    binding = {key: manifest[key] for key in ('configuration_sha256', 'limits', 'policy')}
    if 'ocr_mode' in manifest:
        if manifest['ocr_mode'] not in ('none', 'macos-vision'):
            raise ValueError('invalid archive OCR mode')
        binding['ocr_mode'] = manifest['ocr_mode']
    if digest(canonical(binding)) != manifest['request_fingerprint']:
        raise ValueError('archive request fingerprint mismatch')
    documents = manifest['documents']
    if not isinstance(documents, list) or len(documents) > limits['entries']:
        raise ValueError('archive document limit')
    if not isinstance(manifest['request_key'], str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}', manifest['request_key']):
        raise ValueError('invalid archive request key')
    _hash_id(manifest['origin_binding']); _hash_id(manifest['configuration_sha256'])
    if not isinstance(manifest['source_id'], str) or not 1 <= len(manifest['source_id']) <= 80:
        raise ValueError('invalid archive source identity')
    paths, total, text_total = set(), 0, 0
    for item in documents:
        _required(item, 'path observation status reason original representation gaps', 'document receipt')
        _timestamp(item['observation'])
        if item['observation'] != manifest['observed_at']:
            raise ValueError('archive observation mismatch')
        if item['reason'] is not None and (not isinstance(item['reason'], str) or not 1 <= len(item['reason']) <= 128):
            raise ValueError('invalid archive receipt reason')
        path = _path(item['path'])
        if path in paths:
            raise ValueError('duplicate archive path')
        if len(path.encode()) > 4096:
            raise ValueError('archive path limit')
        paths.add(path)
        original, rep = item['original'], item['representation']
        if item['status'] not in ('captured', 'excluded', 'unsupported', 'unavailable', 'limited'):
            raise ValueError('invalid archive receipt')
        if (item['status'] == 'captured') != bool(original):
            raise ValueError('archive preservation receipt mismatch')
        _strings(item['gaps'], 'gaps')
        if item['status'] == 'captured':
            if item['reason'] is not None or item.get('extraction_status') not in ('captured', 'limited', 'unsupported', 'unavailable'):
                raise ValueError('invalid archive extraction receipt')
            if (item['extraction_status'] == 'captured') != (rep is not None):
                raise ValueError('archive extraction receipt mismatch')
        elif item['reason'] is None or rep is not None or original is not None:
            raise ValueError('invalid archive preservation receipt')
        if original is not None:
            _required(original, 'sha256 bytes', 'original')
            _hash_id(original['sha256'])
            _integer(original['bytes'], 0, limits['file_bytes'], 'original length')
            total += original['bytes']
            get_blob(original['sha256'], original['bytes'])
        if rep is not None:
            _required(rep, 'version original_sha256 sha256 bytes coordinate_space encoding extraction extractor_signature settings omissions', 'representation')
            if not isinstance(rep['extraction'], str) or not 1 <= len(rep['extraction']) <= 128:
                raise ValueError('invalid archive extraction identity')
            _required(rep['settings'], 'name revision settings', 'extractor settings')
            if (not isinstance(rep['settings']['settings'], dict)
                    or any(not isinstance(rep['settings'][key], str) or not rep['settings'][key] for key in ('name', 'revision'))):
                raise ValueError('invalid archive extractor settings')
            _strings(rep['omissions'], 'representation omissions')
            if rep['omissions'] != item['gaps']:
                raise ValueError('archive representation omissions mismatch')
            _hash_id(rep['sha256'])
            if (not original or type(rep['version']) is not int or rep['version'] != 1 or rep['original_sha256'] != original['sha256']
                    or rep['coordinate_space'] != 'unicode-codepoints' or rep['encoding'] != 'utf-8'):
                raise ValueError('unsupported archive representation')
            _hash_id(rep['extractor_signature'])
            _integer(rep['bytes'], 0, limits['text_bytes'], 'representation length')
            text_total += rep['bytes']
            get_blob(rep['sha256'], rep['bytes']).decode('utf-8')
    counts = {status: sum(d['status'] == status for d in documents)
              for status in ('captured', 'excluded', 'unsupported', 'unavailable', 'limited')}
    if counts != manifest['counts'] or manifest['preservation'] != ('incomplete' if counts['limited'] or counts['unavailable'] else 'complete-admitted'):
        raise ValueError('archive counts or preservation mismatch')
    if total > limits['total_bytes'] or text_total > DEFAULT_LIMITS['total_bytes']:
        raise ValueError('archive total byte limit')


def _load(registry, db, sid, generation, *, enforce_access=True):
    _id(generation)
    source = registry._source(db, sid)
    if enforce_access:
        _access(source)
    row = db.execute('SELECT * FROM archive_generations WHERE id=? AND source_id=?', (generation, sid)).fetchone()
    if row is None:
        raise ValueError('unknown archive generation')
    raw = bytes(row[5])
    if len(raw) > 4*MAX_RESPONSE or digest(raw) != row[4]:
        raise ValueError('archive manifest integrity mismatch')
    try:
        manifest = json.loads(raw)
        if canonical(manifest) != raw or (manifest['generation'], manifest['source_id'], manifest['request_key'], manifest['request_fingerprint']) != tuple(row[:4]):
            raise ValueError('archive manifest identity mismatch')
        _validate_manifest(manifest, lambda key, length: _blob(db, key, length))
        if manifest['origin_binding'] != _origin(source):
            raise ValueError('archive origin binding mismatch')
        if enforce_access:
            _access(source, manifest)
    except (KeyError, TypeError, UnicodeError, RecursionError) as exc:
        raise ValueError('invalid archive manifest') from exc
    return manifest


def _recheck(registry, db, sid, manifest):
    _access(registry._source(db, sid), manifest)


def source_generations(registry, source_id, *, offset=0, limit=20, max_bytes=MAX_RESPONSE):
    _integer(offset, 0, 1000000, 'offset'); _integer(limit, 1, 200, 'limit')
    with registry._db() as db:
        _access(registry._source(db, source_id))
        rows = db.execute('SELECT id FROM archive_generations WHERE source_id=? ORDER BY id LIMIT ? OFFSET ?',
                          (source_id, limit+1, offset)).fetchall()
        manifests = [_load(registry, db, source_id, row[0]) for row in rows[:limit]]
        for manifest in manifests:
            _recheck(registry, db, source_id, manifest)
        return bounded(dict(schema=1, source_id=source_id, generations=[_receipt(m) for m in manifests],
                            next_offset=offset+limit if len(rows)>limit else None), max_bytes)


def source_generation(registry, source_id, generation, *, manifest_sha256=None, offset=0, limit=20, max_bytes=MAX_RESPONSE):
    _integer(offset, 0, 1000, 'offset'); _integer(limit, 1, 200, 'limit')
    with registry._db() as db:
        manifest = _load(registry, db, source_id, generation)
        receipt = _receipt(manifest)
        if manifest_sha256 is not None and manifest_sha256 != receipt['manifest_sha256']:
            raise ValueError('archive manifest pin mismatch')
        receipt.update(integrity='verified', capabilities=manifest['capabilities'],
                       documents=manifest['documents'][offset:offset+limit],
                       next_offset=offset+limit if offset+limit < len(manifest['documents']) else None)
        _recheck(registry, db, source_id, manifest)
        return bounded(receipt, max_bytes)


def _audit_file(root, path, limit, file_limit):
    """Read at most the remaining audit budget without following source symlinks."""
    try:
        raw, length = _read_file(root, path, limit)
    except OSError as exc:
        # A path disappearing or becoming a symlink during an admitted-file read
        # is a changed selection, not evidence that its archived bytes vanished.
        if exc.errno in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP):
            raise ValueError('source path changed during currentness audit') from exc
        return ('unavailable', None, None, 'source-unavailable')
    if raw is None:
        return ('unavailable', None, length,
                'file-byte-limit' if length > file_limit else 'total-byte-limit')
    return ('read', digest(raw), len(raw), None)


def audit_current_source(registry, source_id, generation, *, manifest_sha256, max_bytes=MAX_RESPONSE):
    """Compare one complete archived generation with a bounded local observation.

    This does not produce an atomic filesystem snapshot or alter archived state.
    An unavailable current file is unknown, never presumed unchanged or removed.
    """
    if not isinstance(source_id, str) or not 1 <= len(source_id) <= 80:
        raise ValueError('invalid archive source identity')
    _hash_id(manifest_sha256)
    _integer(max_bytes, 1024, MAX_RESPONSE, 'response bytes')
    with registry._db() as db:
        source = registry._source(db, source_id)
        manifest = _load(registry, db, source_id, generation)
        if digest(canonical(manifest)) != manifest_sha256:
            raise ValueError('archive manifest pin mismatch')
        if manifest['preservation'] != 'complete-admitted':
            raise ValueError('currentness audit requires a complete archived generation')
        limits = _limits(manifest['limits'])
        archive = {item['path']: item['original'] for item in manifest['documents']
                   if item['status'] == 'captured'}
        membership = _enumerate(source, limits['entries'])
        current = {path: kind for path, kind in membership if kind != 'excluded'}
        added, removed, changed, unchanged, unavailable = [], [], [], [], []
        observations = {}
        total = 0
        for path in sorted(set(archive) | set(current)):
            prior = archive.get(path)
            kind = current.get(path)
            if kind is None:
                if prior is not None:
                    removed.append(dict(path=path, archived=prior))
                continue
            if kind != 'file':
                if prior is not None or kind in ('symlink', 'not-regular-file'):
                    entry = dict(path=path, reason='current-not-regular-file')
                    if prior is not None:
                        entry['archived'] = prior
                    unavailable.append(entry)
                continue
            remaining = max(0, limits['total_bytes'] - total)
            read_limit = min(limits['file_bytes'], remaining)
            observation = _audit_file(source['root'], path, read_limit, limits['file_bytes'])
            observations[path] = (read_limit, observation)
            state, sha, length, reason = observation
            if state != 'read':
                entry = dict(path=path, reason=reason)
                if prior is not None:
                    entry['archived'] = prior
                if length is not None:
                    entry['current'] = dict(bytes=length)
                unavailable.append(entry)
                continue
            total += length
            observed = dict(sha256=sha, bytes=length)
            if prior is None:
                added.append(dict(path=path, current=observed))
            elif prior == observed:
                unchanged.append(dict(path=path, archived=prior, current=observed))
            else:
                changed.append(dict(path=path, archived=prior, current=observed))
        if membership != _enumerate(source, limits['entries']):
            raise ValueError('source membership changed during currentness audit')
        for path, (read_limit, observation) in observations.items():
            if observation != _audit_file(source['root'], path, read_limit, limits['file_bytes']):
                raise ValueError('source bytes or availability changed during currentness audit')
        if membership != _enumerate(source, limits['entries']):
            raise ValueError('source membership changed during currentness audit')
        if registry._source(db, source_id) != source:
            raise ValueError('source registration changed during currentness audit')
        _access(source, manifest)
        if digest(canonical(_load(registry, db, source_id, generation))) != manifest_sha256:
            raise ValueError('archive manifest changed during currentness audit')
        receipt = dict(schema=1, kind='archive-currentness-audit',
                       status='partial' if unavailable else 'complete',
                       source_id=source_id, generation=generation,
                       manifest_sha256=manifest_sha256,
                       observed_at=datetime.now(timezone.utc).isoformat(),
                       consistency='declared-selection-not-atomic',
                       evidence='point-in-time-local-observation',
                       added=added, removed=removed, changed=changed,
                       unchanged=unchanged, unavailable=unavailable)
        return bounded(receipt, max_bytes)


def _cursor(binding, offset):
    return base64.urlsafe_b64encode(canonical(dict(binding=digest(canonical(binding)), offset=offset))).decode()


def _resume(cursor, binding):
    try:
        if not isinstance(cursor, str) or len(cursor) > 2048:
            raise ValueError('invalid archive cursor')
        value = json.loads(base64.b64decode(cursor, altchars=b'-_', validate=True))
        if set(value) != {'binding', 'offset'} or value['binding'] != digest(canonical(binding)):
            raise ValueError('archive continuation binding changed')
        return _integer(value['offset'], 0, 10**9, 'cursor offset')
    except (TypeError, KeyError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError('invalid archive cursor') from exc


def read_snapshot(registry, source_id, generation, path, *, offset=0, max_chars=8000,
                  max_bytes=16000, cursor=None, manifest_sha256=None):
    _path(path); _integer(offset, 0, 10**9, 'offset'); _integer(max_chars, 1, MAX_RESPONSE, 'max chars')
    _integer(max_bytes, 1024, MAX_RESPONSE, 'response bytes')
    with registry._db() as db:
        manifest = _load(registry, db, source_id, generation)
        mh = digest(canonical(manifest))
        if manifest_sha256 is not None and mh != manifest_sha256:
            raise ValueError('archive manifest pin mismatch')
        item = next((d for d in manifest['documents'] if d['path'] == path), None)
        if item is None or not item['representation']:
            raise ValueError('archived text representation unavailable')
        rep = item['representation']
        text = _blob(db, rep['sha256'], rep['bytes']).decode()
        binding = dict(source_id=source_id, snapshot_generation=generation, manifest_sha256=mh, path=path,
            original_sha256=item['original']['sha256'], representation_sha256=rep['sha256'],
            extractor_signature=rep['extractor_signature'], configuration_sha256=manifest['configuration_sha256'])
        if cursor is not None:
            if offset:
                raise ValueError('offset and cursor are contradictory')
            offset = _resume(cursor, binding)
        if offset > len(text):
            raise ValueError('offset beyond archived text')
        end = min(len(text), offset+max_chars)
        while True:
            body = text[offset:end]
            citation = dict(binding, sha256=item['original']['sha256'], extraction=rep['extraction'],
                coordinate_space='unicode-codepoints', text_start=offset, text_end=end, quote=body,
                evidence='archived-snapshot', current_original='not-checked')
            result = dict(schema=1, status='partial' if end<len(text) else 'complete', source_id=source_id,
                generation=generation, manifest_sha256=mh, integrity='verified', evidence='archived-snapshot',
                current_original='not-checked', representation=rep, record=dict(body=body, citations=[citation]),
                path=path, offset=offset, total_chars=len(text), next_offset=end if end<len(text) else None,
                gaps=item['gaps'], next_cursor=_cursor(binding,end) if end<len(text) else None)
            if len(canonical(result)) <= max_bytes:
                break
            if end <= offset:
                raise ValueError('archive response budget cannot fit citation')
            end = offset + (end-offset)//2
        if end == offset and offset < len(text):
            raise ValueError('archive response budget cannot fit text')
        _recheck(registry, db, source_id, manifest)
        return bounded(result, max_bytes)


def _selection(registry, db, source_ids, snapshots):
    if (not isinstance(source_ids, (list, tuple)) or not 1 <= len(source_ids) <= 100
            or any(not isinstance(sid, str) for sid in source_ids) or len(set(source_ids)) != len(source_ids)
            or not isinstance(snapshots, dict) or set(source_ids) != set(snapshots)):
        raise ValueError('snapshot keys must equal explicit source scope')
    return [_load(registry, db, sid, snapshots[sid]) for sid in sorted(source_ids)]


def _bm25_tokens(query):
    # Tokens are quoted literals in MATCH, not FTS query syntax. OR keeps a
    # short document with one relevant term in the candidate pool.
    tokens, seen = [], set()
    for token in re.findall(r'[^\W_]+', query):
        folded = token.casefold()
        if folded not in seen:
            seen.add(folded)
            tokens.append(token)
    if len(tokens) > BM25_MAX_TERMS:
        raise ValueError('archive BM25 query has too many terms')
    return tokens


def _bm25_rank(rows, tokens):
    """Score only the selected verified archive representations in a fresh FTS corpus."""
    if len(rows) > BM25_MAX_DOCUMENTS or sum(len(body.encode('utf-8')) + len(row['path'].encode('utf-8'))
                                            for row, body in rows) > BM25_MAX_TEXT_BYTES:
        raise ValueError('archive BM25 selected corpus exceeds index bounds; narrow source scope')
    try:
        with closing(sqlite3.connect(':memory:')) as index:
            index.execute("CREATE VIRTUAL TABLE documents USING fts5(path, body, tokenize='unicode61 remove_diacritics 0')")
            index.executemany('INSERT INTO documents(rowid,path,body) VALUES (?,?,?)',
                              ((number + 1, row['path'], body) for number, (row, body) in enumerate(rows)))
            if not tokens:
                return [], sqlite3.sqlite_version
            match = ' OR '.join('"' + term.replace('"', '""') + '"' for term in tokens)
            scores = index.execute('SELECT rowid, bm25(documents,5.0,1.0) FROM documents WHERE documents MATCH ?',
                                   (match,)).fetchall()
    except sqlite3.OperationalError as exc:
        if 'fts5' in str(exc).lower() or 'no such module' in str(exc).lower():
            raise ValueError('archive BM25 unavailable: SQLite FTS5 required') from exc
        raise
    ranked = []
    for number, score in scores:
        if not math.isfinite(score):
            raise ValueError('archive BM25 returned a non-finite score')
        ranked.append(dict(rows[number-1][0], score=float(score)))
    ranked.sort(key=lambda row: (row['score'], row['source_id'], row['path']))
    return ranked, sqlite3.sqlite_version


def discover_snapshot(registry, query, *, source_ids, snapshot_generations, limit=20, max_bytes=16000,
                      cursor=None, variants=None, mode='exact'):
    if not isinstance(query, str) or not 1 <= len(query) <= 512 or variants or mode not in ('exact', 'bm25'):
        raise ValueError('archive discovery supports one bounded exact or BM25 lexical query')
    _integer(limit, 1, 200, 'limit'); _integer(max_bytes, 1024, MAX_RESPONSE, 'response bytes')
    if mode == 'bm25' and isinstance(source_ids, (list, tuple)) and len(source_ids) > BM25_MAX_SOURCES:
        raise ValueError('archive BM25 source scope exceeds index bounds; select fewer sources')
    terms = set(re.findall(r'[^\W_]+', query.casefold()))
    bm25_tokens = _bm25_tokens(query) if mode == 'bm25' else None
    with registry._db() as db:
        manifests = _selection(registry, db, source_ids, snapshot_generations)
        binding = dict(query=query, snapshots=[dict(source_id=m['source_id'], generation=m['generation'],
            manifest_sha256=digest(canonical(m)), configuration_sha256=m['configuration_sha256']) for m in manifests])
        offset = _resume(cursor, binding) if cursor and mode == 'exact' else 0
        documents, gap_counts, indexed = [], {}, 0
        bm25_rows, bm25_text_bytes = [], 0
        snapshots = [{key: identity[key] for key in ('source_id', 'generation', 'manifest_sha256')}
                     for identity in binding['snapshots']]
        for manifest in manifests:
            for item in manifest['documents']:
                omissions = set(item['gaps'])
                # Derive omissions for schema 1 captures predating explicit preservation gaps.
                if item['status'] in ('limited', 'unavailable'):
                    omissions.add(item['reason'])
                for gap in omissions:
                    key = (manifest['source_id'], gap)
                    gap_counts[key] = gap_counts.get(key, 0) + 1
                rep = item['representation']
                if rep:
                    indexed += 1
                    text = _blob(db, rep['sha256'], rep['bytes']).decode()
                    identity = dict(source_id=manifest['source_id'], path=item['path'],
                        snapshot_generation=manifest['generation'], manifest_sha256=digest(canonical(manifest)),
                        sha256=item['original']['sha256'], representation_sha256=rep['sha256'],
                        extractor_signature=rep['extractor_signature'])
                    if mode == 'bm25':
                        bm25_text_bytes += rep['bytes'] + len(item['path'].encode('utf-8'))
                        if indexed > BM25_MAX_DOCUMENTS or bm25_text_bytes > BM25_MAX_TEXT_BYTES:
                            raise ValueError('archive BM25 selected corpus exceeds index bounds; narrow source scope')
                        bm25_rows.append((identity, text))
                    else:
                        words = set(re.findall(r'[^\W_]+', (text+' '+item['path']).casefold()))
                        if terms & words:
                            documents.append(identity)
        if mode == 'bm25':
            documents, sqlite_version = _bm25_rank(bm25_rows, bm25_tokens)
            index_digest = digest(canonical(dict(snapshots=binding['snapshots'], ranker=BM25_RANKER,
                tokenizer=BM25_TOKENIZER, sqlite_version=sqlite_version,
                representations=[(row['source_id'], row['path'], row['representation_sha256'])
                                 for row, _ in bm25_rows])))
            binding = dict(binding, mode='bm25', ranker=BM25_RANKER, tokenizer=BM25_TOKENIZER,
                           sqlite_version=sqlite_version, index_digest=index_digest)
            offset = _resume(cursor, binding) if cursor else 0
        if offset > len(documents):
            raise ValueError('archive cursor beyond results')
        end = min(len(documents), offset+limit)
        while True:
            result = dict(schema=1, status='partial' if end<len(documents) or gap_counts else 'complete',
                evidence='archived-snapshot', current_original='not-checked', integrity='verified',
                documents=documents[offset:end], matched_documents=len(documents),
                indexed_documents=indexed, offset=offset, returned_documents=end-offset,
                consumed_documents=end, remaining_documents=len(documents)-end,
                exhausted=end == len(documents), snapshots=snapshots,
                gaps=[dict(source_id=sid, reason=reason, count=count) for (sid,reason),count in sorted(gap_counts.items())],
                next_cursor=_cursor(binding,end) if end<len(documents) else None)
            if mode == 'bm25':
                result.update(route='archive-bm25', ranker=BM25_RANKER, tokenizer=BM25_TOKENIZER,
                              sqlite_version=sqlite_version, index_digest=index_digest,
                              shortlist_truncated=False)
            if len(canonical(result)) <= max_bytes:
                break
            end -= 1
            if end <= offset:
                raise ValueError('archive response budget cannot fit discovery page')
        for manifest in manifests:
            _recheck(registry, db, manifest['source_id'], manifest)
        return bounded(result, max_bytes)


def _write_new(registry, db, destination, raw):
    path = Path(os.path.abspath(Path(destination).expanduser()))
    if path.name in ('', '.', '..'):
        raise ValueError('explicit new destination required')
    roots = [registry.workspace] + [Path(json.loads(row[0])['root']) for row in db.execute('SELECT data FROM sources') if json.loads(row[0]).get('root')]
    if any(path == root or root in path.parents or path in root.parents for root in roots):
        raise ValueError('destination overlaps registered originals or workspace')
    with _directory(path.parent) as parent:
        fd = os.open(path.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
        except BaseException:
            os.unlink(path.name, dir_fd=parent)
            raise
    return str(path)


def recover_original(registry, source_id, generation, path, destination):
    _path(path)
    with registry._writer(), registry._db() as db:
        manifest = _load(registry, db, source_id, generation)
        item = next((d for d in manifest['documents'] if d['path'] == path), None)
        if item is None or not item['original']:
            raise ValueError('archived original unavailable')
        original = item['original']
        raw = _blob(db, original['sha256'], original['bytes'])
        _recheck(registry, db, source_id, manifest)
        destination = _write_new(registry, db, destination, raw)
        return bounded(dict(schema=1, status='complete', source_id=source_id, generation=generation,
                            path=path, destination=destination, **original))


def export_archive(registry, snapshot_generations, destination):
    if not isinstance(snapshot_generations, dict):
        raise ValueError('snapshot selectors must be a source-to-generation map')
    with registry._writer(), registry._db() as db:
        manifests = _selection(registry, db, list(snapshot_generations), snapshot_generations)
        blobs, encoded_bytes = {}, 0
        for manifest in manifests:
            for item in manifest['documents']:
                for rep in (item['original'], item['representation']):
                    if rep and rep['sha256'] not in blobs:
                        encoded_bytes += ((rep['bytes']+2)//3)*4
                        if encoded_bytes > MAX_BUNDLE - 4*MAX_RESPONSE:
                            raise ValueError('archive export exceeds bundle limit')
                        blobs[rep['sha256']] = base64.b64encode(_blob(db, rep['sha256'], rep['bytes'])).decode()
        bundle = dict(schema=1, kind='registrar-archive-only', generations=[dict(manifest_sha256=digest(canonical(m)), manifest=m) for m in manifests], blobs=blobs)
        raw = canonical(bundle)
        if len(raw) > MAX_BUNDLE:
            raise ValueError('archive export exceeds bundle limit; export fewer generations')
        for manifest in manifests:
            _recheck(registry, db, manifest['source_id'], manifest)
        _write_new(registry, db, destination, raw)
        return bounded(dict(schema=1, status='complete', generations=len(manifests), bytes=len(raw), sha256=digest(raw)))


def import_archive(registry, bundle_path):
    path = Path(os.path.abspath(bundle_path))
    raw, _ = _read_file(path.parent, path.name, MAX_BUNDLE)
    if raw is None:
        raise ValueError('archive import exceeds bundle limit')
    try:
        bundle = json.loads(raw)
        if not isinstance(bundle, dict) or not isinstance(bundle.get('blobs'), dict):
            raise ValueError('invalid archive bundle')
        if bundle['schema'] != 1 or bundle['kind'] != 'registrar-archive-only' or set(bundle) != {'schema','kind','generations','blobs'}:
            raise ValueError('unsupported archive bundle')
        envelopes = bundle['generations']
        if not isinstance(envelopes, list) or not 1 <= len(envelopes) <= 100:
            raise ValueError('invalid archive bundle generations')
        manifests = []
        for envelope in envelopes:
            if set(envelope) != {'manifest_sha256', 'manifest'} or digest(canonical(envelope['manifest'])) != envelope['manifest_sha256']:
                raise ValueError('archive import manifest integrity mismatch')
            manifests.append(envelope['manifest'])
        if not isinstance(manifests, list) or not 1 <= len(manifests) <= 100:
            raise ValueError('invalid archive bundle generations')
        blobs = {}
        for key, encoded in bundle['blobs'].items():
            _hash_id(key)
            value = base64.b64decode(encoded, validate=True)
            if len(value) > DEFAULT_LIMITS['file_bytes'] or digest(value) != key:
                raise ValueError('archive import blob integrity mismatch')
            blobs[key] = value
        used = set()
        def get_blob(key, length):
            used.add(key)
            value = blobs[key]
            if len(value) != length:
                raise ValueError('archive import length mismatch')
            return value
        ids, keys = set(), set()
        for manifest in manifests:
            _validate_manifest(manifest, get_blob)
            key = (manifest['source_id'], manifest['request_key'])
            if manifest['generation'] in ids or key in keys or len(canonical(manifest)) > 4*MAX_RESPONSE:
                raise ValueError('duplicate or oversized archive manifest')
            ids.add(manifest['generation']); keys.add(key)
        if used != set(blobs):
            raise ValueError('unreferenced archive blobs')
    except (KeyError, TypeError, UnicodeError, RecursionError) as exc:
        raise ValueError('invalid archive bundle') from exc
    with registry._writer(), registry._db() as db:
        for manifest in manifests:
            source = registry._source(db, manifest['source_id'])
            _config(source)
            if _origin(source) != manifest['origin_binding']:
                raise ValueError('archive import origin binding mismatch')
        db.execute('BEGIN IMMEDIATE')
        try:
            for manifest in manifests:
                _publish(db, manifest, blobs)
            db.execute('COMMIT')
        except BaseException:
            db.execute('ROLLBACK')
            raise
    return bounded(dict(schema=1, status='complete', imported_generations=len(manifests), access_settings='preserved'))


def reject_historical(value):
    """Current-only workflows must never reinterpret historical citations as current."""
    pending = [value]
    visited = 0
    while pending:
        visited += 1
        if visited > 100000:
            raise ValueError('historical selector inspection exceeds bounds')
        item = pending.pop()
        if isinstance(item, dict):
            if any(key in item for key in ('snapshot_generation', 'snapshot_generations', 'manifest_sha256')) or item.get('evidence') == 'archived-snapshot':
                raise ValueError('historical evidence is unsupported by this current-only operation')
            pending.extend(item.values())
        elif isinstance(item, (list, tuple)):
            pending.extend(item)
