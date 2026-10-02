"""Focused archive invariants for the opt-in local PDF backend."""
import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from knowledge_agent import pdf_lima_guest, pdf_lima_worker, source_archive
from knowledge_agent.source_registry import SourceRegistry


class LocalPdfWorkerTests(unittest.TestCase):
    def test_cgroup_cleanup_failure_keeps_active_lock_and_job(self):
        with TemporaryDirectory() as temporary:
            base = Path(temporary)
            jobs = base / 'jobs'; jobs.mkdir()
            cgroups = base / 'cgroups'; cgroups.mkdir()
            active = base / 'active'; active.mkdir()
            job_id = 'a' * 32
            job = jobs / job_id; job.mkdir()
            group = cgroups / ('temari-pdf-' + job_id); group.mkdir()
            (group / 'cgroup.procs').write_text('')  # A regular file keeps this test cgroup nonempty.
            (active / 'job-id').write_text(job_id)
            with patch.object(pdf_lima_guest, 'ROOT', jobs), patch.object(pdf_lima_guest, 'CGROUP', cgroups), \
                    patch.object(pdf_lima_guest, 'ACTIVE', active), patch.object(pdf_lima_guest.time, 'sleep'):
                with self.assertRaisesRegex(ValueError, 'cleanup incomplete'):
                    pdf_lima_guest.cleanup(job_id)
            self.assertTrue(job.exists())
            self.assertEqual((active / 'job-id').read_text(), job_id)

    def test_profile_rejects_unapproved_commands_and_binds_exact_bytes(self):
        with TemporaryDirectory() as temporary:
            base = Path(temporary)
            binary = base / 'limactl'; binary.write_bytes(b'fixed test binary')
            profile = dict(schema=1, backend='lima-cgroup-v2-v1', limactl=str(binary),
                           limactl_sha256=hashlib.sha256(binary.read_bytes()).hexdigest(),
                           lima_home=str(base), instance='temari-pdf',
                           image_digest='sha512:' + 'a' * 128, guest_python='/usr/bin/python3',
                           guest_python_sha256='b' * 64)
            path = base / 'profile.json'
            path.write_text(json.dumps(dict(profile, command='sh -c anything')))
            with self.assertRaisesRegex(ValueError, 'profile schema'):
                pdf_lima_worker.LimaPdfWorker.load(path)
            path.write_text(json.dumps(dict(profile, limactl_sha256='0' * 64)))
            with self.assertRaisesRegex(ValueError, 'changed since request binding'):
                pdf_lima_worker.LimaPdfWorker.load(path, expected_sha256='1' * 64)
            worker = pdf_lima_worker.LimaPdfWorker.load(path, expected_sha256=hashlib.sha256(path.read_bytes()).hexdigest())
            self.assertEqual(worker.extract(b'%PDF-1.4\n', 'a.pdf', 1024)['reason'],
                             'pdf-worker-boundary-unavailable')
            path.write_bytes(b' ' * (pdf_lima_worker.MAX_PROFILE + 1))
            with self.assertRaisesRegex(ValueError, 'profile path or size'):
                pdf_lima_worker.LimaPdfWorker.load(path)
            link = base / 'link.json'
            link.symlink_to(path)
            with self.assertRaisesRegex(ValueError, 'profile path or size'):
                pdf_lima_worker.LimaPdfWorker.load(link)

    def test_stopped_or_mounted_vm_is_refused(self):
        worker = object.__new__(pdf_lima_worker.LimaPdfWorker)
        worker.profile = {'instance': 'temari-pdf', 'image_digest': 'sha512:' + 'a' * 128}
        vm = dict(name='temari-pdf', status='Running', vmType='vz', arch='aarch64',
                  config={'images': [{'arch': 'aarch64', 'digest': worker.profile['image_digest']}],
                          'mounts': [{'location': '~'}]})
        with patch.object(worker, '_command', return_value=json.dumps(vm).encode()):
            with self.assertRaisesRegex(ValueError, 'isolation mismatch'):
                worker._preflight(100)
        vm['config']['mounts'] = []
        vm['status'] = 'Stopped'
        with patch.object(worker, '_command', return_value=json.dumps(vm).encode()):
            with self.assertRaisesRegex(ValueError, 'VM unavailable'):
                worker._preflight(100)

    def test_guest_result_requires_pinned_pdf_identity_and_readable_text(self):
        worker = object.__new__(pdf_lima_worker.LimaPdfWorker)
        from knowledge_agent.knowledge import DEFAULT_EXTRACTORS, _signature
        pdf = DEFAULT_EXTRACTORS['.pdf']
        captured = dict(status='captured', text='Searchable sentence', extraction='pdf-text',
                        extractor_signature=_signature(pdf), settings=json.loads(pdf.identity),
                        gaps=['visual-evidence-unavailable', 'asset-inventory-partial'])
        self.assertEqual(worker._validate(json.dumps(captured).encode(), 1024)['text'], 'Searchable sentence')
        forged = dict(captured, extractor_signature='0' * 64)
        with self.assertRaisesRegex(ValueError, 'identity mismatch'):
            worker._validate(json.dumps(forged).encode(), 1024)
        self.assertEqual(worker._validate(json.dumps(dict(captured, text='')).encode(), 1024)['reason'],
                         'pdf-no-extractable-text')
        self.assertEqual(worker._validate(b'{"status":"unsupported","reason":"empty-document"}', 1024)['reason'],
                         'pdf-no-extractable-text')

    def test_backend_is_request_bound_and_original_survives_worker_failure(self):
        identity = dict(backend='lima-cgroup-v2-v1', profile_sha256='a' * 64,
                        limactl_sha256='b' * 64, guest_python_sha256='5' * 64,
                        image_digest='sha512:' + 'c' * 128,
                        helper_sha256='d' * 64, bridge_sha256='4' * 64, worker_sha256='e' * 64,
                        engine_sha256='f' * 64, cache_sha256='1' * 64,
                        structure_sha256='2' * 64, pypdf_version='6.17.0')
        class Stub:
            def __init__(self, fingerprint):
                self.identity = dict(identity, profile_sha256=fingerprint)
            def extract(self, raw, path, text_limit):
                return dict(status='limited', reason='pdf-worker-boundary-unavailable',
                            gaps=['pdf-worker-boundary-unavailable'])
        with TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / 'source'; root.mkdir()
            original = b'%PDF-1.4\nworker unavailable'
            (root / 'a.pdf').write_bytes(original)
            registry = SourceRegistry(base / 'state')
            source_id = registry.add(root)['id']
            with patch.object(pdf_lima_worker.LimaPdfWorker, 'load', return_value=Stub('a' * 64)):
                first = registry.capture_source(source_id, request_key='same', limits={'entries': 32},
                                                pdf_worker_profile=base / 'one.json')
            with registry._db() as db:
                manifest = source_archive._load(registry, db, source_id, first['generation'])
                item = manifest['documents'][0]
                self.assertEqual(item['original']['sha256'], hashlib.sha256(original).hexdigest())
                self.assertIsNone(item['representation'])
                self.assertEqual(item['gaps'], ['pdf-worker-boundary-unavailable'])
            with patch.object(pdf_lima_worker.LimaPdfWorker, 'load', return_value=Stub('a' * 64)):
                replayed = registry.capture_source(source_id, request_key='same', limits={'entries': 32},
                                                   pdf_worker_profile=base / 'one.json')
            self.assertTrue(replayed['replayed'])
            with patch.object(pdf_lima_worker.LimaPdfWorker, 'load', return_value=Stub('3' * 64)):
                with self.assertRaisesRegex(ValueError, 'different capture settings'):
                    registry.capture_source(source_id, request_key='same', limits={'entries': 32},
                                            pdf_worker_profile=base / 'two.json')
            destination = base.resolve() / 'restored.pdf'
            self.assertEqual(registry.recover_original(source_id, first['generation'], 'a.pdf', destination)['sha256'],
                             hashlib.sha256(original).hexdigest())
            self.assertEqual(destination.read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
