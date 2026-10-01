"""Focused refusal cases for read-only source currentness audits."""

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from knowledge_agent import source_archive
from knowledge_agent.source_registry import SourceRegistry


class CurrentnessRaceTests(unittest.TestCase):
    def test_changed_bytes_between_audit_passes_are_rejected_without_archive_mutation(self):
        with TemporaryDirectory() as directory:
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
                        source_id,
                        publication['generation'],
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


if __name__ == '__main__':
    unittest.main()
