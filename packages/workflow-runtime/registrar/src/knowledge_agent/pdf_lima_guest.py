"""One-job Linux cgroup boundary for the local Lima PDF worker.

Copied into a fresh tmpfs job by the host. It is deliberately independent of
the archive package so boundary checks run before importing the PDF parser.
"""
from __future__ import annotations

import hashlib
import base64
import ctypes
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
import resource

ROOT = Path('/dev/shm/temari-pdf-jobs')
ACTIVE = Path('/dev/shm/temari-pdf-active')
CGROUP = Path('/sys/fs/cgroup')
MEMORY = 512 * 1024 * 1024


def _hash(path, limit):
    state = hashlib.sha256()
    total = 0
    with Path(path).open('rb') as stream:
        while block := stream.read(65536):
            total += len(block)
            if total > limit:
                raise ValueError('PDF job byte limit')
            state.update(block)
    return state.hexdigest()


def _paths(job_id):
    if len(job_id) != 32 or any(ch not in '0123456789abcdef' for ch in job_id):
        raise ValueError('invalid PDF job identity')
    return ROOT / job_id, CGROUP / ('temari-pdf-' + job_id)


def cleanup(job_id):
    job, group = _paths(job_id)
    if group.exists():
        for raw in (group / 'cgroup.procs').read_text().splitlines():
            try:
                os.kill(int(raw), signal.SIGKILL)
            except ProcessLookupError:
                pass
        for _ in range(5):
            try:
                group.rmdir()
                break
            except OSError:
                time.sleep(0.2)
        if group.exists():
            # Keep the private job and active lock. An old parser may still be
            # running, so admitting another job would expose its bytes.
            raise ValueError('PDF cgroup cleanup incomplete')
    if job.exists():
        shutil.rmtree(job)
    marker = ACTIVE / 'job-id'
    if marker.is_file() and marker.read_text() == job_id:
        marker.unlink()
        ACTIVE.rmdir()


def arm(job_id):
    job, _ = _paths(job_id)
    if not job.is_dir():
        raise ValueError('PDF job unavailable')
    subprocess.Popen([sys.executable, __file__, 'expire', job_id],
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, close_fds=True, start_new_session=True,
                     env={'PATH': '/usr/bin:/bin'})


def accept(job_id, name, limit, expected):
    job, _ = _paths(job_id)
    if not job.is_dir() or job.is_symlink() or job.stat().st_mode & 0o077:
        raise ValueError('PDF job is not private')
    raw = sys.stdin.buffer.read(limit + 1)
    if len(raw) > limit or hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError('PDF input transfer integrity mismatch')
    with (job / name).open('xb') as stream:
        stream.write(raw)
    return {'status': 'accepted', 'sha256': expected, 'bytes': len(raw)}


def emit(job_id, expected, limit):
    job, _ = _paths(job_id)
    result = job / 'result.json'
    if not result.is_file() or result.stat().st_size > limit:
        raise ValueError('PDF result byte limit')
    raw = result.read_bytes()
    if len(raw) > limit or hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError('PDF result integrity mismatch')
    sys.stdout.buffer.write(raw)


