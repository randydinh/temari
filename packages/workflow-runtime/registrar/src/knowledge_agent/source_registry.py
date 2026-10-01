"""Local multi-root registry and byte-verified lexical access over existing OKF primitives.

SQLite is authoritative local state, not a multiuser security boundary. Original sources are
read-only. A process lock serializes mutations; a database transaction publishes each scan.
"""
from __future__ import annotations

from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timezone
import fnmatch
import json
import os
from pathlib import Path
import re
import sqlite3
import uuid

from knowledge_agent import knowledge, knowledge_cache
from knowledge_agent.knowledge import (
    DEFAULT_EXTRACTORS, _ExtractionError, _cached_chunks, _cached_extraction, _hash,
    _hash_file, _select_extractor, _signature, dump_okf, parse_okf,
)
from knowledge_agent.knowledge_cache import ArtifactCache, canonical

DEFAULT_EXCLUDES = ('.*', 'bin', 'obj', 'packages', 'node_modules', '__pycache__', 'vendor')
CHUNK_BYTES = 2400
MAX_EXTRACT_BYTES = 8 * 1024 * 1024
SHARING_MODES = ('registered-sources', 'local-only')
ENGINE = _hash(canonical({
    "registry": _hash(Path(__file__).read_bytes()),
    "knowledge": _hash(Path(knowledge.__file__).read_bytes()),
    "cache": _hash(Path(knowledge_cache.__file__).read_bytes()),
    "retrieval": _hash(Path(__file__).with_name('retrieval.py').read_bytes()),
    "structure": _hash(Path(__file__).with_name('structure.py').read_bytes()),
    "evidence": _hash(Path(__file__).with_name('evidence.py').read_bytes()),
    "claim_support": _hash(Path(__file__).with_name('claim_support.py').read_bytes()),
    "providers": _hash(Path(__file__).with_name('providers.py').read_bytes()),
    "provider_worker": _hash(Path(__file__).with_name('provider_worker.py').read_bytes()),
}))


def _now():
    return datetime.now(timezone.utc).isoformat()


def _tokens(text):
    return set(re.findall(r'[^\W_]+', text.casefold()))


def _overlap(a, b):
    return a == b or a in b.parents or b in a.parents


