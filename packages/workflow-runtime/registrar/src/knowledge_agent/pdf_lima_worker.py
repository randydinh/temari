"""Opt-in local Lima PDF extraction with a Linux cgroup v2 boundary."""
from __future__ import annotations

import hashlib
import base64
import json
import os
import pwd
from pathlib import Path
import re
import resource
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid

PACKAGE = Path(__file__).parent
FILES = ('__init__.py', 'archive_worker.py', 'knowledge.py', 'knowledge_cache.py', 'structure.py')
MAX_PROFILE = 4096
MAX_PDF = 8 * 1024 * 1024
MAX_LIMACTL = 256 * 1024 * 1024
BACKEND = 'lima-cgroup-v2-v1'


class _BusyJob(ValueError):
    pass


def _hash(raw):
    return hashlib.sha256(raw).hexdigest()


def _hash_regular_file(path, max_bytes, deadline):
    """Hash a pinned local binary without following links or unbounded reads."""
    if time.monotonic() >= deadline:
        raise TimeoutError('PDF worker outer deadline')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > max_bytes:
            raise ValueError('PDF worker binary is not a bounded regular file')
        state = hashlib.sha256()
        total = 0
        while True:
            if time.monotonic() >= deadline:
                raise TimeoutError('PDF worker outer deadline')
            block = os.read(fd, 65536)
            if not block:
                break
            total += len(block)
            if total > max_bytes:
                raise ValueError('PDF worker binary exceeds byte limit')
            state.update(block)
        if total != info.st_size or os.fstat(fd).st_size != info.st_size:
            raise ValueError('PDF worker binary changed during hash')
        return state.hexdigest()
    finally:
        os.close(fd)


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False,
                      allow_nan=False).encode('utf-8')


def _limited(reason):
    return {'status': 'limited', 'reason': reason, 'gaps': [reason]}


