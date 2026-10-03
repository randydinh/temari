"""SA-001 synthetic preservation tests; originals and state live only in temp directories."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from knowledge_agent import source_archive
from knowledge_agent.source_registry import SourceRegistry


class CurrentnessAuditTests(unittest.TestCase):
    def test_reports_current_file_changes_without_mutating_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / 'source'
            root.mkdir()
            (root / 'unchanged.txt').write_text('same', encoding='utf-8')
            (root / 'changed.txt').write_text('before', encoding='utf-8')
            (root / 'removed.txt').write_text('gone', encoding='utf-8')
            registry = SourceRegistry(base / 'state')
            source_id = registry.add(root)['id']
            publication = registry.capture_source(source_id, request_key='before-changes')
            (root / 'changed.txt').write_text('after', encoding='utf-8')
            (root / 'removed.txt').unlink()
            (root / 'added.txt').write_text('new', encoding='utf-8')

            audit = registry.audit_current_source(
                source_id, publication['generation'],
                manifest_sha256=publication['manifest_sha256'],
            )

            self.assertEqual(audit['kind'], 'archive-currentness-audit')
            self.assertEqual(audit['status'], 'complete')
            for category, expected in (
                ('added', 'added.txt'), ('removed', 'removed.txt'),
                ('changed', 'changed.txt'), ('unchanged', 'unchanged.txt'),
            ):
                self.assertEqual([item['path'] for item in audit[category]], [expected])
            self.assertEqual(audit['unavailable'], [])
            self.assertEqual(registry.source_generation(
                source_id, publication['generation'],
                manifest_sha256=publication['manifest_sha256'],
            )['manifest_sha256'], publication['manifest_sha256'])

    def test_requires_exact_manifest_pin_and_current_access(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / 'source'
            root.mkdir()
            (root / 'a.txt').write_text('archived', encoding='utf-8')
            registry = SourceRegistry(base / 'state')
            source_id = registry.add(root)['id']
            publication = registry.capture_source(source_id, request_key='pin')
            with self.assertRaisesRegex(ValueError, 'manifest pin mismatch'):
                registry.audit_current_source(source_id, publication['generation'],
                                              manifest_sha256='0' * 64)
            registry.disable(source_id)
            with self.assertRaises(ValueError):
                registry.audit_current_source(source_id, publication['generation'],
                                              manifest_sha256=publication['manifest_sha256'])

    def test_changed_bytes_between_passes_are_refused_without_archive_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / 'source'
            root.mkdir()
            document = root / 'a.txt'
            document.write_text('archived content', encoding='utf-8')
            registry = SourceRegistry(base / 'state')
            source_id = registry.add(root)['id']
            publication = registry.capture_source(source_id, request_key='before-race')
            with registry._db() as db:
                archived_before = db.execute(
                    'SELECT manifest_sha256,manifest FROM archive_generations WHERE id=?',
                    (publication['generation'],),
                ).fetchone()
                blob_count_before = db.execute('SELECT count(*) FROM archive_blobs').fetchone()[0]
            original_read = source_archive._read_file
            reads = 0

            def change_after_first_read(root_path, relative, limit):
                nonlocal reads
                result = original_read(root_path, relative, limit)
                if relative == 'a.txt':
                    reads += 1
                    if reads == 1:
                        document.write_text('changed during audit', encoding='utf-8')
                return result

            with patch.object(source_archive, '_read_file', side_effect=change_after_first_read):
                with self.assertRaisesRegex(ValueError, 'source bytes or availability changed'):
                    registry.audit_current_source(
                        source_id, publication['generation'],
                        manifest_sha256=publication['manifest_sha256'],
                    )
            self.assertEqual(reads, 2)
            with registry._db() as db:
                self.assertEqual(archived_before, db.execute(
                    'SELECT manifest_sha256,manifest FROM archive_generations WHERE id=?',
                    (publication['generation'],),
                ).fetchone())
                self.assertEqual(blob_count_before, db.execute(
                    'SELECT count(*) FROM archive_blobs').fetchone()[0])

    def test_current_total_byte_limit_reports_partial_without_guessing(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / 'source'
            root.mkdir()
            (root / 'a.txt').write_text('123456', encoding='utf-8')
            registry = SourceRegistry(base / 'state')
            source_id = registry.add(root)['id']
            publication = registry.capture_source(
                source_id, request_key='bounded', limits={'total_bytes': 10},
            )
            (root / 'z.txt').write_text('abcdef', encoding='utf-8')
            audit = registry.audit_current_source(
                source_id, publication['generation'],
                manifest_sha256=publication['manifest_sha256'],
            )
            self.assertEqual(audit['status'], 'partial')
            self.assertEqual(audit['unavailable'][0]['path'], 'z.txt')
            self.assertEqual(audit['unavailable'][0]['reason'], 'total-byte-limit')
            self.assertEqual(audit['added'], [])

    def test_incomplete_archived_generation_cannot_be_audited(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / 'source'
            root.mkdir()
            (root / 'big.txt').write_text('too big for capture', encoding='utf-8')
            registry = SourceRegistry(base / 'state')
            source_id = registry.add(root)['id']
            publication = registry.capture_source(
                source_id, request_key='limited', limits={'file_bytes': 4},
            )
            self.assertEqual(publication['preservation'], 'incomplete')
            with self.assertRaisesRegex(ValueError, 'complete archived generation'):
                registry.audit_current_source(
                    source_id, publication['generation'],
                    manifest_sha256=publication['manifest_sha256'],
                )


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.docs = self.root / 'docs'
        self.docs.mkdir()
        self.state = self.root / 'state'
        self.registry = SourceRegistry(self.state)
        self.sid = self.registry.add(self.docs, label='Synthetic')['id']
        (self.docs / 'guide.txt').write_text('ArchiveSignal café v1\nsecond line\n')

    def capture(self, key='first', **kwargs):
        return self.registry.capture_source(self.sid, request_key=key, **kwargs)

    def test_versions_survive_loss_and_restart(self):
        original = (self.docs / 'guide.txt').read_bytes()
        first = self.capture()
        generation = first['generation']
        page = self.registry.read_snapshot(self.sid, generation, 'guide.txt', max_chars=5)
        (self.docs / 'guide.txt').write_text('ArchiveSignal v2\n')
        second = self.capture('second')
        self.assertEqual(self.capture()['generation'], generation)
        self.assertTrue(self.capture()['replayed'])
        shutil.rmtree(self.docs)
        shutil.rmtree(self.state / 'cache', ignore_errors=True)
        registry = SourceRegistry(self.state)
        tail = registry.read_snapshot(self.sid, generation, 'guide.txt', cursor=page['next_cursor'])
        self.assertEqual(page['record']['body'] + tail['record']['body'], original.decode())
        for gen, expected in [(generation, original), (second['generation'], b'ArchiveSignal v2\n')]:
            destination = self.root / gen
            registry.recover_original(self.sid, gen, 'guide.txt', destination)
            self.assertEqual(destination.read_bytes(), expected)
        self.assertEqual(tail['current_original'], 'not-checked')
        self.assertEqual(tail['evidence'], 'archived-snapshot')

    def test_failed_publish_atomic_and_previous_usable(self):
        first = self.capture()
        from knowledge_agent import source_archive
        with patch.object(source_archive, '_publish', side_effect=RuntimeError('injected publication failure')):
            with self.assertRaises(RuntimeError):
                self.capture('failed')
        self.assertEqual(len(self.registry.source_generations(self.sid)['generations']), 1)
        self.assertIn('ArchiveSignal', self.registry.read_snapshot(self.sid, first['generation'], 'guide.txt')['record']['body'])

    def test_backup_preserves_current_disabled_decision(self):
        first = self.capture()
        bundle = self.root / 'backup.json'
        self.registry.export_archive({self.sid: first['generation']}, bundle)
        with self.registry._db() as db:
            db.execute('DELETE FROM archive_generations')
            db.execute('DELETE FROM archive_blobs')
        self.registry.disable(self.sid)
        self.registry.import_archive(bundle)
        with self.assertRaises(ValueError):
            self.registry.read_snapshot(self.sid, first['generation'], 'guide.txt')
        self.registry.enable(self.sid)
        self.assertIn('ArchiveSignal', self.registry.read_snapshot(self.sid, first['generation'], 'guide.txt')['record']['body'])
        self.registry.recover_original(self.sid, first['generation'], 'guide.txt', self.root/'restored-after-import')
        self.assertEqual((self.root/'restored-after-import').read_bytes(), (self.docs/'guide.txt').read_bytes())

    def test_same_stat_edit_and_request_binding(self):
        import os
        path = self.docs / 'guide.txt'
        first = self.capture()
        before = path.stat()
        path.write_bytes(path.read_bytes().replace(b'v1', b'v2'))
        os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
        second = self.capture('new-observation')
        self.assertNotEqual(first['generation'], second['generation'])
        self.assertIn('v1', self.registry.read_snapshot(self.sid, first['generation'], 'guide.txt')['record']['body'])
        self.assertIn('v2', self.registry.read_snapshot(self.sid, second['generation'], 'guide.txt')['record']['body'])
        with self.assertRaisesRegex(ValueError, 'different capture settings'):
            self.capture(limits={'entries': 10})
        self.registry.disable(self.sid)
        with self.assertRaises(ValueError):
            self.capture()

    def test_mid_scan_edit_and_membership_changes_abort(self):
        from knowledge_agent import source_archive as archive
        extract = archive._extract
        def edit(raw, path, limit):
            value = extract(raw, path, limit)
            (self.docs / path).write_bytes(raw.replace(b'v1', b'v2'))
            return value
        with patch.object(archive, '_extract', side_effect=edit):
            with self.assertRaisesRegex(ValueError, 'bytes changed'):
                self.capture()
        self.assertEqual(self.registry.source_generations(self.sid)['generations'], [])
        def add(raw, path, limit):
            (self.docs / 'new.txt').write_text('new')
            return extract(raw, path, limit)
        with patch.object(archive, '_extract', side_effect=add):
            with self.assertRaisesRegex(ValueError, 'membership changed'):
                self.capture()

    def test_concurrent_writer_and_transaction_rollback_after_blob_insert(self):
        from knowledge_agent import source_archive as archive
        with self.registry._writer():
            with self.assertRaisesRegex(ValueError, 'busy'):
                self.capture()
            blocked = subprocess.run([sys.executable, '-m', 'knowledge_agent.cli', 'archive', '--workspace', str(self.state),
                                      'capture', self.sid, '--request-key', 'concurrent'],capture_output=True,text=True)
            self.assertEqual(blocked.returncode,2)
            self.assertIn('busy',json.loads(blocked.stdout)['error'])
        original = archive._put_blob
        def insert_then_interrupt(db, key, raw):
            original(db, key, raw)
            raise KeyboardInterrupt()
        with patch.object(archive, '_put_blob', side_effect=insert_then_interrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.capture()
        with self.registry._db() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM archive_blobs').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT count(*) FROM archive_generations').fetchone()[0], 0)
        self.capture()

    def test_independent_corruption_is_rejected(self):
        (self.docs / 'guide.html').write_text('<html><body>ArchiveSignal</body></html>')
        first = self.capture()
        generation = first['generation']
        item = next(d for d in self.registry.source_generation(self.sid, generation)['documents'] if d['path']=='guide.html')
        for ref in (item['original'], item['representation']):
            with self.registry._db() as db:
                raw = db.execute('SELECT data FROM archive_blobs WHERE sha256=?', (ref['sha256'],)).fetchone()[0]
                db.execute('UPDATE archive_blobs SET data=? WHERE sha256=?', (b'corrupt', ref['sha256']))
            with self.assertRaisesRegex(ValueError, 'integrity'):
                self.registry.read_snapshot(self.sid, generation, 'guide.html')
            with self.registry._db() as db:
                db.execute('UPDATE archive_blobs SET data=? WHERE sha256=?', (raw, ref['sha256']))
        with self.registry._db() as db:
            db.execute('UPDATE archive_generations SET manifest=?', (b'{}',))
        with self.assertRaisesRegex(ValueError, 'integrity'):
            self.registry.source_generation(self.sid, generation)

    def test_bounds_exclusions_symlinks_and_safe_recovery(self):
        (self.docs / '.excluded').mkdir()
        (self.docs / '.excluded' / 'private.txt').write_text('secret')
        (self.docs / 'link').symlink_to(self.root)
        first = self.capture()
        rows = {d['path']: d for d in self.registry.source_generation(self.sid, first['generation'])['documents']}
        self.assertEqual(rows['.excluded']['reason'], 'excluded')
        self.assertNotIn('.excluded/private.txt', rows)
        self.assertEqual(rows['link']['reason'], 'symlink')
        for destination in (self.docs/'restored', self.state/'restored'):
            with self.assertRaises(ValueError):
                self.registry.recover_original(self.sid, first['generation'], 'guide.txt', destination)
        existing = self.root/'existing'; existing.write_bytes(b'keep')
        parent_link = self.root/'parent-link'; parent_link.symlink_to(self.root, target_is_directory=True)
        for destination in (existing, parent_link/'restored'):
            with self.assertRaises((ValueError, OSError)):
                self.registry.recover_original(self.sid, first['generation'], 'guide.txt', destination)
        self.assertEqual(existing.read_bytes(), b'keep')
        for path in ('../guide.txt', '/guide.txt', 'link/guide.txt', '.excluded/private.txt'):
            with self.assertRaises(ValueError):
                self.registry.read_snapshot(self.sid, first['generation'], path)
        with self.assertRaisesRegex(ValueError, 'enumeration'):
            self.capture('overflow', limits={'entries': 1})
        limited = self.capture('limited', limits={'file_bytes': 1})
        self.assertEqual(limited['preservation'], 'incomplete')
        self.assertEqual(limited['counts']['limited'], 1)
        with self.assertRaises(ValueError):
            self.registry.source_generation(self.sid, first['generation'], max_bytes=100)

    def test_configuration_and_snapshot_scope_binding(self):
        from knowledge_agent.consumer_access import ConsumerGateway, ConsumerScope, _sanitize_result
        first = self.capture()
        gateway = ConsumerGateway(self.registry, ConsumerScope.create([self.sid]))
        options = dict(source_ids=[self.sid], snapshot_generations={self.sid:first['generation']})
        self.assertEqual(gateway.discover('ArchiveSignal', **options)['documents'][0]['source_id'], self.sid)
        for snapshots in ({}, {self.sid:first['generation'], 'denied':first['generation']}):
            with self.assertRaises(ValueError):
                gateway.discover('ArchiveSignal', source_ids=[self.sid], snapshot_generations=snapshots)
        with self.assertRaises(ValueError):
            gateway.read(self.sid, 'guide.txt', snapshot_generation=first['generation'], expected_generation='current')
        with self.assertRaises(ValueError):
            _sanitize_result({'nested': {'snapshot_generations': {'denied':'x'}}}, self.registry.list(), frozenset([self.sid]))
        page = self.registry.read_snapshot(self.sid, first['generation'], 'guide.txt', max_chars=1)
        with self.registry._db() as db:
            source = self.registry._source(db, self.sid)
            source['exclude'].append('guide.txt')
            self.registry._save(db, source)
        with self.assertRaises(ValueError):
            self.registry.read_snapshot(self.sid, first['generation'], 'guide.txt', cursor=page['next_cursor'])

    def test_current_only_operations_reject_nested_historical_evidence(self):
        first = self.capture()
        citation = self.registry.read_snapshot(self.sid, first['generation'], 'guide.txt')['record']['citations'][0]
        with self.assertRaisesRegex(ValueError, 'historical'):
            self.registry.expand([{'reference': citation}], source_ids=[self.sid])
        with self.assertRaisesRegex(ValueError, 'historical'):
            self.registry.validate_claims([], consumed=[{'nested':citation}], source_ids=[self.sid])
        with self.assertRaisesRegex(ValueError, 'historical'):
            self.registry.outline(self.sid, 'guide.txt', snapshot_generation=first['generation'])

    def test_cli_capture_resume_inspection_and_original_recovery(self):
        def cli(*args):
            result = subprocess.run([sys.executable, '-m', 'knowledge_agent.cli', 'archive', '--workspace', str(self.state), *args], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
            return json.loads(result.stdout)
        first = cli('capture', self.sid, '--request-key', 'cli')
        gen = first['generation']
        first_page = cli('read', self.sid, gen, 'guide.txt', '--max-chars', '3')
        (self.docs/'guide.txt').unlink()
        second_page = cli('read', self.sid, gen, 'guide.txt', '--cursor', first_page['next_cursor'])
        self.assertEqual(first_page['record']['body']+second_page['record']['body'], 'ArchiveSignal café v1\nsecond line\n')
        self.assertEqual(cli('inspect', self.sid, gen, '--manifest-sha256', first['manifest_sha256'])['integrity'], 'verified')
        self.assertEqual(len(cli('generations',self.sid)['generations']),1)
        found = cli('discover','ArchiveSignal','--source',self.sid,'--snapshots',json.dumps({self.sid:gen}))
        self.assertEqual(found['documents'][0]['path'],'guide.txt')
        cli('export','--snapshots',json.dumps({self.sid:gen}),str(self.root/'cli-bundle'))
        self.assertEqual(cli('import',str(self.root/'cli-bundle'))['access_settings'],'preserved')
        cli('recover', self.sid, gen, 'guide.txt', str(self.root/'cli-restored'))
        self.assertEqual((self.root/'cli-restored').read_text(), 'ArchiveSignal café v1\nsecond line\n')

    def test_import_corrupt_partial_collision_unknown_and_idempotence(self):
        first = self.capture()
        bundle = self.root/'backup'
        self.registry.export_archive({self.sid:first['generation']}, bundle)
        self.registry.import_archive(bundle)
        self.registry.import_archive(bundle)
        self.assertEqual(len(self.registry.source_generations(self.sid)['generations']),1)
        original = json.loads(bundle.read_bytes())
        for mutation in ('missing','manifest','blob'):
            data = json.loads(json.dumps(original))
            if mutation == 'missing':
                data['blobs'].pop(next(iter(data['blobs'])))
            elif mutation == 'manifest':
                data['generations'][0]['manifest']['documents'][0]['path'] = 'forged'
            else:
                data['blobs'][next(iter(data['blobs']))] = 'Y29ycnVwdA=='
            damaged = self.root/mutation; damaged.write_text(json.dumps(data))
            with self.assertRaises(ValueError):
                self.registry.import_archive(damaged)
            self.assertEqual(len(self.registry.source_generations(self.sid)['generations']),1)
        other = SourceRegistry(self.root/'other-state')
        with self.assertRaisesRegex(ValueError, 'unknown source'):
            other.import_archive(bundle)

    def test_malformed_bundle_and_export_selectors_fail_with_value_error(self):
        from knowledge_agent.source_archive import canonical, digest
        first = self.capture()
        bundle = self.root/'valid-bundle'
        self.registry.export_archive({self.sid:first['generation']},bundle)
        data = json.loads(bundle.read_bytes())
        data['generations'][0]['manifest']['policy'] = None
        data['generations'][0]['manifest_sha256'] = digest(canonical(data['generations'][0]['manifest']))
        bad = self.root/'invalid-bundle'; bad.write_bytes(canonical(data))
        with self.assertRaises(ValueError):
            self.registry.import_archive(bad)
        with self.assertRaises(ValueError):
            self.registry.export_archive(None,self.root/'should-not-exist')
        self.assertFalse((self.root/'should-not-exist').exists())

    def test_discovery_cursor_and_read_pins_never_switch_generation(self):
        (self.docs/'other.txt').write_text('ArchiveSignal other')
        first = self.capture()
        opts = dict(source_ids=[self.sid], snapshot_generations={self.sid:first['generation']},limit=1)
        page = self.registry.discover_snapshot('ArchiveSignal', **opts)
        self.assertIsNotNone(page['next_cursor'])
        new = self.capture('second')
        tail = self.registry.discover_snapshot('ArchiveSignal', cursor=page['next_cursor'], **opts)
        self.assertEqual(len(tail['documents']), 1)
        with self.assertRaisesRegex(ValueError, 'binding'):
            self.registry.discover_snapshot('different', cursor=page['next_cursor'], **opts)
        opts['snapshot_generations'][self.sid] = new['generation']
        with self.assertRaisesRegex(ValueError, 'binding'):
            self.registry.discover_snapshot('ArchiveSignal', cursor=page['next_cursor'], **opts)
        read = self.registry.read_snapshot(self.sid, first['generation'], 'guide.txt', max_chars=2)
        with self.assertRaisesRegex(ValueError, 'binding'):
            self.registry.read_snapshot(self.sid, new['generation'], 'guide.txt', cursor=read['next_cursor'])
        with self.assertRaisesRegex(ValueError, 'pin'):
            self.registry.read_snapshot(self.sid, first['generation'], 'guide.txt', manifest_sha256='0'*64)

    def test_synthetic_format_and_layout_matrix(self):
        from test_knowledge_folder_import import simple_pdf, zip_xml
        (self.docs/'guide.txt').unlink()
        for name, text in {
            'nx.json': '{"targetDefaults":{}}',
            'apps/driver/src/main.ts': 'const ArchiveSignal = "driver";',
            'libs/common/src/index.ts': 'export const ArchiveSignal = "common";',
            'modules/client/main.py': 'ArchiveSignal = "ordinary package"',
            'modules/server/readme.md': '# ArchiveSignal\n![image](https://invalid.example/image.png)',
            'guide.md': '# ArchiveSignal markdown', 'plain.txt':'ArchiveSignal café',
            'web.html':'<html><body>ArchiveSignal caption<img src="remote.png"><script>not-evidence</script></body></html>',
        }.items():
            path = self.docs/name; path.parent.mkdir(parents=True,exist_ok=True); path.write_text(text)
        (self.docs/'searchable.pdf').write_bytes(simple_pdf('ArchiveSignal PDF'))
        from pypdf import PdfWriter
        import io
        writer = PdfWriter(); writer.add_blank_page(width=100,height=100)
        buffer = io.BytesIO(); writer.write(buffer)
        (self.docs/'blank.pdf').write_bytes(buffer.getvalue())
        from archive_fixtures import tiny_png, image_docx, image_pdf
        png = tiny_png()
        (self.docs/'picture.png').write_bytes(png)
        image_pdf(self.docs/'scanned.pdf')
        image_docx(self.docs/'office.docx', png)
        zip_xml(self.docs/'office.odt', {'mimetype':'application/vnd.oasis.opendocument.text', 'content.xml':'<document><p>ArchiveSignal ODT</p></document>'})
        originals = {p.relative_to(self.docs).as_posix(): p.read_bytes() for p in self.docs.rglob('*') if p.is_file()}
        first = self.capture()
        manifest = self.registry.source_generation(self.sid,first['generation'],limit=200)
        rows = {d['path']:d for d in manifest['documents'] if d['original']}
        self.assertEqual(set(rows),set(originals))
        matrix = []
        for name, raw in originals.items():
            restored = self.root/('restored-'+str(len(matrix)))
            self.registry.recover_original(self.sid,first['generation'],name,restored)
            self.assertEqual(restored.read_bytes(),raw)
            import hashlib
            self.assertEqual(rows[name]['original']['sha256'],hashlib.sha256(raw).hexdigest())
            rep = rows[name]['representation']
            if name in ('picture.png', 'blank.pdf', 'scanned.pdf'):
                self.assertIsNone(rep)
                self.assertIn('visual-evidence-unavailable',rows[name]['gaps'])
            elif name == 'searchable.pdf' and rep is None:
                self.assertIn('pdf-memory-boundary-unavailable',rows[name]['gaps'])
            else:
                read = self.registry.read_snapshot(self.sid,first['generation'],name)
                self.assertEqual(read['record']['citations'][0]['text_end'],len(read['record']['body']))
                self.assertEqual(rep['sha256'],hashlib.sha256(read['record']['body'].encode()).hexdigest())
                if name != 'nx.json':
                    self.assertIn('ArchiveSignal',read['record']['body'])
            matrix.append(dict(path=name, preserved=restored.read_bytes()==raw, extraction=rows[name]['extraction_status'],gaps=rows[name]['gaps']))
        result = self.registry.discover_snapshot('imageOnlySecret', source_ids=[self.sid], snapshot_generations={self.sid:first['generation']})
        self.assertEqual(result['documents'],[])
        self.assertIn('visual-evidence-unavailable',{g['reason'] for g in result['gaps']})
        self.assertEqual(manifest['capabilities']['structural_navigation'],'unsupported')
        # Captured by the verification runner; every reported outcome follows assertions above.
        print('ARCHIVE_MATRIX='+json.dumps(matrix,sort_keys=True))

    def test_expansion_output_timeout_and_empty_are_honest_gaps(self):
        import zipfile
        from knowledge_agent import source_archive as archive
        with zipfile.ZipFile(self.docs/'expanded.docx','w',compression=zipfile.ZIP_DEFLATED) as z:
            z.writestr('word/document.xml', b'x'*(32*1024*1024+1))
        (self.docs/'empty.txt').write_bytes(b'')
        first = self.capture()
        rows = {d['path']:d for d in self.registry.source_generation(self.sid,first['generation'])['documents']}
        self.assertIn('office-expansion-limit', rows['expanded.docx']['gaps'])
        self.assertIsNotNone(rows['expanded.docx']['original'])
        self.assertIn('empty-document', rows['empty.txt']['gaps'])
        limited = self.capture('small-text', limits={'text_bytes':2})
        row = next(d for d in self.registry.source_generation(self.sid,limited['generation'])['documents'] if d['path']=='guide.txt')
        self.assertIsNone(row['representation'])
        with patch.object(archive.subprocess,'run',side_effect=subprocess.TimeoutExpired('fixture',1)):
            self.assertEqual(archive._extract(b'text','file.txt',100)['reason'],'extraction-timeout')

    def test_migration_zero_one_two_is_transactional_and_retryable(self):
        import sqlite3
        from knowledge_agent import source_archive as archive
        for version in (0,1,2):
            workspace = self.root/f'migration-{version}'; workspace.mkdir()
            db = sqlite3.connect(workspace/'registry.sqlite3', isolation_level=None)
            if version:
                for statement in archive.DDL[:3 if version==1 else 5]:
                    db.execute(statement)
                db.execute('INSERT INTO sources VALUES (?,?)',('source','{"id":"source"}'))
                db.execute('INSERT INTO files VALUES (?,?,?)',('source','file','{"sha256":"retained"}'))
                if version == 2:
                    db.execute('INSERT INTO knowledge_generations VALUES (?,?,?,?,?,?)',('kg1:fixture','source','scan','fixture','hash','{}'))
            db.execute(f'PRAGMA user_version={version}')
            original = archive._ddl
            calls = []
            def fail_after_ddl(connection, statement):
                original(connection, statement); calls.append(statement)
                if len(calls)==6:
                    raise RuntimeError('migration interruption')
            with patch.object(archive,'_ddl',side_effect=fail_after_ddl):
                with self.assertRaises(RuntimeError):
                    SourceRegistry(workspace)
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0],version)
            self.assertIsNone(db.execute("SELECT name FROM sqlite_master WHERE name='archive_blobs'").fetchone())
            SourceRegistry(workspace)
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0],5)
            if version:
                self.assertEqual(db.execute('SELECT data FROM files').fetchone()[0],'{"sha256":"retained"}')
            if version == 2:
                self.assertEqual(db.execute('SELECT id FROM knowledge_generations').fetchone()[0],'kg1:fixture')
            db.close()
        with self.registry._db() as db:
            db.execute('PRAGMA user_version=99')
        with self.assertRaises(ValueError):
            SourceRegistry(self.state)

    def test_duplicate_bytes_keep_origins_and_failed_refresh_keeps_archive(self):
        other = self.root/'other'; other.mkdir()
        (other/'guide.txt').write_bytes((self.docs/'guide.txt').read_bytes())
        second_sid = self.registry.add(other)['id']
        first = self.capture()
        second = self.registry.capture_source(second_sid,request_key='first')
        snapshots = {self.sid:first['generation'],second_sid:second['generation']}
        found = self.registry.discover_snapshot('ArchiveSignal',source_ids=list(snapshots),snapshot_generations=snapshots)
        self.assertEqual({d['source_id'] for d in found['documents']},set(snapshots))
        self.assertEqual(len({d['sha256'] for d in found['documents']}),1)
        shutil.rmtree(self.docs)
        self.assertEqual(self.registry.refresh(self.sid)['status'],'unavailable')
        self.assertIn('v1',self.registry.read_snapshot(self.sid,first['generation'],'guide.txt')['record']['body'])
        with self.assertRaises(ValueError):
            self.registry.read_snapshot('unknown',first['generation'],'guide.txt')

    def test_import_collision_rollback_and_exclusions_remain_authoritative(self):
        from knowledge_agent.source_archive import canonical, digest
        first = self.capture()
        bundle = self.root/'bundle'; self.registry.export_archive({self.sid:first['generation']},bundle)
        data = json.loads(bundle.read_bytes())
        data['generations'][0]['manifest']['documents'][0]['path'] = 'changed.txt'
        data['generations'][0]['manifest_sha256'] = digest(canonical(data['generations'][0]['manifest']))
        forged = self.root/'collision'; forged.write_bytes(canonical(data))
        with self.assertRaisesRegex(ValueError,'collision'):
            self.registry.import_archive(forged)
        with self.registry._db() as db:
            db.execute('DELETE FROM archive_generations')
            db.execute('DELETE FROM archive_blobs')
            source = self.registry._source(db,self.sid)
            source['exclude'].append('guide.txt')
            self.registry._save(db,source)
        self.registry.import_archive(bundle)
        with self.assertRaisesRegex(ValueError,'configuration'):
            self.registry.read_snapshot(self.sid,first['generation'],'guide.txt')
        self.assertIn('guide.txt',self.registry.list()[0]['exclude'])

    def test_total_bytes_recursion_and_regular_refresh_nonretaining(self):
        self.registry.refresh(self.sid)
        self.assertEqual(self.registry.source_generations(self.sid)['generations'],[])
        (self.docs/'second.txt').write_text('second document')
        (self.docs/'nested').mkdir()
        (self.docs/'nested'/'hidden.txt').write_text('nested text')
        with self.registry._db() as db:
            source = self.registry._source(db,self.sid); source['recursive'] = False
            self.registry._save(db,source)
        first = self.capture(limits={'total_bytes':35})
        self.assertEqual(first['preservation'],'incomplete')
        rows = {d['path']:d for d in self.registry.source_generation(self.sid,first['generation'])['documents']}
        self.assertEqual(rows['nested']['reason'],'not-recursive')
        self.assertNotIn('nested/hidden.txt',rows)
        self.assertEqual(rows['second.txt']['status'],'limited')


class ArchiveMCPTests(unittest.IsolatedAsyncioTestCase):
    setUp = ArchiveTests.setUp

    async def test_real_consumer_snapshot_restart_scope_refusal_and_current_only(self):
        from mcp import Client, StdioServerParameters
        from knowledge_agent.mcp_server import connection_config
        from test_consumer_mcp import CONSUMER_TOOLS
        first = self.registry.capture_source(self.sid, request_key='mcp')
        gen = first['generation']
        denied = self.root/'denied'; denied.mkdir()
        (denied/'private.txt').write_text('Do not disclose')
        denied_sid = self.registry.add(denied)['id']
        config = connection_config(self.state, profile='source-read-only', allowed_source_ids=[self.sid])['mcpServers']['knowledge-agent-consumer']
        parameters = StdioServerParameters(command=config['command'],args=config['args'],cwd=str(self.root))
        async with Client(parameters,read_timeout_seconds=20) as client:
            self.assertEqual({tool.name for tool in (await client.list_tools()).tools}, CONSUMER_TOOLS)
            result = await client.call_tool('knowledge_read',dict(source_id=self.sid,path='guide.txt',snapshot_generation=gen,max_chars=5))
            self.assertFalse(result.is_error,result.content)
            page = result.structured_content
            self.assertEqual(json.loads(result.content[0].text),page)
            self.assertNotIn('absolute_path',json.dumps(page))
            self.assertEqual(page['record']['body'],'Archi')
            for forbidden in (denied_sid,'fabricated'):
                result = await client.call_tool('knowledge_discover', dict(query='ArchiveSignal',snapshot_generations={forbidden:gen}))
                self.assertTrue(result.is_error)
                self.assertIn('outside this connection scope',result.content[0].text)
            result = await client.call_tool('knowledge_discover',dict(query='ArchiveSignal',snapshot_generations={self.sid:gen}))
            self.assertFalse(result.is_error,result.content)
            self.assertEqual(result.structured_content['documents'][0]['path'],'guide.txt')
            for name, args in [
                ('knowledge_outline',dict(source_id=self.sid,path='guide.txt',snapshot_generation=gen)),
                ('knowledge_expand',dict(selections=[page['record']['citations'][0]])),
                ('knowledge_validate_claims',dict(claims=[],consumed=[{'nested':page['record']['citations'][0]}])),
                ('knowledge_read',dict(source_id=self.sid,path='guide.txt',snapshot_generation=gen,expected_generation=gen)),
                ('capture_source',dict(source_id=self.sid,request_key='forbidden')),
            ]:
                result = await client.call_tool(name,args)
                self.assertTrue(result.is_error,(name,result.content))
        (self.docs/'guide.txt').write_text('ArchiveSignal v2')
        self.registry.capture_source(self.sid,request_key='mcp-v2')
        shutil.rmtree(self.docs)
        shutil.rmtree(self.state/'cache',ignore_errors=True)
        async with Client(parameters,read_timeout_seconds=20) as client:
            result = await client.call_tool('knowledge_read',dict(source_id=self.sid,path='guide.txt',snapshot_generation=gen,cursor=page['next_cursor']))
            self.assertFalse(result.is_error,result.content)
            self.assertEqual(page['record']['body']+result.structured_content['record']['body'],'ArchiveSignal café v1\nsecond line\n')
            self.registry.disable(self.sid)
            result = await client.call_tool('knowledge_read',dict(source_id=self.sid,path='guide.txt',snapshot_generation=gen))
            self.assertTrue(result.is_error)