def run(job_id, original_sha, text_limit, encoded_relative, python):
    relative = base64.b64decode(encoded_relative, altchars=b'-_', validate=True).decode('utf-8')
    job, group = _paths(job_id)
    if not any(' /dev/shm ' in line and ' - tmpfs ' in line for line in Path('/proc/self/mountinfo').read_text().splitlines()):
        raise ValueError('PDF tmpfs unavailable')
    if not job.is_dir() or job.is_symlink() or job.stat().st_mode & 0o077:
        raise ValueError('PDF job is not private')
    original = job / 'original.pdf'
    if original.stat().st_size > 8 * 1024 * 1024 or _hash(original, 8 * 1024 * 1024) != original_sha:
        raise ValueError('PDF transfer integrity mismatch')
    identity_file = job / 'identity.json'
    if identity_file.stat().st_size > 4096:
        raise ValueError('PDF identity limit')
    identity = json.loads(identity_file.read_bytes())
    package = job / 'src' / 'knowledge_agent'
    for name, expected in identity['files'].items():
        if name not in {'__init__.py', 'archive_worker.py', 'knowledge.py', 'knowledge_cache.py', 'structure.py'}:
            raise ValueError('unapproved PDF worker file')
        if _hash(package / name, 1024 * 1024) != expected:
            raise ValueError('PDF worker integrity mismatch')
    if set(identity['files']) != {'__init__.py', 'archive_worker.py', 'knowledge.py', 'knowledge_cache.py', 'structure.py'}:
        raise ValueError('incomplete PDF worker files')
    if not (CGROUP / 'cgroup.controllers').is_file() or 'memory' not in (CGROUP / 'cgroup.controllers').read_text().split():
        raise ValueError('PDF memory controller unavailable')
    enabled = (CGROUP / 'cgroup.subtree_control').read_text().split()
    if 'memory' not in enabled:
        (CGROUP / 'cgroup.subtree_control').write_text('+memory')
    group.mkdir(mode=0o700)
    try:
        (group / 'memory.max').write_text(str(MEMORY))
        (group / 'memory.swap.max').write_text('0')
        if (group / 'memory.max').read_text().strip() != str(MEMORY) or (group / 'memory.swap.max').read_text().strip() != '0':
            raise ValueError('PDF memory/swap cap unavailable')
        if not hasattr(os, 'unshare') or not hasattr(os, 'CLONE_NEWNET'):
            raise ValueError('PDF network isolation unavailable')
        def enter_group():
            (group / 'cgroup.procs').write_text(str(os.getpid()))
            os.unshare(os.CLONE_NEWNET)
            if ctypes.CDLL(None).prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
                raise ValueError('PDF privilege boundary unavailable')
            os.setgroups([])
            os.setgid(owner.st_gid)
            os.setuid(owner.st_uid)
            if os.geteuid() == 0 or any(
                    int(line.split(':', 1)[1].strip(), 16) != 0
                    for line in Path('/proc/self/status').read_text().splitlines()
                    if line.startswith(('CapEff:', 'CapPrm:', 'CapAmb:'))):
                raise ValueError('PDF capability boundary unavailable')
        owner = job.stat()
        version_path = job / 'pypdf-version.txt'
        with version_path.open('wb') as version_stream:
            def enter_version_group():
                enter_group()
                resource.setrlimit(resource.RLIMIT_FSIZE, (128, 128))
            version = subprocess.run([python, '-c',
                                      'import importlib.metadata as m; print(m.version("pypdf"))'],
                                     stdin=subprocess.DEVNULL, stdout=version_stream,
                                     stderr=subprocess.DEVNULL, env={'PATH': '/usr/bin:/bin'},
                                     preexec_fn=enter_version_group, timeout=3, check=False)
        if version.returncode or version_path.read_bytes().strip() != b'6.17.0':
            raise ValueError('PDF dependency version mismatch')
        command = [python, '-m', 'knowledge_agent.archive_worker', str(original),
                   str(job / 'result.json'), relative, str(text_limit), 'none']
        env = {'PATH': '/usr/bin:/bin', 'PYTHONPATH': str(job / 'src'), 'PYTHONDONTWRITEBYTECODE': '1'}
        child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, env=env, preexec_fn=enter_group,
                                 start_new_session=True)
        try:
            status = child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=2)
            raise ValueError('PDF extraction timeout')
        if status:
            raise ValueError('PDF extraction resource boundary')
        result = job / 'result.json'
        if not result.is_file() or result.stat().st_size > text_limit * 6 + 65536:
            raise ValueError('PDF extraction output limit')
        return {'status': 'ok', 'output_sha256': _hash(result, text_limit * 6 + 65536),
                'output_bytes': result.stat().st_size}
    finally:
        if group.exists():
            for raw in (group / 'cgroup.procs').read_text().splitlines():
                os.kill(int(raw), signal.SIGKILL)
            group.rmdir()


def main():
    try:
        if sys.argv[1] == 'arm' and len(sys.argv) == 3:
            arm(sys.argv[2])
            print(json.dumps({'status': 'armed'}))
        elif sys.argv[1] == 'expire' and len(sys.argv) == 3:
            time.sleep(45)
            cleanup(sys.argv[2])
        elif sys.argv[1] == 'identity' and len(sys.argv) == 4:
            print(json.dumps(accept(sys.argv[2], 'identity.json', 4096, sys.argv[3])))
        elif sys.argv[1] == 'ingest' and len(sys.argv) == 4:
            print(json.dumps(accept(sys.argv[2], 'original.pdf', 8 * 1024 * 1024, sys.argv[3])))
        elif sys.argv[1] == 'emit' and len(sys.argv) == 5:
            emit(sys.argv[2], sys.argv[3], int(sys.argv[4]))
        elif sys.argv[1] == 'cleanup' and len(sys.argv) == 3:
            cleanup(sys.argv[2])
            print(json.dumps({'status': 'clean'}))
        elif sys.argv[1] == 'run' and len(sys.argv) == 7:
            print(json.dumps(run(sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5], sys.argv[6])))
        else:
            return 2
        return 0
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        print(json.dumps({'status': 'failed', 'reason': str(exc)[:120]}))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
