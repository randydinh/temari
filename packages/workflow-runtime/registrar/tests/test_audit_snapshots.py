"""Bounded point-in-time currentness snapshot and paging regressions."""

from pathlib import Path
from tempfile import TemporaryDirectory
import sqlite3
import unittest
from unittest.mock import patch

from knowledge_agent import source_archive
from knowledge_agent.source_registry import SourceRegistry


class AuditSnapshotTests(unittest.TestCase):
    def test_schema_four_migrates_to_five(self):
        with TemporaryDirectory() as directory:
            workspace = Path(directory) / 'state'
            SourceRegistry(workspace)
            with sqlite3.connect(workspace / 'registry.sqlite3') as db:
                db.execute('DROP TABLE archive_audits')
                db.execute('PRAGMA user_version=4')
            SourceRegistry(workspace)
            with sqlite3.connect(workspace / 'registry.sqlite3') as db:
                self.assertEqual(5, db.execute('PRAGMA user_version').fetchone()[0])
                self.assertIsNotNone(db.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='archive_audits'"
                ).fetchone())

    def test_dense_snapshot_pages_all_rows_and_preserves_observation(self):
        with TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / 'source'
            root.mkdir()
            registry = SourceRegistry(base / 'state')
            source_id = registry.add(root)['id']
            publication = registry.capture_source(source_id, request_key='empty')
            current = root
            for level in range(5):
                current = current / (str(level) + 'd' * 152)
                current.mkdir()
            for index in range(994):
                (current / (f'{index:04d}-' + 'f' * 171)).write_text('x', encoding='utf-8')
            full = source_archive._scan_current_source(
                registry, source_id, publication['generation'], publication['manifest_sha256'])
            self.assertGreater(len(source_archive.canonical(full)), source_archive.MAX_RESPONSE)
            start = registry.audit_start(source_id, publication['generation'],
                                         manifest_sha256=publication['manifest_sha256'])
            self.assertEqual(994, start['total'])
            self.assertEqual(994, start['counts']['added'])
            with self.assertRaisesRegex(ValueError, 'cannot fit one row'):
                registry.audit_page(source_id, publication['generation'], start['audit_id'],
                                    manifest_sha256=publication['manifest_sha256'], max_bytes=1024)
            (current / ('0000-' + 'f' * 171)).write_text('changed after audit', encoding='utf-8')
            cursor, paths, first_row = None, [], None
            while True:
                page = registry.audit_page(source_id, publication['generation'], start['audit_id'],
                                           manifest_sha256=publication['manifest_sha256'],
                                           cursor=cursor, limit=200, max_bytes=16384)
                self.assertLessEqual(len(source_archive.canonical(page)), 16384)
                self.assertEqual(start['audit_id'], page['audit_id'])
                self.assertEqual(start['observed_at'], page['observed_at'])
                self.assertEqual(len(paths), page['offset'])
                if first_row is None:
                    first_row = page['rows'][0]
                paths.extend(row['path'] for row in page['rows'])
                cursor = page['next_cursor']
                if cursor is None:
                    break
            self.assertEqual(994, len(paths))
            self.assertEqual(sorted(set(paths)), paths)
            self.assertEqual(source_archive.digest(b'x'), first_row['current']['sha256'])
            self.assertEqual('declared-selection-not-atomic', page['consistency'])

    def test_cursor_admission_integrity_and_retention_refusals(self):
        with TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / 'source'
            root.mkdir()
            document = root / 'a.txt'
            document.write_text('v1', encoding='utf-8')
            registry = SourceRegistry(base / 'state')
            source_id = registry.add(root)['id']
            publication = registry.capture_source(source_id, request_key='v1')
            start = registry.audit_start(source_id, publication['generation'],
                                         manifest_sha256=publication['manifest_sha256'])
            page = registry.audit_page(source_id, publication['generation'], start['audit_id'],
                                       manifest_sha256=publication['manifest_sha256'])
            self.assertEqual(1, len(page['rows']))
            document.write_text('v2', encoding='utf-8')
            more = registry.audit_start(source_id, publication['generation'],
                                        manifest_sha256=publication['manifest_sha256'])
            first = registry.audit_page(source_id, publication['generation'], more['audit_id'],
                                        manifest_sha256=publication['manifest_sha256'])
            self.assertEqual('changed', first['rows'][0]['kind'])
            forged = source_archive._audit_cursor(more['audit_id'], 1)
            with self.assertRaisesRegex(ValueError, 'offset beyond snapshot'):
                registry.audit_page(source_id, publication['generation'], more['audit_id'],
                                    manifest_sha256=publication['manifest_sha256'], cursor=forged)
            broken = forged[:-4] + 'AAAA'
            with self.assertRaises(ValueError):
                registry.audit_page(source_id, publication['generation'], more['audit_id'],
                                    manifest_sha256=publication['manifest_sha256'], cursor=broken)
            with registry._db() as db:
                db.execute('UPDATE archive_audits SET data=? WHERE id=?', (b'{}', more['audit_id']))
            with self.assertRaisesRegex(ValueError, 'integrity mismatch'):
                registry.audit_page(source_id, publication['generation'], more['audit_id'],
                                    manifest_sha256=publication['manifest_sha256'])
            registry.disable(source_id)
            with self.assertRaisesRegex(ValueError, 'source is disabled'):
                registry.audit_page(source_id, publication['generation'], start['audit_id'],
                                    manifest_sha256=publication['manifest_sha256'])
            registry.enable(source_id)
            for index in range(9):
                document.write_text(f'v{index+3}', encoding='utf-8')
                registry.audit_start(source_id, publication['generation'],
                                     manifest_sha256=publication['manifest_sha256'])
            with registry._db() as db:
                self.assertEqual(8, db.execute('SELECT count(*) FROM archive_audits WHERE source_id=?',
                                               (source_id,)).fetchone()[0])
            with self.assertRaisesRegex(ValueError, 'unavailable or expired'):
                registry.audit_page(source_id, publication['generation'], start['audit_id'],
                                    manifest_sha256=publication['manifest_sha256'])

    def test_two_thousand_union_paths_and_replayed_id_stays_retained(self):
        with TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / 'source'
            root.mkdir()
            for index in range(1000):
                (root / f'old-{index:04d}.txt').write_text('x', encoding='utf-8')
            registry = SourceRegistry(base / 'state')
            source_id = registry.add(root)['id']
            # Extraction is irrelevant to original-byte currentness; keep this
            # scale fixture focused on the 1000 + 1000 path union.
            with patch.object(source_archive, '_extract', return_value=dict(
                    status='unsupported', reason='test-no-text')):
                publication = registry.capture_source(source_id, request_key='before-union')
            for index in range(1000):
                (root / f'old-{index:04d}.txt').unlink()
                (root / f'new-{index:04d}.txt').write_text('y', encoding='utf-8')
            first = registry.audit_start(source_id, publication['generation'],
                                         manifest_sha256=publication['manifest_sha256'])
            self.assertEqual(2000, first['total'])
            self.assertEqual(1000, first['counts']['added'])
            self.assertEqual(1000, first['counts']['removed'])
            receipt = source_archive._scan_current_source(
                registry, source_id, publication['generation'], publication['manifest_sha256'])
            # Hold the observation fixed to exercise an identical content ID.
            with patch.object(source_archive, '_scan_current_source', return_value=receipt):
                repeated = registry.audit_start(source_id, publication['generation'],
                                                manifest_sha256=publication['manifest_sha256'])
                for index in range(7):
                    variation = dict(receipt, observed_at=f'2026-10-01T00:00:{index:02d}+00:00')
                    with patch.object(source_archive, '_scan_current_source', return_value=variation):
                        registry.audit_start(source_id, publication['generation'],
                                             manifest_sha256=publication['manifest_sha256'])
                replayed = registry.audit_start(source_id, publication['generation'],
                                                manifest_sha256=publication['manifest_sha256'])
            self.assertEqual(repeated['audit_id'], replayed['audit_id'])
            page = registry.audit_page(source_id, publication['generation'], replayed['audit_id'],
                                       manifest_sha256=publication['manifest_sha256'], limit=200)
            self.assertEqual(2000, page['total'])
            with registry._db() as db:
                self.assertEqual(8, db.execute('SELECT count(*) FROM archive_audits WHERE source_id=?',
                                               (source_id,)).fetchone()[0])


if __name__ == '__main__':
    unittest.main()
