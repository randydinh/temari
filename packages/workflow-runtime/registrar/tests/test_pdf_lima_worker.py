"""Focused archive invariants for the opt-in local PDF backend."""
import hashlib
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import time
import unittest
from unittest.mock import patch

from knowledge_agent import pdf_lima_guest, pdf_lima_worker, source_archive
from knowledge_agent.source_registry import SourceRegistry


class LocalPdfWorkerTests(unittest.TestCase):
    def test_binary_hash_refuses_nonregular_oversized_and_expired_reads(self):
        with TemporaryDirectory() as temporary:
            base = Path(temporary)
            binary = base / 'limactl'
            binary.write_bytes(b'five!')
            with self.assertRaisesRegex(ValueError, 'bounded regular file'):
                pdf_lima_worker._hash_regular_file(binary, 4, time.monotonic() + 5)
            with self.assertRaisesRegex(TimeoutError, 'outer deadline'):
                pdf_lima_worker._hash_regular_file(binary, 10, time.monotonic() - 1)
            fifo = base / 'fifo'
            os.mkfifo(fifo)
            with self.assertRaisesRegex(ValueError, 'bounded regular file'):
                pdf_lima_worker._hash_regular_file(fifo, 10, time.monotonic() + 5)

    def test_partial_guest_creation_triggers_cleanup_before_watchdog(self):
        with TemporaryDirectory() as temporary:
            base = Path(temporary)
            binary = base / 'limactl'; binary.write_bytes(b'fixed binary')
            worker = object.__new__(pdf_lima_worker.LimaPdfWorker)
            worker.profile = dict(limactl=str(binary),
                                  limactl_sha256=hashlib.sha256(binary.read_bytes()).hexdigest(),
                                  lima_home=str(base), guest_python='/usr/bin/python3',
                                  guest_python_sha256='b' * 64)
            calls = []

            def shell(argv, deadline, **kwargs):
                calls.append(argv)
                if argv[0] == '/usr/bin/sha256sum':
                    return b'b' * 64 + b'  /usr/bin/python3\n'
                if 'os.mkdir(j,0o700)' in ' '.join(argv):
                    raise SystemExit(143)
                return b''

            with patch.object(worker, '_preflight'), patch.object(worker, '_shell', side_effect=shell):
                with self.assertRaises(SystemExit):
                    worker._extract(b'%PDF-1.4\n', 'a.pdf', 1024)
            self.assertEqual(len(calls), 3)
            self.assertIn('shutil.rmtree', ' '.join(calls[-1]))

    def test_cleanup_failure_does_not_mask_original_cancellation(self):
        with TemporaryDirectory() as temporary:
            base = Path(temporary)
            binary = base / 'limactl'; binary.write_bytes(b'fixed binary')
            worker = object.__new__(pdf_lima_worker.LimaPdfWorker)
            worker.profile = dict(limactl=str(binary),
                                  limactl_sha256=hashlib.sha256(binary.read_bytes()).hexdigest(),
                                  lima_home=str(base), guest_python='/usr/bin/python3',
                                  guest_python_sha256='b' * 64)
            calls = []

            def shell(argv, deadline, **kwargs):
                calls.append(argv)
                if argv[0] == '/usr/bin/sha256sum':
                    return b'b' * 64 + b'  /usr/bin/python3\n'
                if 'os.mkdir(j,0o700)' in ' '.join(argv):
                    raise SystemExit(143)
                raise ValueError('cleanup failed')

            with patch.object(worker, '_preflight'), patch.object(worker, '_shell', side_effect=shell):
                with self.assertRaises(SystemExit) as captured:
                    worker._extract(b'%PDF-1.4\n', 'a.pdf', 1024)
            self.assertEqual(captured.exception.code, 143)
            self.assertEqual(len(calls), 3)
            self.assertIn('shutil.rmtree', ' '.join(calls[-1]))

    def test_cleanup_failure_after_success_is_explicit(self):
        with TemporaryDirectory() as temporary:
            base = Path(temporary)
            binary = base / 'limactl'; binary.write_bytes(b'fixed binary')
            worker = object.__new__(pdf_lima_worker.LimaPdfWorker)
            worker.profile = dict(limactl=str(binary),
                                  limactl_sha256=hashlib.sha256(binary.read_bytes()).hexdigest(),
                                  lima_home=str(base), guest_python='/usr/bin/python3',
                                  guest_python_sha256='b' * 64, instance='temari-pdf')
            worker.file_hashes = {'archive_worker.py': 'a' * 64}
            worker.helper_hash = 'c' * 64
            emitted = b'{"synthetic":"result"}'

            def shell(argv, deadline, **kwargs):
                command = ' '.join(argv)
                if argv[0] == '/usr/bin/sha256sum':
                    sha = 'b' * 64 if argv[-1] == '/usr/bin/python3' else worker.helper_hash
                    return sha.encode() + b'  file\n'
                if 'shutil.rmtree' in command:
                    raise ValueError('cleanup failed')
                if 'arm' in argv:
                    return b'{"status":"armed"}'
                if 'identity' in argv or 'ingest' in argv:
                    data = kwargs['input_bytes']
                    return json.dumps(dict(status='accepted', sha256=hashlib.sha256(data).hexdigest(),
                                           bytes=len(data))).encode()
                if 'run' in argv:
                    return json.dumps(dict(status='ok', output_bytes=len(emitted),
                                           output_sha256=hashlib.sha256(emitted).hexdigest())).encode()
                if 'emit' in argv:
                    return emitted
                return b''

            with patch.object(worker, '_preflight'), patch.object(worker, '_shell', side_effect=shell), \
                    patch.object(worker, '_command', return_value=b''), patch.object(worker, '_validate',
                    return_value={'status': 'captured'}):
                with self.assertRaisesRegex(ValueError, 'cleanup failed'):
                    worker._extract(b'%PDF-1.4\n', 'a.pdf', 1024)

    def test_cancelled_lima_command_preserves_original_exit_when_group_is_gone(self):
        worker = object.__new__(pdf_lima_worker.LimaPdfWorker)
        worker.profile = dict(limactl='/usr/bin/limactl', lima_home='/tmp')

        class Child:
            pid = 12345
            returncode = None

            def communicate(self, **kwargs):
                raise SystemExit(143)

            def wait(self, **kwargs):
                return 0

        with patch.object(pdf_lima_worker.subprocess, 'Popen', return_value=Child()), \
                patch.object(pdf_lima_worker.os, 'killpg', side_effect=ProcessLookupError):
            with self.assertRaises(SystemExit) as captured:
                worker._command(['list'], time.monotonic() + 5)
        self.assertEqual(captured.exception.code, 143)

    def test_outer_deadline_and_timeout_fail_with_explicit_gap(self):
        worker = object.__new__(pdf_lima_worker.LimaPdfWorker)
        with self.assertRaisesRegex(TimeoutError, 'outer deadline'):
            worker._command(['list'], time.monotonic() - 1)
        with patch.object(worker, '_extract', side_effect=TimeoutError('synthetic timeout')):
            self.assertEqual(worker.extract(b'%PDF-1.4\n', 'a.pdf', 1024),
                             {'status': 'limited', 'reason': 'pdf-worker-boundary-unavailable',
                             'gaps': ['pdf-worker-boundary-unavailable']})

    def test_same_request_key_rejects_byte_only_profile_change(self):
        with TemporaryDirectory() as temporary:
            base = Path(temporary)
            binary = base / 'limactl'; binary.write_bytes(b'fixed test binary')
            profile = dict(schema=1, backend='lima-cgroup-v2-v1', limactl=str(binary),
                           limactl_sha256=hashlib.sha256(binary.read_bytes()).hexdigest(),
                           lima_home=str(base), instance='temari-pdf',
                           image_digest='sha512:' + 'a' * 128, guest_python='/usr/bin/python3',
                           guest_python_sha256='b' * 64)
            profile_path = base / 'profile.json'
            profile_path.write_text(json.dumps(profile))
            source = base / 'source'; source.mkdir()
            (source / 'a.txt').write_text('synthetic source', encoding='utf-8')
            registry = SourceRegistry(base / 'state')
            source_id = registry.add(source)['id']
            capture_args = dict(request_key='same', limits={'entries': 1},
                                pdf_worker_profile=profile_path)
            registry.capture_source(source_id, pdf_worker_profile_sha256=hashlib.sha256(
                profile_path.read_bytes()).hexdigest(), **capture_args)
            profile_path.write_text(json.dumps(profile, indent=2))
            with self.assertRaisesRegex(ValueError, 'different capture settings'):
                registry.capture_source(source_id, pdf_worker_profile_sha256=hashlib.sha256(
                    profile_path.read_bytes()).hexdigest(), **capture_args)

    def test_eight_pdf_attempt_bound_preserves_ninth_original(self):
        identity = dict(backend='lima-cgroup-v2-v1', profile_sha256='a' * 64,
                        limactl_sha256='b' * 64, guest_python_sha256='5' * 64,
                        image_digest='sha512:' + 'c' * 128,
                        helper_sha256='d' * 64, bridge_sha256='4' * 64, worker_sha256='e' * 64,
                        engine_sha256='f' * 64, cache_sha256='1' * 64,
                        structure_sha256='2' * 64, pypdf_version='6.17.0')

        class Stub:
            def __init__(self):
                self.identity = identity
                self.calls = 0

            def extract(self, raw, path, text_limit):
                self.calls += 1
                return {'status': 'limited', 'reason': 'pdf-worker-boundary-unavailable',
                        'gaps': ['pdf-worker-boundary-unavailable']}

        with TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / 'source'; root.mkdir()
            originals = {}
            for index in range(9):
                name = f'{index:02d}.pdf'
                originals[name] = b'%PDF-1.4\n' + bytes([65 + index])
                (root / name).write_bytes(originals[name])
            registry = SourceRegistry(base / 'state')
            source_id = registry.add(root)['id']
            stub = Stub()
            with patch.object(pdf_lima_worker.LimaPdfWorker, 'load', return_value=stub):
                publication = registry.capture_source(source_id, request_key='bounded-pdfs',
                                                      limits={'entries': 9},
                                                      pdf_worker_profile=base / 'profile.json')
            self.assertEqual(stub.calls, 8)
            with registry._db() as db:
                manifest = source_archive._load(registry, db, source_id, publication['generation'])
            self.assertEqual(len(manifest['documents']), 9)
            self.assertEqual(manifest['documents'][-1]['gaps'], ['pdf-worker-document-limit'])
            for item in manifest['documents']:
                name = item['path']
                self.assertEqual(item['original']['sha256'], hashlib.sha256(originals[name]).hexdigest())
                self.assertIsNone(item['representation'])
            destination = base.resolve() / 'recovered-ninth.pdf'
            registry.recover_original(source_id, publication['generation'], '08.pdf', destination)
            self.assertEqual(destination.read_bytes(), originals['08.pdf'])

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
            path.write_text(json.dumps(dict(profile, limactl_sha256='0' * 64), indent=2))
            reformatted = pdf_lima_worker.LimaPdfWorker.load(
                path, expected_sha256=hashlib.sha256(path.read_bytes()).hexdigest())
            self.assertNotEqual(worker.identity['profile_sha256'],
                                reformatted.identity['profile_sha256'])
            path.write_bytes(b' ' * (pdf_lima_worker.MAX_PROFILE + 1))
            with self.assertRaisesRegex(ValueError, 'profile path or size'):
                pdf_lima_worker.LimaPdfWorker.load(path)
            link = base / 'link.json'
            link.symlink_to(path)
            with self.assertRaisesRegex(ValueError, 'profile path or size'):
                pdf_lima_worker.LimaPdfWorker.load(link)
            fifo = base / 'profile-fifo.json'
            os.mkfifo(fifo)
            with self.assertRaisesRegex(ValueError, 'profile path or size'):
                pdf_lima_worker.LimaPdfWorker.load(fifo)

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