class LimaPdfWorker:
    def __init__(self, profile, *, profile_sha256):
        self.profile = profile
        self.file_hashes = {name: _hash((PACKAGE / name).read_bytes()) for name in FILES}
        self.helper_hash = _hash((PACKAGE / 'pdf_lima_guest.py').read_bytes())
        self.identity = {
            'backend': BACKEND,
            'profile_sha256': profile_sha256,
            'limactl_sha256': profile['limactl_sha256'],
            'guest_python_sha256': profile['guest_python_sha256'],
            'image_digest': profile['image_digest'],
            'helper_sha256': self.helper_hash,
            'bridge_sha256': _hash(Path(__file__).read_bytes()),
            'worker_sha256': self.file_hashes['archive_worker.py'],
            'engine_sha256': self.file_hashes['knowledge.py'],
            'cache_sha256': self.file_hashes['knowledge_cache.py'],
            'structure_sha256': self.file_hashes['structure.py'],
            'pypdf_version': '6.17.0',
        }

    @classmethod
    def load(cls, path, *, expected_sha256=None):
        path = Path(path)
        if not path.is_absolute():
            raise ValueError('invalid local PDF worker profile path or size')
        try:
            # Open once and cap the read itself. A path check followed by
            # read_bytes() can race a symlink swap or a growing file.
            with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK), 'rb') as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_PROFILE:
                    raise ValueError('invalid local PDF worker profile path or size')
                raw = stream.read(MAX_PROFILE + 1)
            if len(raw) > MAX_PROFILE:
                raise ValueError('invalid local PDF worker profile path or size')
            if expected_sha256 is not None:
                if not isinstance(expected_sha256, str) or not re.fullmatch(r'[0-9a-f]{64}', expected_sha256):
                    raise ValueError('invalid local PDF profile digest')
                if _hash(raw) != expected_sha256:
                    raise ValueError('local PDF profile changed since request binding')
            profile = json.loads(raw)
        except OSError as exc:
            raise ValueError('invalid local PDF worker profile path or size') from exc
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise ValueError('invalid local PDF worker profile JSON') from exc
        required = {'schema', 'backend', 'limactl', 'limactl_sha256', 'lima_home',
                    'instance', 'image_digest', 'guest_python', 'guest_python_sha256'}
        if not isinstance(profile, dict) or set(profile) != required or profile['schema'] != 1 or profile['backend'] != BACKEND:
            raise ValueError('invalid local PDF worker profile schema')
        if not isinstance(profile['instance'], str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,31}', profile['instance']):
            raise ValueError('invalid local PDF worker instance')
        if not isinstance(profile['image_digest'], str) or not re.fullmatch(r'sha512:[0-9a-f]{128}', profile['image_digest']):
            raise ValueError('invalid local PDF worker image digest')
        for key in ('limactl_sha256', 'guest_python_sha256'):
            if not isinstance(profile[key], str) or not re.fullmatch(r'[0-9a-f]{64}', profile[key]):
                raise ValueError('invalid local PDF worker binary digest')
        for key in ('limactl', 'lima_home', 'guest_python'):
            value = profile[key]
            if not isinstance(value, str) or len(value) > 512 or not value.startswith('/') or not re.fullmatch(r'/[A-Za-z0-9_./+:-]+', value):
                raise ValueError('invalid local PDF worker ' + key)
        if Path(profile['limactl']).name != 'limactl':
            raise ValueError('invalid local PDF worker binary path')
        return cls(profile, profile_sha256=_hash(raw))

    def _command(self, parts, deadline, *, output=False, output_limit=1024 * 1024, input_bytes=None):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('PDF worker outer deadline')
        env = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': pwd.getpwuid(os.getuid()).pw_dir,
               'LIMA_HOME': self.profile['lima_home'], 'LANG': 'C', 'LC_ALL': 'C'}
        with tempfile.TemporaryFile() as stream:
            def cap_output():
                resource.setrlimit(resource.RLIMIT_FSIZE, (output_limit, output_limit))
            child = subprocess.Popen([self.profile['limactl'], '--tty=false', *parts],
                                     stdin=subprocess.PIPE if input_bytes is not None else subprocess.DEVNULL,
                                     stdout=stream if output else subprocess.DEVNULL,
                                     stderr=subprocess.DEVNULL, env=env, start_new_session=True,
                                     preexec_fn=cap_output if output else None)
            try:
                child.communicate(input=input_bytes, timeout=remaining)
            except BaseException:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except OSError:
                    # A cancelled command may already have exited; retain the
                    # original cancellation rather than converting it to a gap.
                    pass
                try:
                    child.wait(timeout=2)
                except (OSError, subprocess.TimeoutExpired):
                    pass
                raise
            if child.returncode:
                raise ValueError('PDF worker Lima command failed')
            if output:
                if stream.tell() > output_limit:
                    raise ValueError('PDF worker response exceeds limit')
                stream.seek(0)
                return stream.read(output_limit + 1)
            return b''

    def _shell(self, argv, deadline, *, output=False, output_limit=1024 * 1024, input_bytes=None):
        return self._command(['shell', self.profile['instance'], '--', *argv], deadline,
                             output=output, output_limit=output_limit, input_bytes=input_bytes)

    def _preflight(self, deadline):
        instances = self._command(['list', '--json', self.profile['instance']], deadline, output=True)
        try:
            value = json.loads(instances)
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise ValueError('PDF worker VM identity unavailable') from exc
        if isinstance(value, list):
            matches = [item for item in value if isinstance(item, dict) and item.get('name') == self.profile['instance']]
            value = matches[0] if len(matches) == 1 else None
        if not isinstance(value, dict) or value.get('name') != self.profile['instance'] or value.get('status') != 'Running':
            raise ValueError('PDF worker VM unavailable')
        config = value.get('config')
        if (value.get('vmType') != 'vz' or value.get('arch') != 'aarch64' or
                not isinstance(config, dict)):
            raise ValueError('PDF worker VM isolation mismatch')
        mounts = config.get('mounts', 'omitted')
        if mounts != [] and not (mounts == 'omitted' and config.get('plain') is True):
            raise ValueError('PDF worker VM isolation mismatch')
        images = config.get('images')
        if not isinstance(images, list) or not any(isinstance(image, dict) and image.get('arch') == 'aarch64'
                                                    and image.get('digest') == self.profile['image_digest'] for image in images):
            raise ValueError('PDF worker image identity mismatch')
        mountinfo = self._shell(['/bin/cat', '/proc/self/mountinfo'], deadline, output=True)
        if (b' /dev/shm ' not in mountinfo or b' - tmpfs ' not in mountinfo or
                b' /sys/fs/cgroup ' not in mountinfo or b' - cgroup2 ' not in mountinfo or
                any(marker in mountinfo for marker in (b' - virtiofs ', b' - 9p ', b' - fuse.',
                                                       b'sshfs', b'/Users/', b'/Volumes/'))):
            raise ValueError('PDF worker guest mount isolation mismatch')
        active = self._shell(['/usr/bin/sudo', '-n', '/usr/bin/python3', '-c',
                              'import pathlib; p=pathlib.Path("/dev/shm/temari-pdf-jobs"); '
                              'a=pathlib.Path("/dev/shm/temari-pdf-active"); '
                              'print("busy" if a.exists() or (p.exists() and any(p.iterdir())) else "free")'],
                             deadline, output=True)
        if active.strip() == b'busy':
            raise _BusyJob('PDF worker busy or stale job')
        if active.strip() != b'free':
            raise ValueError('PDF worker guest job state unavailable')

    def _validate(self, raw, text_limit):
        if len(raw) > text_limit * 6 + 65536:
            raise ValueError('PDF worker result exceeds byte budget')
        try:
            value = json.loads(raw)
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise ValueError('invalid PDF worker result JSON') from exc
        if not isinstance(value, dict) or value.get('status') not in {'captured', 'limited', 'unsupported', 'unavailable'}:
            raise ValueError('invalid PDF worker status')
        if value['status'] != 'captured':
            reason = value.get('reason')
            if not isinstance(reason, str) or reason not in {
                              'empty-document', 'pdf-extraction-failed', 'extraction-output-limit',
                              'extraction-resource-boundary', 'pdf-memory-boundary-unavailable',
                              'unsupported-format', 'extraction-failed'}:
                raise ValueError('invalid PDF worker gap')
            if reason == 'empty-document':
                reason = 'pdf-no-extractable-text'
            return _limited(reason)
        from knowledge_agent.knowledge import DEFAULT_EXTRACTORS, _signature
        expected = DEFAULT_EXTRACTORS['.pdf']
        if (set(value) != {'status', 'text', 'extraction', 'extractor_signature', 'settings', 'gaps'} or
                value.get('extraction') != 'pdf-text' or
                value.get('extractor_signature') != _signature(expected) or
                value.get('settings') != json.loads(expected.identity) or
                value.get('gaps') != ['visual-evidence-unavailable', 'asset-inventory-partial'] or
                not isinstance(value.get('text'), str) or len(value['text'].encode('utf-8')) > text_limit):
            raise ValueError('PDF worker result identity mismatch')
        if not value['text'].strip():
            return _limited('pdf-no-extractable-text')
        return value

    def extract(self, raw, relative, text_limit):
        if len(raw) > MAX_PDF:
            return _limited('pdf-worker-input-limit')
        try:
            parser_name = relative if Path(relative).suffix.lower() == '.pdf' else relative + '.pdf'
            return self._extract(raw, parser_name, text_limit)
        except _BusyJob:
            return _limited('pdf-worker-busy-or-stale-job')
        except (OSError, ValueError, TimeoutError, subprocess.SubprocessError, UnicodeError):
            return _limited('pdf-worker-boundary-unavailable')

    def _extract(self, raw, relative, text_limit):
        deadline = time.monotonic() + 30
        if _hash_regular_file(self.profile['limactl'], MAX_LIMACTL, deadline) != self.profile['limactl_sha256']:
            raise ValueError('PDF worker Lima binary changed')
        if not Path(self.profile['lima_home']).is_dir():
            raise ValueError('PDF worker Lima home unavailable')
        self._preflight(deadline)
        guest_python_hash = self._shell(['/usr/bin/sha256sum', self.profile['guest_python']], deadline, output=True)
        if guest_python_hash.split(b' ', 1)[0].decode('ascii') != self.profile['guest_python_sha256']:
            raise ValueError('PDF worker guest Python identity mismatch')
        job_id = uuid.uuid4().hex
        guest = '/dev/shm/temari-pdf-jobs/' + job_id
        try:
            self._shell(['/usr/bin/sudo', '-n', '/usr/bin/python3', '-c',
                     'import os,pathlib,sys; j=sys.argv[1]; p=pathlib.Path("/dev/shm/temari-pdf-jobs"); '
                     'p.mkdir(mode=0o711,exist_ok=True); '
                     'assert not any(p.iterdir()), "another or stale PDF job exists"; '
                     'os.chown(p,0,0); os.chmod(p,0o711); '
                     'a=pathlib.Path("/dev/shm/temari-pdf-active"); a.mkdir(mode=0o700); '
                     '(a/"job-id").write_text(pathlib.Path(j).name); '
                     'u=int(os.environ["SUDO_UID"]); g=int(os.environ["SUDO_GID"]); '
                     'os.mkdir(j,0o700); os.chown(j,u,g); '
                     'os.mkdir(j+"/src",0o700); os.chown(j+"/src",u,g); '
                     'os.mkdir(j+"/src/knowledge_agent",0o700); os.chown(j+"/src/knowledge_agent",u,g)',
                     guest], deadline)
            helper = guest + '/pdf_lima_guest.py'
            self._command(['copy', '--backend=scp', str(PACKAGE / 'pdf_lima_guest.py'),
                           self.profile['instance'] + ':' + guest + '/'], deadline)
            check = self._shell(['/usr/bin/sha256sum', helper], deadline, output=True)
            if check.split(b' ', 1)[0].decode('ascii') != self.helper_hash:
                raise ValueError('PDF guest helper integrity mismatch')
            armed = json.loads(self._shell(['/usr/bin/sudo', '-n', '/usr/bin/python3', helper,
                                            'arm', job_id], deadline, output=True))
            if armed != {'status': 'armed'}:
                raise ValueError('PDF guest watchdog unavailable')
            self._command(['copy', '--backend=scp', *[str(PACKAGE / name) for name in FILES],
                           self.profile['instance'] + ':' + guest + '/src/knowledge_agent/'], deadline)
            identity = _canonical({'files': self.file_hashes})
            accepted = json.loads(self._shell(['/usr/bin/python3', helper, 'identity', job_id,
                                               _hash(identity)], deadline, output=True, input_bytes=identity))
            if accepted != {'status': 'accepted', 'sha256': _hash(identity), 'bytes': len(identity)}:
                raise ValueError('PDF worker identity transfer mismatch')
            accepted = json.loads(self._shell(['/usr/bin/python3', helper, 'ingest', job_id,
                                               _hash(raw)], deadline, output=True, input_bytes=raw))
            if accepted != {'status': 'accepted', 'sha256': _hash(raw), 'bytes': len(raw)}:
                raise ValueError('PDF worker original transfer mismatch')
            envelope = self._shell(['/usr/bin/sudo', '-n', '/usr/bin/python3', helper, 'run',
                                    job_id, _hash(raw), str(text_limit),
                                    base64.urlsafe_b64encode(relative.encode('utf-8')).decode('ascii'),
                                    self.profile['guest_python']], deadline, output=True)
            result = json.loads(envelope)
            if (not isinstance(result, dict) or result.get('status') != 'ok' or
                    not isinstance(result.get('output_bytes'), int) or
                    not 0 <= result['output_bytes'] <= text_limit * 6 + 65536 or
                    not isinstance(result.get('output_sha256'), str) or
                    not re.fullmatch(r'[0-9a-f]{64}', result['output_sha256'])):
                raise ValueError('PDF worker invalid result envelope')
            output = self._shell(['/usr/bin/python3', helper, 'emit', job_id,
                                  result['output_sha256'], str(result['output_bytes'])],
                                 deadline, output=True, output_limit=text_limit * 6 + 65536)
            if len(output) != result['output_bytes'] or _hash(output) != result['output_sha256']:
                raise ValueError('PDF worker result digest mismatch')
            return self._validate(output, text_limit)
        finally:
            pending = sys.exc_info()[1]
            # The detached guest watchdog cleans even after host SIGKILL.
            cleanup = ('import os,pathlib,shutil,signal,sys; '
                       'j=sys.argv[1]; '
                       'assert len(j)==32 and all(c in "0123456789abcdef" for c in j); '
                       'p=pathlib.Path("/dev/shm/temari-pdf-jobs")/j; '
                       'g=pathlib.Path("/sys/fs/cgroup")/("temari-pdf-"+j); '
                       '[(os.kill(int(n),signal.SIGKILL)) for n in '
                       '((g/"cgroup.procs").read_text().splitlines() if g.exists() else [])]; '
                       'g.rmdir() if g.exists() else None; '
                       'shutil.rmtree(p) if p.exists() else None; '
                       'a=pathlib.Path("/dev/shm/temari-pdf-active"); '
                       'm=a/"job-id"; '
                       '(m.unlink(),a.rmdir()) if m.is_file() and m.read_text()==j else None')
            try:
                self._shell(['/usr/bin/sudo', '-n', '/usr/bin/python3', '-c', cleanup, job_id],
                            time.monotonic() + 10)
            except BaseException:
                # Preserve the original failure, especially SystemExit from
                # SIGTERM, while a later preflight still refuses a stale job.
                if pending is None:
                    raise