class SourceRegistry:
    def __init__(self, workspace: Path):
        self.workspace = Path(workspace).expanduser().resolve()
        self.workspace.mkdir(parents=True, exist_ok=True)
        for name in ('registry.sqlite3', 'writer.lock'):
            if (self.workspace / name).is_symlink():
                raise ValueError('workspace state symlinks are not admitted')
        self.database = self.workspace / 'registry.sqlite3'
        from knowledge_agent.source_archive import migrate
        with self._db() as db:
            version = db.execute('PRAGMA user_version').fetchone()[0]
            audit_ready = db.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='archive_audits'"
            ).fetchone()
            if version == 5 and audit_ready and not self._sharing_migration_needed(db):
                return
        with self._writer(), self._db() as db:
            migrate(db)
            self._migrate_sharing(db)

    @staticmethod
    def _sharing_migration_needed(db):
        for (raw,) in db.execute('SELECT data FROM sources'):
            source = json.loads(raw)
            if 'sharing' not in source:
                return True
            if source['sharing'] not in SHARING_MODES:
                raise ValueError('invalid stored source sharing policy')
        return False

    @staticmethod
    def _migrate_sharing(db):
        db.execute('BEGIN IMMEDIATE')
        try:
            for sid, raw in list(db.execute('SELECT id, data FROM sources')):
                source = json.loads(raw)
                if 'sharing' not in source:
                    source['sharing'] = 'registered-sources'
                    db.execute('UPDATE sources SET data=? WHERE id=?', (json.dumps(source), sid))
                elif source['sharing'] not in SHARING_MODES:
                    raise ValueError('invalid stored source sharing policy')
            db.execute('COMMIT')
        except BaseException:
            db.execute('ROLLBACK')
            raise

    @contextmanager
    def _db(self):
        db = sqlite3.connect(self.database, timeout=5, isolation_level=None)
        try:
            yield db
        finally:
            db.close()

    @contextmanager
    def _writer(self):
        # Supported first-iteration platforms are macOS/Linux. No silent unlocked fallback.
        import fcntl
        lock_path = self.workspace / 'writer.lock'
        if lock_path.is_symlink():
            raise ValueError('workspace state symlinks are not admitted')
        with lock_path.open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise ValueError('workspace busy: another source operation is running') from exc
            try:
                yield
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)

    def _source(self, db, sid):
        row = db.execute('SELECT data FROM sources WHERE id=?', (sid,)).fetchone()
        if row is None:
            raise ValueError('unknown source ID')
        return json.loads(row[0])

    def _save(self, db, source):
        source.setdefault('sharing', 'registered-sources')
        if source['sharing'] not in SHARING_MODES:
            raise ValueError('invalid source sharing policy')
        db.execute('INSERT OR REPLACE INTO sources VALUES (?, ?)',
                   (source['id'], json.dumps(source)))

    def _root(self, db, path, excluding=None):
        root = Path(path).expanduser().resolve(strict=True)
        if not root.is_dir():
            raise ValueError('source must be an existing directory')
        if _overlap(root, self.workspace):
            raise ValueError('source must not overlap the workspace')
        for sid, data in db.execute('SELECT id, data FROM sources'):
            item = json.loads(data)
            if item.get('credential_file') and (root == Path(item['credential_file']) or root in Path(item['credential_file']).parents):
                raise ValueError('source must not contain a Testmo credential')
            if item.get('grant_file') and root in Path(item['grant_file']).parents:
                raise ValueError('source must not contain a remote authorization grant')
            if sid != excluding and item.get('root') and _overlap(root, Path(item['root'])):
                raise ValueError('source overlaps an existing registration')
        return root

    def add(self, path, *, label=None, recursive=True, exclude=()):
        if type(recursive) is not bool:
            raise ValueError('recursive must be boolean')
        patterns = list(dict.fromkeys([*DEFAULT_EXCLUDES, *exclude]))
        if len(patterns) > 100 or any(not isinstance(p, str) or not p or len(p) > 256
                                     or p.startswith('/') or '..' in p.split('/') for p in patterns):
            raise ValueError('exclusions must be bounded relative glob patterns')
        label = str(path) if label is None else label
        if not isinstance(label, str) or not label.strip() or len(label) > 256:
            raise ValueError('label must be 1–256 characters')
        with self._writer(), self._db() as db:
            root = self._root(db, path)
            source = dict(id=uuid.uuid4().hex, label=label, supplied_path=str(path), root=str(root),
                          enabled=True, recursive=recursive, exclude=patterns, availability='unchecked',
                          scan_status='never', last_scan_at=None, last_attempt_at=None,
                          generation=None, receipt=None, counts={})
            self._save(db, source)
            return source

    def add_testmo(self, **configuration):
        from knowledge_agent.testmo import add
        return add(self, **configuration)

    def add_remote(self, **configuration):
        from knowledge_agent.remote_sources import add
        return add(self, **configuration)

    def list(self):
        with self._db() as db:
            return [json.loads(r[0]) for r in db.execute('SELECT data FROM sources ORDER BY id')]

    def set_sharing(self, sid, mode):
        if type(mode) is not str or mode not in SHARING_MODES:
            raise ValueError('invalid source sharing mode')
        with self._writer(), self._db() as db:
            db.execute('BEGIN IMMEDIATE')
            try:
                source = self._source(db, sid)
                source['sharing'] = mode
                self._save(db, source)
                db.execute('COMMIT')
            except BaseException:
                db.execute('ROLLBACK')
                raise
        return source

    def inventory(self, sid):
        with self._db() as db:
            self._source(db, sid)
            return [json.loads(r[0]) for r in db.execute(
                'SELECT data FROM files WHERE source_id=? ORDER BY path', (sid,))]

    def publish_graph(self, *args, **kwargs):
        from knowledge_agent.archived_graph import publish_graph
        return publish_graph(self, *args, **kwargs)

    def read_graph(self, *args, **kwargs):
        from knowledge_agent.archived_graph import read_graph
        return read_graph(self, *args, **kwargs)

    def retract_graph(self, *args, **kwargs):
        from knowledge_agent.archived_graph import retract_graph
        return retract_graph(self, *args, **kwargs)

    def graph_projection(self, *args, **kwargs):
        from knowledge_agent.archived_graph import graph_projection
        return graph_projection(self, *args, **kwargs)

    def check_graph_projection(self, *args, **kwargs):
        from knowledge_agent.archived_graph import check_graph_projection
        return check_graph_projection(self, *args, **kwargs)

    def export_graph_okf(self, *args, **kwargs):
        from knowledge_agent.archived_graph import export_graph_okf
        return export_graph_okf(self, *args, **kwargs)

    def import_graph_okf(self, *args, **kwargs):
        from knowledge_agent.archived_graph import import_graph_okf
        return import_graph_okf(self, *args, **kwargs)

    def publish_knowledge(self, batch):
        """Validate source anchors and atomically retain one immutable generation."""
        from knowledge_agent.knowledge_projection import generation_bytes, generation_json, normalize_batch
        generation = normalize_batch(batch)
        anchors = [row.anchor for row in (*generation.concepts, *generation.relationships)]

        def anchor_matches(anchor, body, citation):
            if (citation['sha256'] != anchor.source_sha256
                    or not citation['text_start'] <= anchor.text_start < anchor.text_end <= citation['text_end']):
                return False
            relative_start = anchor.text_start - citation['text_start']
            relative_end = anchor.text_end - citation['text_start']
            selected = body[relative_start:relative_end]
            line_start = citation['start'] + body[:relative_start].count('\n')
            line_end = citation['start'] + body[:relative_end].count('\n') - int(selected.endswith('\n'))
            return anchor.line_start == line_start and anchor.line_end == line_end

        with self._writer(), self._db() as db:
            source = self._source(db, generation.source_id)
            if not source['enabled'] or source['generation'] != generation.source_generation:
                raise ValueError('knowledge batch source generation is not current')
            extracted, admitted_chunks = {}, []
            for anchor in anchors:
                file_row = db.execute('SELECT data FROM files WHERE source_id=? AND path=?',
                                      (generation.source_id, anchor.path)).fetchone()
                if file_row is None:
                    raise ValueError('knowledge anchor path is not indexed')
                item = json.loads(file_row[0])
                if item.get('sha256') != anchor.source_sha256 or item.get('status') != 'indexed':
                    raise ValueError('knowledge anchor hash is not current indexed evidence')
                chunks = [json.loads(row[0]) for row in db.execute(
                    'SELECT data FROM chunks WHERE source_id=? AND path=? ORDER BY ordinal',
                    (generation.source_id, anchor.path))]
                admitted = None
                for chunk in chunks:
                    if (chunk['text_start'] <= anchor.text_start < anchor.text_end <= chunk['text_end']
                            and chunk['start'] <= anchor.line_start <= anchor.line_end <= chunk['end']):
                        body, citation = self._verify_chunk(source, anchor.path, chunk, extracted)
                        if anchor_matches(anchor, body, citation):
                            admitted = chunk
                            break
                if admitted is None:
                    raise ValueError('knowledge anchor span is not admitted by an indexed chunk')
                admitted_chunks.append((anchor, admitted))
            revalidated = {}
            for anchor, chunk in admitted_chunks:
                body, citation = self._verify_chunk(source, anchor.path, chunk, revalidated)
                if not anchor_matches(anchor, body, citation):
                    raise ValueError('knowledge anchor evidence changed during publication')
            data = generation_json(generation)
            payload_sha256 = _hash(generation_bytes(generation))
            db.execute('BEGIN IMMEDIATE')
            current = self._source(db, generation.source_id)
            if current != source:
                db.execute('ROLLBACK')
                raise ValueError('source changed during knowledge publication')
            existing = db.execute('SELECT payload_sha256, data FROM knowledge_generations WHERE id=?',
                                  (generation.id,)).fetchone()
            if existing is not None and existing != (payload_sha256, data):
                db.execute('ROLLBACK')
                raise ValueError('knowledge generation identity collision')
            db.execute('INSERT OR IGNORE INTO knowledge_generations VALUES (?, ?, ?, ?, ?, ?)',
                       (generation.id, generation.source_id, generation.source_generation,
                        generation.extractor_revision, payload_sha256, data))
            db.execute('COMMIT')
        return generation

    def knowledge_generation(self, generation_id):
        """Load an immutable historical generation without asserting current applicability."""
        from knowledge_agent.knowledge_projection import generation_bytes, generation_from_dict
        if not isinstance(generation_id, str) or not generation_id.startswith('kg1:'):
            raise ValueError('invalid knowledge generation ID')
        with self._db() as db:
            row = db.execute('SELECT payload_sha256, data FROM knowledge_generations WHERE id=?',
                             (generation_id,)).fetchone()
        if row is None:
            raise ValueError('unknown knowledge generation')
        try:
            value = json.loads(row[1])
            generation = generation_from_dict(value)
        except (ValueError, TypeError, json.JSONDecodeError) as exc:
            raise ValueError('invalid stored knowledge generation') from exc
        if _hash(generation_bytes(generation)) != row[0] or generation.id != generation_id:
            raise ValueError('stored knowledge generation integrity mismatch')
        return generation

    def capture_source(self, *args, **kwargs):
        from knowledge_agent.source_archive import capture_source
        return capture_source(self, *args, **kwargs)

    def source_generations(self, *args, **kwargs):
        from knowledge_agent.source_archive import source_generations
        return source_generations(self, *args, **kwargs)

    def source_generation(self, *args, **kwargs):
        from knowledge_agent.source_archive import source_generation
        return source_generation(self, *args, **kwargs)

    def audit_current_source(self, *args, **kwargs):
        from knowledge_agent.source_archive import audit_current_source
        return audit_current_source(self, *args, **kwargs)

    def audit_start(self, *args, **kwargs):
        from knowledge_agent.source_archive import audit_start
        return audit_start(self, *args, **kwargs)

    def audit_page(self, *args, **kwargs):
        from knowledge_agent.source_archive import audit_page
        return audit_page(self, *args, **kwargs)

    def read_snapshot(self, *args, **kwargs):
        from knowledge_agent.source_archive import read_snapshot
        return read_snapshot(self, *args, **kwargs)

    def discover_snapshot(self, *args, **kwargs):
        from knowledge_agent.source_archive import discover_snapshot
        return discover_snapshot(self, *args, **kwargs)

    def recover_original(self, *args, **kwargs):
        from knowledge_agent.source_archive import recover_original
        return recover_original(self, *args, **kwargs)

    def export_archive(self, *args, **kwargs):
        from knowledge_agent.source_archive import export_archive
        return export_archive(self, *args, **kwargs)

    def import_archive(self, *args, **kwargs):
        from knowledge_agent.source_archive import import_archive
        return import_archive(self, *args, **kwargs)

    def _enable(self, sid, enabled):
        with self._writer(), self._db() as db:
            source = self._source(db, sid)
            source['enabled'] = enabled
            self._save(db, source)
            return source

    def disable(self, sid):
        return self._enable(sid, False)

    def enable(self, sid):
        return self._enable(sid, True)

    def relink(self, sid, path):
        with self._writer(), self._db() as db:
            source = self._source(db, sid)
            if source.get('kind') in ('testmo', 'shortcut', 'notion'):
                raise ValueError('Remote sources cannot be relinked to local directories')
            root = self._root(db, path, excluding=sid)
            source.update(root=str(root), supplied_path=str(path), scan_status='needs-refresh',
                          availability='unchecked', receipt=None, generation=None)
            self._save(db, source)
            return source

    def _source_file(self, source, relative=None):
        root = Path(source['root'])
        if not root.is_dir() or root.resolve(strict=True) != root:
            raise OSError('canonical source root unavailable or replaced by symlink')
        if relative is None:
            return root
        parts = Path(relative).parts
        if not parts or Path(relative).is_absolute() or '..' in parts:
            raise ValueError('invalid source-relative path')
        current = root
        for part in parts:
            current = current / part
            if current.is_symlink():
                raise OSError('source symlink is not admitted')
        if not current.is_file():
            raise OSError('source file unavailable')
        return current

    def _walk(self, source):
        root = self._source_file(source)
        pending = [root]
        while pending:
            directory = pending.pop()
            if directory.is_symlink() or directory.resolve(strict=True) != directory:
                raise OSError('source directory changed during scan')
            with os.scandir(directory) as stream:
                children = sorted(stream, key=lambda x: x.name)
            for entry in children:
                path = Path(entry.path)
                relative = path.relative_to(root).as_posix()
                excluded = any(fnmatch.fnmatchcase(relative, p) or
                               ('/' not in p and fnmatch.fnmatchcase(entry.name, p))
                               for p in source['exclude'])
                if excluded:
                    yield relative, None, 'excluded'
                elif entry.is_symlink():
                    yield relative, None, 'symlink'
                elif entry.is_dir(follow_symlinks=False):
                    if source['recursive']:
                        pending.append(path)
                    else:
                        yield relative, None, 'not-recursive'
                elif entry.is_file(follow_symlinks=False):
                    yield relative, path, None
                else:
                    yield relative, None, 'not-regular-file'

    def _index(self, source, relative, path, item, cache):
        extractor = _select_extractor(path, DEFAULT_EXTRACTORS)
        if extractor is None:
            item['status'] = 'unsupported-extension'
            return []
        item['extractor'] = _signature(extractor)
        if item['bytes'] > MAX_EXTRACT_BYTES:
            item['status'] = 'extraction-size-limit'
            return []
        raw = path.read_bytes()
        if _hash(raw) != item['sha256']:
            raise _ExtractionError('source-changed')
        extracted = _cached_extraction(path, raw, extractor, cache)
        chunks = _cached_chunks(extracted['text'], CHUNK_BYTES, cache)
        result = []
        for ordinal, (body, start, end, first, last) in enumerate(chunks, 1):
            metadata = dict(type='ImportedDocumentChunk', source_id=source['id'], source_path=relative,
                            source_sha256=item['sha256'], chunk_index=ordinal, chunk_count=len(chunks),
                            extraction=extracted['extraction'])
            okf = dump_okf(metadata, body)
            data = dict(okf=okf, okf_sha256=_hash(okf.encode()), sha256=item['sha256'],
                        extractor=item['extractor'], extraction=extracted['extraction'],
                        text_start=start, text_end=end, start=first, end=last,
                        chunk_sha256=_hash(body.encode()))
            result.append((ordinal, data, ' ' + ' '.join(sorted(_tokens(body + ' ' + relative))) + ' '))
        item['status'] = 'indexed'
        item['chunks'] = len(chunks)
        return result

    def refresh(self, sid):
        with self._db() as db:
            source = self._source(db, sid)
        if source.get('kind') in ('shortcut', 'notion'):
            from knowledge_agent.remote_sources import refresh
            return refresh(self, sid)
        if source.get('kind') == 'testmo':
            from knowledge_agent.testmo import refresh
            return refresh(self, sid)
        with self._writer(), self._db() as db:
            source = self._source(db, sid)
            if not source['enabled']:
                raise ValueError('source is disabled')
            source.update(scan_status='scanning', last_attempt_at=_now())
            self._save(db, source)
            cache = ArtifactCache(self.workspace, 'cache')
            before = {json.loads(r[0])['path']: json.loads(r[0]) for r in db.execute(
                'SELECT data FROM files WHERE source_id=?', (sid,))}
            observed = {}
            try:
                db.execute('BEGIN IMMEDIATE')
                db.execute('DELETE FROM chunks WHERE source_id=?', (sid,))
                for relative, path, error in self._walk(source):
                    item = dict(source_id=sid, path=relative, sha256=None, bytes=None,
                                status=error, extractor=None, observed_at=source['last_attempt_at'])
                    chunks = []
                    if path is not None:
                        try:
                            path = self._source_file(source, relative)
                            item['sha256'] = _hash_file(path)
                            item['bytes'] = path.stat().st_size
                            chunks = self._index(source, relative, path, item, cache)
                        except _ExtractionError as exc:
                            item['status'] = exc.reason
                        except OSError:
                            item['status'] = 'source-unavailable'
                    observed[relative] = item
                    db.execute('INSERT OR REPLACE INTO files VALUES (?, ?, ?)', (sid, relative, json.dumps(item)))
                    db.executemany('INSERT INTO chunks VALUES (?, ?, ?, ?, ?)',
                                   [(sid, relative, i, json.dumps(c), terms) for i, c, terms in chunks])
                # A second membership observation and byte check detect ordinary mid-scan changes.
                if set(observed) != {r for r, _, _ in self._walk(source)}:
                    raise OSError('source membership changed during scan')
                for relative, item in observed.items():
                    if item['sha256'] and _hash_file(self._source_file(source, relative)) != item['sha256']:
                        raise OSError('source bytes changed during scan')
                for relative, previous in before.items():
                    if relative not in observed:
                        item = dict(previous, status='deleted', observed_at=source['last_attempt_at'])
                        db.execute('INSERT OR REPLACE INTO files VALUES (?, ?, ?)', (sid, relative, json.dumps(item)))
                counts = dict(Counter(item['status'] for item in observed.values()))
                counts.update(discovered=len(observed), hashed=sum(bool(x['sha256']) for x in observed.values()),
                              unchanged=sum(x['sha256'] is not None and x['sha256'] == before.get(p, {}).get('sha256')
                                            for p, x in observed.items()), deleted=len(set(before) - set(observed)))
                failures = {k: v for k, v in counts.items() if k not in {
                    'indexed', 'excluded', 'not-recursive', 'discovered', 'hashed', 'unchanged', 'deleted'}}
                snapshot = _hash(canonical([[p, x['sha256'], x['status']] for p, x in sorted(observed.items())]))
                source.update(availability='available', scan_status='partial' if failures else 'complete',
                              last_scan_at=_now(), generation=uuid.uuid4().hex, counts=counts,
                              receipt=dict(provider='okf', version='registry-1', engine_sha256=ENGINE,
                                           snapshot=snapshot, settings=dict(chunk_bytes=CHUNK_BYTES,
                                           max_extract_bytes=MAX_EXTRACT_BYTES), gaps=failures))
                self._save(db, source)
                db.execute('COMMIT')
                return dict(status=source['scan_status'], source_id=sid, counts=counts,
                            receipt=source['receipt'], cache=cache.stats)
            except BaseException as exc:
                if db.in_transaction:
                    db.execute('ROLLBACK')
                source.update(scan_status='interrupted' if isinstance(exc, (KeyboardInterrupt, SystemExit)) else 'unavailable',
                              availability='unchecked' if isinstance(exc, (KeyboardInterrupt, SystemExit)) else 'unavailable')
                self._save(db, source)
                if not isinstance(exc, OSError):
                    raise
                return dict(status='unavailable', source_id=sid, reason=str(exc), inventory_preserved=True)

    def _verify_chunk(self, source, relative, chunk, extracted):
        if source.get('kind') in ('shortcut', 'notion'):
            from knowledge_agent.remote_sources import verify_chunk, revision_text
            body, citation = verify_chunk(self, source, relative, chunk)
            extracted[(source['id'], relative, chunk['sha256'])] = revision_text(self, source, relative, chunk['sha256'])
            return body, citation
        if source.get('kind') == 'testmo':
            from knowledge_agent.testmo import verify_chunk
            return verify_chunk(self, source, relative, chunk)
        path = self._source_file(source, relative)
        key = (source['id'], relative, chunk['sha256'])
        if key not in extracted:
            raw = path.read_bytes()
            if _hash(raw) != chunk['sha256']:
                raise _ExtractionError('source-changed')
            extractor = _select_extractor(path, DEFAULT_EXTRACTORS)
            if extractor is None or _signature(extractor) != chunk['extractor']:
                raise _ExtractionError('extractor-mismatch')
            cache = ArtifactCache(self.workspace, 'cache')
            extracted[key] = _cached_extraction(path, raw, extractor, cache)
        if _hash(chunk['okf'].encode()) != chunk['okf_sha256']:
            raise _ExtractionError('index-changed')
        metadata, body = parse_okf(chunk['okf'])
        text = extracted[key]['text']
        if (text[chunk['text_start']:chunk['text_end']] != body or
                _hash(body.encode()) != chunk['chunk_sha256'] or
                extracted[key]['extraction'] != chunk['extraction']):
            raise _ExtractionError('span-mismatch')
        first = text[:chunk['text_start']].count('\n') + 1
        last = first + body.count('\n') - int(body.endswith('\n'))
        if chunk['start'] != first or chunk['end'] != last:
            raise _ExtractionError('span-mismatch')
        return body, dict(source_id=source['id'], path=relative, absolute_path=str(path),
                          sha256=chunk['sha256'], start=first, end=last,
                          text_start=chunk['text_start'], text_end=chunk['text_end'],
                          extraction=chunk['extraction'], extractor_signature=chunk['extractor'], quote=body)

    def search(self, query, *, source_ids=None, limit=5, max_bytes=16000):
        from knowledge_agent.retrieval import _scope
        _scope(self, source_ids)
        if (not isinstance(query, str) or not 1 <= len(query.encode()) <= 512 or not _tokens(query)
                or type(limit) is not int or not 1 <= limit <= 20
                or type(max_bytes) is not int or not 1024 <= max_bytes <= 1048576):
            raise ValueError('query requires words (1–512 bytes), limit 1–20 and budget 1024–1048576')
        terms = sorted(_tokens(query))
        sources = {s['id']: s for s in self.list()}
        selected = set(sources) if source_ids is None else set(source_ids)
        if selected - sources.keys():
            raise ValueError('unknown source ID')
        sources = {sid: s for sid, s in sources.items() if sid in selected and s['enabled']}
        ready, gaps = {}, Counter()
        for sid, source in sources.items():
            if source.get('kind') in ('shortcut', 'notion'):
                from knowledge_agent.remote_sources import unavailable_reason
                reason = unavailable_reason(source, ENGINE)
                if reason:
                    gaps[(sid, reason)] += 1
                    continue
                ready[sid] = source
                if source['scan_status'] != 'complete':
                    gaps[(sid, source['scan_status'])] += 1
                for reason, count in source['receipt']['gaps'].items():
                    gaps[(sid, reason)] += count
                continue
            if source.get('kind') == 'testmo':
                from knowledge_agent.testmo import ENGINE as testmo_engine
                if not source['receipt']:
                    gaps[(sid, source['scan_status'])] += 1
                    continue
                if (source['receipt']['engine_sha256'] != testmo_engine or
                        source['receipt'].get('registry_engine_sha256') != ENGINE):
                    gaps[(sid, 'provider-version-changed')] += 1
                    continue
                ready[sid] = source
                if source['scan_status'] != 'complete':
                    gaps[(sid, source['scan_status'])] += 1
                if source['receipt']['gaps']:
                    gaps[(sid, 'testmo-import-gaps-see-case-citations-or-inventory')] += sum(source['receipt']['gaps'].values())
                continue
            if source['scan_status'] not in ('complete', 'partial'):
                gaps[(sid, source['scan_status'])] += 1
                continue
            if source['receipt']['engine_sha256'] != ENGINE:
                gaps[(sid, 'provider-version-changed')] += 1
                continue
            ready[sid] = source
            for reason, count in source['receipt']['gaps'].items():
                gaps[(sid, reason)] += count
        result = dict(schema=1, status='partial', query=query, records=[], gaps=[],
                      freshness='returned source bytes revalidated; discovery as of last successful scan',
                      sources=[dict(id=s['id'], label=s['label'], last_scan_at=s['last_scan_at'],
                                    snapshot=(s['receipt'] or {}).get('snapshot')) for s in sources.values()])
        if any(s.get('kind') in ('testmo', 'shortcut', 'notion') for s in sources.values()):
            result['freshness'] = ('local citations revalidate file bytes; remote citations verify cached revisions only; '
                                   'remote freshness unknown, see citation fetch interval and refresh status')
        extracted, grouped, omitted_identities = {}, {}, set()
        score_sql = ' + '.join(['(instr(tokens, ?) > 0)'] * len(terms)) + ' + 2 * path_score(path)'
        with self._db() as db:
            db.create_function('path_score', 1, lambda path: len(set(terms) & _tokens(Path(path).stem)),
                               deterministic=True)
            # Query literals are parameters, never SQL expressions supplied by the caller.
            rows = db.execute(f'SELECT source_id, path, data, ({score_sql}) AS score FROM chunks '
                              'WHERE score > 0 ORDER BY score DESC, source_id, path, ordinal',
                              tuple(' ' + term + ' ' for term in terms))
            for sid, relative, raw, score in rows:
                if sid not in ready:
                    continue
                chunk = json.loads(raw)
                identity = ((sid, relative) if chunk.get('kind') in ('testmo', 'shortcut', 'notion') else None, chunk.get('locator'), chunk['sha256'], chunk['text_start'], chunk['text_end'], chunk['extractor'], chunk['chunk_sha256'])
                if identity not in grouped and len(grouped) >= limit:
                    omitted_identities.add(identity)
                    continue
                try:
                    body, citation = self._verify_chunk(ready[sid], relative, chunk, extracted)
                except _ExtractionError as exc:
                    gaps[(sid, exc.reason)] += 1
                    continue
                except (OSError, ValueError):
                    gaps[(sid, 'source-or-index-unavailable')] += 1
                    continue
                if identity not in grouped:
                    grouped[identity] = dict(body=body, support=('cached-testmo-revision-and-spans-verified'
                                            if chunk.get('kind') == 'testmo' else
                                            'cached-remote-revision-and-spans-verified' if chunk.get('kind') in ('shortcut', 'notion') else 'source-bytes-and-spans-verified'),
                                            retrieval=dict(kind='lexical', score=score), citations=[])
                if len(grouped[identity]['citations']) < 20:
                    grouped[identity]['citations'].append(citation)
                else:
                    gaps[(sid, 'duplicate-origin-limit')] += 1
        for record in grouped.values():
            citations = []
            for cite in record['citations']:
                try:
                    if cite.get('kind') in ('shortcut', 'notion'):
                        from knowledge_agent.remote_sources import verify_chunk, engine, unavailable_reason
                        if unavailable_reason(ready[cite['source_id']], ENGINE):
                            raise ValueError('remote access changed during lookup')
                        verify_chunk(self, ready[cite['source_id']], cite['path'], dict(sha256=cite['sha256'],
                            extractor=engine(cite['kind']), text_start=cite['text_start'], text_end=cite['text_end'],
                            chunk_sha256=_hash(cite['quote'].encode())))
                        citations.append(cite)
                        continue
                    if cite.get('kind') == 'testmo':
                        from knowledge_agent.testmo import verify_chunk, ENGINE as testmo_engine
                        verify_chunk(self, ready[cite['source_id']], cite['path'], dict(sha256=cite['sha256'],
                                     extractor=testmo_engine, locator=cite['locator'], text_start=cite['text_start'],
                                     text_end=cite['text_end'], chunk_sha256=_hash(cite['quote'].encode())))
                        citations.append(cite)
                        continue
                    path = self._source_file(ready[cite['source_id']], cite['path'])
                    if _hash_file(path) != cite['sha256']:
                        raise _ExtractionError('source-changed')
                    citations.append(cite)
                except (OSError, ValueError, _ExtractionError):
                    gaps[(cite['source_id'], 'source-changed-during-lookup')] += 1
            record['citations'] = citations
            if citations:
                result['records'].append(record)
        # Do not mix generations or return evidence disabled/relinked during lookup.
        current = {s['id']: s for s in self.list()}
        if any(current.get(sid) != source for sid, source in sources.items()):
            raise ValueError('registry changed during lookup; retry')
        if not result['records']:
            gaps[('', 'no-match')] += 1
        if omitted_identities:
            gaps[('', 'result-limit')] += len(omitted_identities)
        result['gaps'] = [dict(source_id=sid, reason=reason, count=count)
                          for (sid, reason), count in sorted(gaps.items())]
        while len(json.dumps(result, ensure_ascii=False).encode()) > max_bytes and result['records']:
            result['records'].pop()
            omitted = next((g for g in result['gaps'] if g['reason'] == 'budget-omitted'), None)
            if omitted is None:
                result['gaps'].append(dict(source_id='', reason='budget-omitted', count=1))
            else:
                omitted['count'] += 1
        if not result['gaps']:
            result['status'] = 'complete'
        if len(json.dumps(result, ensure_ascii=False).encode()) > max_bytes:
            raise ValueError('budget cannot hold the source and gap report; narrow source scope')
        return result

    def discover(self, query, **kwargs):
        snapshots = kwargs.pop('snapshot_generations', None)
        if snapshots is not None:
            return self.discover_snapshot(query, snapshot_generations=snapshots, **kwargs)
        from knowledge_agent.retrieval import discover
        return discover(self, query, **kwargs)

    def read_document(self, source_id, path, **kwargs):
        generation = kwargs.pop('snapshot_generation', None)
        cursor = kwargs.pop('cursor', None)
        manifest = kwargs.pop('manifest_sha256', None)
        if generation is not None:
            for key in ('expected_generation', 'expected_sha256', 'section'):
                if kwargs.pop(key, None) is not None:
                    raise ValueError('current and historical selectors are contradictory')
            return self.read_snapshot(source_id, generation, path, cursor=cursor, manifest_sha256=manifest, **kwargs)
        if cursor is not None or manifest is not None:
            raise ValueError('snapshot selector required')
        from knowledge_agent.retrieval import read_document
        return read_document(self, source_id, path, **kwargs)

    def outline(self, source_id, path, **kwargs):
        from knowledge_agent.source_archive import reject_historical
        reject_historical([source_id, path, kwargs])
        from knowledge_agent.evidence import outline
        return outline(self, source_id, path, **kwargs)

    def configure_evidence(self, policy):
        from knowledge_agent.evidence import configure
        return configure(self, policy)

    def expand(self, selections, **kwargs):
        from knowledge_agent.source_archive import reject_historical
        reject_historical([selections, kwargs])
        from knowledge_agent.evidence import expand
        return expand(self, selections, **kwargs)

    def validate_claims(self, claims, **kwargs):
        from knowledge_agent.source_archive import reject_historical
        reject_historical([claims, kwargs])
        from knowledge_agent.claim_support import validate_claims
        return validate_claims(self, claims, **kwargs)
