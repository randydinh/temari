"""Disposable local derived artifacts; no source discovery or authority semantics."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import tempfile


def canonical(value) -> bytes:
    def check(item):
        if type(item) is dict:
            if any(type(key) is not str for key in item):
                raise ValueError("cache settings require string keys")
            for child in item.values():
                check(child)
        elif type(item) is list:
            for child in item:
                check(child)
        elif type(item) not in (str, int, float, bool, type(None)):
            raise ValueError("cache identity must contain JSON values")
    try:
        check(value)
        return json.dumps(value, sort_keys=True, separators=(",", ":"),
                          ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (TypeError, UnicodeError, RecursionError) as exc:
        raise ValueError("invalid cache identity") from exc


def digest(value) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def write_path(root: Path, relative: str) -> Path:
    """Validate local write locations, including existing ancestor symlinks."""
    if type(relative) is not str or not relative or "\\" in relative or "\x00" in relative:
        raise ValueError("invalid write path")
    parts = PurePosixPath(relative)
    if (parts.is_absolute() or relative != parts.as_posix() or relative == "."
            or any(p in {"..", ".git", ".agents", ".codex"} for p in parts.parts)):
        raise ValueError("write path must be project-relative and outside repository controls")
    path = root
    for part in parts.parts:
        path /= part
        if path.is_symlink():
            raise ValueError("write path symlinks are not admitted")
    return path


class ArtifactCache:
    """Checksums detect corruption, not malicious replacement by a local writer."""

    def __init__(self, root: Path, relative: str | None):
        self.root = root
        self.relative = relative
        if relative is not None:
            path = write_path(root, relative)
            if path.exists() and not path.is_dir():
                raise ValueError("cache path must be a directory")
        self.stats = {
            stage: dict(hits=0, misses=0, rejected=0, writes=0, read_errors=0, write_errors=0)
            for stage in ("extraction", "chunks", "retrieval-provider")
        }
        self.stats.update(extraction_calls=0, chunk_calls=0, uncached_extractions=0)

    def _path(self, stage: str, key: dict) -> Path:
        assert stage in ("extraction", "chunks", "retrieval-provider") and self.relative is not None
        return write_path(self.root, f"{self.relative}/{stage}/{digest(key)}.json")

    def get(self, stage: str, key: dict, validate):
        if self.relative is None:
            return None
        counters = self.stats[stage]
        path = self._path(stage, key)
        try:
            # A sanity cap on disposable artifact reads, not source admission.
            with path.open("rb") as stream:
                raw = stream.read(268_435_457)
            if len(raw) > 268_435_456:
                raise ValueError("cache artifact too large")
            entry = json.loads(raw)
            if (type(entry) is not dict or type(entry.get("schema")) is not int
                    or entry["schema"] != 1 or entry.get("stage") != stage
                    or entry.get("key") != key
                    or entry.get("sha256") != digest(entry["payload"])):
                raise ValueError("cache integrity mismatch")
            validate(entry["payload"])
        except FileNotFoundError:
            pass
        except OSError:
            counters["read_errors"] += 1
        except (ValueError, TypeError, KeyError, RecursionError, UnicodeError):
            counters["rejected"] += 1
        else:
            counters["hits"] += 1
            return entry["payload"]
        counters["misses"] += 1
        return None

    def put(self, stage: str, key: dict, payload):
        if self.relative is None:
            return
        path = self._path(stage, key)
        temporary = None
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            data = canonical({"schema": 1, "stage": stage, "key": key,
                              "payload": payload, "sha256": digest(payload)})
            with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".pending-", delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
            self.stats[stage]["writes"] += 1
        except OSError:
            self.stats[stage]["write_errors"] += 1
        finally:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    self.stats[stage]["write_errors"] += 1
