"""Bounded, read-only OKF working sets; local configuration is caller-owned.

This reader checks bytes and spans, not arbitrary semantic entailment or authority.
Discovery stays within the explicit manifest. No network, source writes or execution.
"""

from __future__ import annotations

import argparse
import contextlib
from dataclasses import dataclass
import hashlib
from importlib.metadata import version as package_version
import io
import json
import logging
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import tempfile
from typing import Callable, Iterable
import xml.etree.ElementTree as ET
import zipfile

import yaml

from knowledge_agent import knowledge_cache
from knowledge_agent.knowledge_cache import ArtifactCache, canonical, write_path


MAX_NOTE = 65_536
MAX_SOURCE = 1_048_576
MAX_MANIFEST = 67_108_864
MAX_COLLECTION_ITEMS = 100_000
MAX_IMPORTED_CHUNK_TEXT = 48_000
STATUSES = {"CONFIRMED", "BASELINE", "PROPOSED", "OPEN", "DEFERRED", "SUPERSEDED", "REJECTED"}
DEFAULT_FOLDER_CONTEXT = ("local-documents",)
TEXT_EXTENSIONS = {
    ".adoc", ".bash", ".c", ".cc", ".cfg", ".conf", ".cpp", ".cs", ".css", ".csv", ".cxx",
    ".go", ".h", ".hpp", ".htm", ".html", ".ini", ".ipynb", ".java", ".js", ".json",
    ".jsonl", ".jsx", ".kt", ".kts", ".less", ".m", ".markdown", ".md", ".mm", ".php",
    ".properties", ".ps1", ".py", ".pyi", ".rb", ".rs", ".rst", ".sass", ".scss", ".sh",
    ".sql", ".svelte", ".swift", ".toml", ".ts", ".tsx", ".tsv", ".txt", ".vue", ".xml",
    ".yaml", ".yml", ".zsh",
}


class _ExtractionError(ValueError):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def _hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


_LOADED_ENGINE = _hash(Path(__file__).read_bytes())
_LOADED_CACHE_ENGINE = _hash(Path(knowledge_cache.__file__).read_bytes())


class _Loader(yaml.SafeLoader):
    def compose_node(self, parent, index):
        if self.check_event(yaml.AliasEvent):
            raise ValueError("YAML aliases are outside the bounded import profile")
        return super().compose_node(parent, index)

    def construct_mapping(self, node, deep=False):
        result = {}
        for key_node, value_node in node.value:
            key = self.construct_object(key_node, deep=deep)
            if not isinstance(key, str) or key in result:
                raise ValueError("mapping keys must be unique strings")
            result[key] = self.construct_object(value_node, deep=deep)
        return result


def parse_okf(text: str) -> tuple[dict, str]:
    """Read the bounded YAML profile; unknown metadata is retained and inert."""
    if len(text.encode()) > MAX_NOTE:
        raise ValueError("note too large")
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].strip() != "---":
        raise ValueError("missing OKF frontmatter")
    end = next((i for i, line in enumerate(lines[1:], 1) if line.strip() == "---"), None)
    if end is None:
        raise ValueError("missing frontmatter terminator")
    try:
        metadata = yaml.load("".join(lines[1:end]), Loader=_Loader)
    except (yaml.YAMLError, RecursionError) as exc:
        raise ValueError("invalid YAML") from exc
    if not isinstance(metadata, dict) or not isinstance(metadata.get("type"), str) or not metadata["type"].strip():
        raise ValueError("OKF requires a nonempty string type")
    return metadata, "".join(lines[end + 1:])


def dump_okf(metadata: dict, body: str) -> str:
    text = "---\n" + yaml.safe_dump(metadata, allow_unicode=True, sort_keys=False) + "---\n" + body
    parse_okf(text)
    return text


def _name(value: object) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,79}", value):
        raise ValueError("invalid identity")
    return value


def _path(value: object) -> str:
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        raise ValueError("invalid path")
    p = PurePosixPath(value)
    if p.is_absolute() or ".." in p.parts or value != p.as_posix() or value == ".":
        raise ValueError("path must be canonical and project-relative")
    return value


def _pinned(entry: dict) -> None:
    _path(entry["path"])
    if not isinstance(entry["sha256"], str) or not re.fullmatch("[0-9a-f]{64}", entry["sha256"]):
        raise ValueError("invalid SHA-256")


def _text_extractor(_path: Path, raw: bytes) -> dict[str, str]:
    try:
        return {"text": raw.decode("utf-8"), "extraction": "utf-8-text"}
    except UnicodeError as exc:
        raise _ExtractionError("invalid-utf8") from exc


def _pdf_extractor(path: Path, raw: bytes) -> dict[str, str]:
    logger = logging.getLogger("pypdf")
    disabled = logger.disabled
    logger.disabled = True
    try:
        from pypdf import PdfReader

        with contextlib.redirect_stderr(io.StringIO()):
            reader = PdfReader(io.BytesIO(raw))
            text = "\n\n".join(page.extract_text() or "" for page in reader.pages)
    except Exception as exc:
        raise _ExtractionError("pdf-extraction-failed") from exc
    finally:
        logger.disabled = disabled
    return {"text": text, "extraction": "pdf-text"}


def _xml_member_text(archive: zipfile.ZipFile, member: str) -> list[str]:
    try:
        root = ET.fromstring(archive.read(member))
    except (KeyError, ET.ParseError, zipfile.BadZipFile) as exc:
        raise _ExtractionError("archive-extraction-failed") from exc
    values = []
    for element in root.iter():
        if element.text and element.text.strip():
            values.append(element.text.strip())
    return values


def _zip_text_extractor(
    members: Callable[[zipfile.ZipFile], list[str]], extraction: str,
) -> Callable[[Path, bytes], dict[str, str]]:
    def extract(path: Path, raw: bytes) -> dict[str, str]:
        try:
            with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                text = "\n".join(members(archive))
        except _ExtractionError:
            raise
        except zipfile.BadZipFile as exc:
            raise _ExtractionError("archive-extraction-failed") from exc
        return {"text": text, "extraction": extraction}
    return extract


def _docx_members(archive: zipfile.ZipFile) -> list[str]:
    return _xml_member_text(archive, "word/document.xml")


def _pptx_members(archive: zipfile.ZipFile) -> list[str]:
    values = []
    for member in sorted(name for name in archive.namelist() if re.fullmatch(r"ppt/slides/slide[0-9]+\.xml", name)):
        values.extend(_xml_member_text(archive, member))
    return values


def _xlsx_members(archive: zipfile.ZipFile) -> list[str]:
    values = []
    for member in ("xl/sharedStrings.xml",):
        if member in archive.namelist():
            values.extend(_xml_member_text(archive, member))
    for member in sorted(name for name in archive.namelist() if re.fullmatch(r"xl/worksheets/sheet[0-9]+\.xml", name)):
        values.extend(_xml_member_text(archive, member))
    return values


def _odf_members(archive: zipfile.ZipFile) -> list[str]:
    return _xml_member_text(archive, "content.xml")


@dataclass(frozen=True)
class _RegisteredExtractor:
    extract: Callable[[Path, bytes], dict[str, str]]
    identity: bytes

    def __call__(self, path: Path, raw: bytes) -> dict[str, str]:
        return self.extract(path, raw)


def _declared(extractor, identity):
    if (type(identity) is not dict or set(identity) != {"name", "revision", "settings"}
            or type(identity["settings"]) is not dict):
        raise ValueError("cache identity requires name, revision and settings")
    _name(identity["name"])
    _name(identity["revision"])
    return _RegisteredExtractor(extractor, canonical(identity))


def _signature(extractor) -> str | None:
    return _hash(extractor.identity) if isinstance(extractor, _RegisteredExtractor) else None


DEFAULT_EXTRACTORS: dict[str, Callable[[Path, bytes], dict[str, str]]] = {
    **{extension: _text_extractor for extension in TEXT_EXTENSIONS},
    ".pdf": _pdf_extractor,
    ".docx": _zip_text_extractor(_docx_members, "docx-text"),
    ".pptx": _zip_text_extractor(_pptx_members, "pptx-text"),
    ".xlsx": _zip_text_extractor(_xlsx_members, "xlsx-text"),
    ".odp": _zip_text_extractor(_odf_members, "odf-text"),
    ".ods": _zip_text_extractor(_odf_members, "odf-text"),
    ".odt": _zip_text_extractor(_odf_members, "odf-text"),
}

from knowledge_agent.structure import html_extractor
DEFAULT_EXTRACTORS.update({'.html': html_extractor, '.htm': html_extractor})

# These revisions describe output behavior, independent of unrelated Temari changes.
for _extension_key, _extract in list(DEFAULT_EXTRACTORS.items()):
    _kind = ("html-visible" if _extension_key in {'.html', '.htm'} else "utf-8" if _extension_key in TEXT_EXTENSIONS else
             "odf" if _extension_key in {".odt", ".ods", ".odp"} else _extension_key[1:])
    DEFAULT_EXTRACTORS[_extension_key] = _declared(_extract, {
        "name": _kind, "revision": "1",
        "settings": {"pypdf": package_version("pypdf")} if _kind == "pdf" else {},
    })


def _detected_extractor(path: Path, raw: bytes) -> dict[str, str]:
    """Recognize document bytes when the filename has no registered format."""
    if raw.startswith(b'%PDF-'):
        return DEFAULT_EXTRACTORS['.pdf'](path, raw)
    if raw.startswith((b'PK\x03\x04', b'PK\x05\x06', b'PK\x07\x08')):
        try:
            with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                names = set(archive.namelist())
                if 'word/document.xml' in names:
                    extension = '.docx'
                elif any(re.fullmatch(r'ppt/slides/slide[0-9]+\.xml', name) for name in names):
                    extension = '.pptx'
                elif any(re.fullmatch(r'xl/worksheets/sheet[0-9]+\.xml', name) for name in names):
                    extension = '.xlsx'
                elif ('content.xml' in names and 'mimetype' in names and
                      archive.read('mimetype').strip() in {
                          b'application/vnd.oasis.opendocument.text',
                          b'application/vnd.oasis.opendocument.presentation',
                          b'application/vnd.oasis.opendocument.spreadsheet'}):
                    extension = '.odt'
                else:
                    raise _ExtractionError('unsupported-format')
        except zipfile.BadZipFile as exc:
            raise _ExtractionError('archive-extraction-failed') from exc
        return DEFAULT_EXTRACTORS[extension](path, raw)
    encoding = ('utf-32' if raw.startswith((b'\xff\xfe\x00\x00', b'\x00\x00\xfe\xff')) else
                'utf-16' if raw.startswith((b'\xff\xfe', b'\xfe\xff')) else
                'utf-8-sig' if raw.startswith(b'\xef\xbb\xbf') else 'utf-8')
    try:
        text = raw.decode(encoding)
    except UnicodeError as exc:
        raise _ExtractionError('unsupported-format') from exc
    if any((ord(c) < 32 and c not in '\t\n\r\f') or 127 <= ord(c) <= 159 for c in text):
        raise _ExtractionError('unsupported-format')
    if re.match(r'\s*(?:<!doctype\s+html\b|<html\b)', text, re.IGNORECASE):
        return html_extractor(path, text.encode('utf-8'))
    return {'text': text, 'extraction': encoding + '-text'}


DEFAULT_EXTRACTORS[''] = _declared(_detected_extractor, {
    'name': 'detected-document', 'revision': '1',
    'settings': {'pypdf': package_version('pypdf'), 'html': 'html-visible-1'},
})


def _select_extractor(path, extractors):
    return extractors.get(path.suffix.casefold(), extractors.get(''))


def _extension(value: object) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"\.[A-Za-z0-9][A-Za-z0-9_.+-]{0,31}", value):
        raise ValueError("invalid extension")
    return value.casefold()


def _extractor_name(value: object) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,79}", value):
        raise ValueError("invalid extractor name")
    return value


def register_document_extractor(
    extension: str,
    extractor: Callable[[Path, bytes], dict[str, str]],
    *,
    extractors: dict[str, Callable[[Path, bytes], dict[str, str]]] | None = None,
    cache_identity: dict | None = None,
) -> dict[str, Callable[[Path, bytes], dict[str, str]]]:
    """Return an extractor registry extended for one caller-selected import."""
    if not callable(extractor):
        raise ValueError("extractor must be callable")
    registry = dict(DEFAULT_EXTRACTORS if extractors is None else extractors)
    registry[_extension(extension)] = extractor if cache_identity is None else _declared(extractor, cache_identity)
    return registry


def _run_extractor(path: Path, raw: bytes, extractor: Callable[[Path, bytes], dict[str, str]]) -> dict[str, str]:
    try:
        result = extractor(path, raw)
    except _ExtractionError:
        raise
    except UnicodeError as exc:
        raise _ExtractionError("invalid-utf8") from exc
    except Exception as exc:
        raise _ExtractionError("extraction-failed") from exc
    if not isinstance(result, dict) or not isinstance(result.get("text"), str):
        raise ValueError("extractor must return a text mapping")
    extraction = _extractor_name(result.get("extraction", "custom-text"))
    text = result["text"]
    if not text or not text.splitlines():
        raise _ExtractionError("empty-document")
    return {"text": text, "extraction": extraction}


def _extract_path(path: Path, raw: bytes,
                  extractors: dict[str, Callable[[Path, bytes], dict[str, str]]]) -> dict[str, str]:
    extractor = _select_extractor(path, extractors)
    if extractor is None:
        raise _ExtractionError("unsupported-extension")
    return _run_extractor(path, raw, extractor)


def _cached_extraction(path, raw, extractor, cache):
    signature = _signature(extractor)
    key = {"source_sha256": _hash(raw),
           "extractor": json.loads(extractor.identity) if signature is not None else None}
    def validate(value):
        if type(value) is not dict or set(value) != {"text", "extraction"}:
            raise ValueError("invalid extraction artifact")
        if type(value["text"]) is not str or not value["text"]:
            raise ValueError("invalid extraction text")
        _extractor_name(value["extraction"])
    result = cache.get("extraction", key, validate) if signature is not None else None
    if result is None:
        cache.stats["extraction_calls"] += 1
        if signature is None or cache.relative is None:
            cache.stats["uncached_extractions"] += 1
        result = _run_extractor(path, raw, extractor)
        if _hash_file(path) != key["source_sha256"]:
            raise _ExtractionError("source-changed")
        if signature is not None:
            cache.put("extraction", key, result)
    return result


def _cached_chunks(text, max_bytes, cache):
    key = {"text_sha256": _hash(text.encode()), "chunker": "exact-spans-1", "max_bytes": max_bytes}
    def validate(chunks):
        if type(chunks) is not list or not chunks:
            raise ValueError("invalid chunks")
        previous, line = 0, 1
        for item in chunks:
            if (type(item) is not list or len(item) != 5 or type(item[0]) is not str
                    or any(type(x) is not int for x in item[1:])):
                raise ValueError("invalid chunk shape")
            chunk, start, end, first, last = item
            skipped = text[previous:start]
            line += skipped.count("\n")
            end_line = line + chunk.count("\n") - int(chunk.endswith("\n"))
            if (not previous <= start < end <= len(text) or skipped.strip()
                    or text[start:end] != chunk or not chunk.strip()
                    or len(chunk.encode()) > max_bytes or first != line or last != end_line):
                raise ValueError("invalid chunk span")
            line += chunk.count("\n")
            previous = end
        if text[previous:].strip():
            raise ValueError("incomplete chunks")
    chunks = cache.get("chunks", key, validate)
    if chunks is None:
        cache.stats["chunk_calls"] += 1
        chunks = [list(chunk) for chunk in _chunk_text(text, max_bytes)]
        validate(chunks)
        cache.put("chunks", key, chunks)
    return chunks


def _is_hidden(relative: str) -> bool:
    return any(part.startswith(".") for part in PurePosixPath(relative).parts)


def _under(child: str, parent: str) -> bool:
    child_parts = PurePosixPath(child).parts
    parent_parts = PurePosixPath(parent).parts
    return len(child_parts) >= len(parent_parts) and child_parts[:len(parent_parts)] == parent_parts


def _document_id(relative: str) -> str:
    stem = re.sub(r"[^A-Za-z0-9_.-]+", "-", PurePosixPath(relative).stem).strip(".-").lower()
    if not stem or not re.match(r"[A-Za-z0-9]", stem):
        stem = "document"
    stem = stem[:54].rstrip(".-") or "document"
    return f"doc-{stem}-{_hash(relative.encode())[:12]}"


def _chunk_id(document_id: str, index: int, total: int) -> str:
    if total == 1:
        return document_id
    return f"{document_id}-c{index:04d}"


def _chunk_text(text: str, max_bytes: int = MAX_IMPORTED_CHUNK_TEXT) -> list[tuple[str, int, int, int, int]]:
    """Return exact text chunks with char offsets and approximate one-based line spans."""
    if not text:
        raise _ExtractionError("empty-document")
    chunks = []
    start = 0
    line = 1
    while start < len(text):
        end = start
        used = 0
        last_newline = None
        while end < len(text):
            width = len(text[end].encode("utf-8"))
            if used + width > max_bytes:
                break
            used += width
            end += 1
            if text[end - 1] == "\n":
                last_newline = end
        if end == start:
            raise _ExtractionError("chunk-too-large")
        if end < len(text) and last_newline and last_newline > start:
            end = last_newline
        chunk = text[start:end]
        if not chunk.strip():
            start = end
            line += chunk.count("\n")
            continue
        start_line = line
        newline_count = chunk.count("\n")
        end_line = line + newline_count
        if chunk.endswith("\n") and end_line > start_line:
            end_line -= 1
        chunks.append((chunk, start, end, start_line, end_line))
        start = end
        line += newline_count
    if not chunks:
        raise _ExtractionError("empty-document")
    return chunks


def _walk_documents(root: Path, folder: str):
    base = root
    for part in PurePosixPath(folder).parts:
        base = base / part
        if base.is_symlink():
            raise ValueError("folder symlinks are not admitted")
    if not base.is_dir():
        raise ValueError("folder unavailable")
    pending = [base]
    while pending:
        current = pending.pop(0)
        for child in sorted(current.iterdir(), key=lambda p: p.name):
            relative = child.relative_to(root).as_posix()
            if _is_hidden(relative):
                yield relative, None, "hidden-path"
                continue
            if child.is_symlink():
                yield relative, None, "symlink"
                continue
            if child.is_dir():
                pending.append(child)
                continue
            if child.is_file():
                yield relative, child, None


def import_folder_collection(root: Path, folder: str, output: str, *, context: Iterable[str] = DEFAULT_FOLDER_CONTEXT,
                             reason: str = "bounded local folder import", max_files: int | None = None,
                             extractors: dict[str, Callable[[Path, bytes], dict[str, str]]] | None = None,
                             cache_dir: str | None = None,
                             chunk_bytes: int = MAX_IMPORTED_CHUNK_TEXT) -> dict:
    """Generate an explicit OKF collection from a bounded local document folder."""
    root = Path(root).resolve(strict=True)
    folder = _path(folder)
    output = _path(output)
    context = list(dict.fromkeys(_name(tag) for tag in context))
    extractors = dict(DEFAULT_EXTRACTORS if extractors is None else extractors)
    for extension, extractor in extractors.items():
        if extension != '':
            _extension(extension)
        if not callable(extractor):
            raise ValueError("extractor must be callable")
    if not context:
        raise ValueError("folder import requires at least one context tag")
    if not isinstance(reason, str) or not reason.strip() or len(reason.encode()) > 512:
        raise ValueError("invalid import reason")
    if max_files is not None and (type(max_files) is not int or max_files < 1):
        raise ValueError("invalid file limit")
    if type(chunk_bytes) is not int or not 4 <= chunk_bytes <= MAX_IMPORTED_CHUNK_TEXT:
        raise ValueError("chunk bytes must be between 4 and 48000")
    if _under(output, folder) or _under(folder, output):
        raise ValueError("output must not overlap the imported folder")
    out_dir = write_path(root, output)
    if out_dir.exists():
        raise ValueError("output directory already exists")
    if cache_dir is not None:
        cache_dir = _path(cache_dir)
        if any(_under(cache_dir, p) or _under(p, cache_dir) for p in (folder, output)):
            raise ValueError("cache must not overlap source folder or output")
    cache = ArtifactCache(root, cache_dir)

    documents, gaps, seen_files, admitted_sources = [], [], 0, 0
    manifest = {"schema": 1, "sources": {}, "notes": {}, "relations": []}
    note_texts = {}
    for relative, path, error in _walk_documents(root, folder):
        if error:
            gaps.append({"id": relative, "reason": error})
            continue
        seen_files += 1
        if max_files is not None and seen_files > max_files:
            gaps.append({"id": relative, "reason": "file-limit"})
            continue
        assert path is not None
        extractor = _select_extractor(path, extractors)
        if extractor is None:
            gaps.append({"id": relative, "reason": "unsupported-extension"})
            continue
        try:
            source_hash = _hash_file(path)
            raw = path.read_bytes()
            size = len(raw)
            if _hash(raw) != source_hash:
                gaps.append({"id": relative, "reason": "source-changed"})
                continue
        except OSError:
            gaps.append({"id": relative, "reason": "source-unavailable"})
            continue
        if size == 0:
            gaps.append({"id": relative, "reason": "empty-document"})
            continue
        try:
            extracted = _cached_extraction(path, raw, extractor, cache)
            if _hash_file(path) != source_hash:
                raise _ExtractionError("source-changed")
        except _ExtractionError as exc:
            gaps.append({"id": relative, "reason": exc.reason})
            continue
        except OSError:
            gaps.append({"id": relative, "reason": "source-unavailable"})
            continue
        body = extracted["text"]
        extraction = extracted["extraction"]
        try:
            chunks = _cached_chunks(body, chunk_bytes, cache)
        except _ExtractionError as exc:
            gaps.append({"id": relative, "reason": exc.reason})
            continue
        source_id = _document_id(relative)
        manifest["sources"][source_id] = {"path": relative, "sha256": source_hash, "bytes": size}
        admitted_sources += 1
        for index, (chunk, start_char, end_char, start_line, end_line) in enumerate(chunks, 1):
            doc_id = _chunk_id(source_id, index, len(chunks))
            note_path = PurePosixPath(output) / "notes" / f"{doc_id}.md"
            metadata = {
                "type": "ImportedDocument" if len(chunks) == 1 else "ImportedDocumentChunk",
                "source_path": relative,
                "source_document_id": source_id,
                "chunk_index": index,
                "chunk_count": len(chunks),
                "import_reason": reason,
                "extraction": extraction,
            }
            note_text = dump_okf(metadata, chunk)
            if len(note_text.encode()) > MAX_NOTE:
                gaps.append({"id": doc_id, "reason": "note-too-large"})
                continue
            citation = {
                "source": source_id,
                "start": start_line,
                "end": end_line,
                "text_start": start_char,
                "text_end": end_char,
                "quote": chunk,
                "extraction": extraction,
            }
            if _signature(extractor) is not None:
                citation["extractor_signature"] = _signature(extractor)
            manifest["notes"][doc_id] = {"current": "r1", "revisions": {"r1": {
                "path": note_path.as_posix(), "sha256": _hash(note_text.encode()),
                "status": "BASELINE", "applies_to": context, "extraction": extraction,
                "source_document_id": source_id,
                "chunk_index": index,
                "chunk_count": len(chunks),
                "citations": [citation],
            }}}
            note_texts[note_path.as_posix()] = note_text
            documents.append({
                "id": doc_id,
                "source_document_id": source_id,
                "source_path": relative,
                "note_path": note_path.as_posix(),
                "sha256": source_hash,
                "bytes": size,
                "extraction": extraction,
                "chunk_index": index,
                "chunk_count": len(chunks),
                "text_start": start_char,
                "text_end": end_char,
            })

    if not documents:
        raise ValueError("no supported documents admitted")
    manifest_path = PurePosixPath(output) / "collection.json"
    manifest_text = json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    if len(manifest_text.encode()) > MAX_MANIFEST or len(manifest["notes"]) > MAX_COLLECTION_ITEMS:
        raise ValueError("generated collection exceeds manifest limits")
    out_dir.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(dir=out_dir.parent, prefix=".import-pending-"))
    try:
        (staging / "notes").mkdir()
        for relative, text in sorted(note_texts.items()):
            (staging / "notes" / PurePosixPath(relative).name).write_text(text, encoding="utf-8")
        (staging / "collection.json").write_text(manifest_text, encoding="utf-8")
        for source in manifest["sources"].values():
            source_path = write_path(root, source["path"])
            if source_path.is_symlink() or _hash_file(source_path) != source["sha256"]:
                raise ValueError("sources changed before collection publication")
        write_path(root, output)
        if out_dir.exists():
            raise ValueError("output directory already exists")
        os.rename(staging, out_dir)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    collection = Collection(root, manifest_path.as_posix())
    return {
        "schema": 1,
        "status": "complete" if not gaps else "partial",
        "manifest": manifest_path.as_posix(),
        "folder": folder,
        "output": output,
        "context": context,
        "documents": documents,
        "gaps": gaps,
        "fingerprint": collection.fingerprint(),
        "limits": {
            "max_files": max_files,
            "max_source_bytes": None,
            "max_extracted_text_bytes": MAX_NOTE,
            "max_chunk_text_bytes": chunk_bytes,
            "supported_extensions": sorted(extractors),
        },
        "claim": "chunked byte-pinned access for admitted UTF-8 text files; chunked parsed text access for PDFs and Office/ODF archives; no OCR/layout/formula/binary fidelity or general efficiency claim",
        "admitted_sources": admitted_sources,
        "reuse": cache.stats,
    }


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


class Collection:
    """Read a deliberately admitted local collection; no multiuser trust boundary."""

    def __init__(self, root: Path, manifest: str, *, candidate_paths: Iterable[str] = (),
                 extractors: dict[str, Callable[[Path, bytes], dict[str, str]]] | None = None,
                 cache_dir: str | None = None):
        self.root = Path(root).resolve(strict=True)
        self.manifest_path = _path(manifest)
        self.candidates = tuple(dict.fromkeys(_path(p) for p in candidate_paths))
        self.extractors = dict(DEFAULT_EXTRACTORS if extractors is None else extractors)
        for extension, extractor in self.extractors.items():
            if extension != '':
                _extension(extension)
            if not callable(extractor):
                raise ValueError("extractor must be callable")
        if len(self.candidates) > 100:
            raise ValueError("too many candidate files")
        raw = self._read(self.manifest_path, MAX_MANIFEST)
        self.manifest_hash = _hash(raw)
        self._source_text_cache = {}
        try:
            self.config = json.loads(raw, object_pairs_hook=_unique)
            self._validate()
        except (KeyError, TypeError, AttributeError, RecursionError) as exc:
            raise ValueError("invalid collection manifest") from exc
        if cache_dir is not None:
            cache_dir = _path(cache_dir)
            inputs = [self.manifest_path, *self.candidates]
            inputs += [s["path"] for s in self.config["sources"].values()]
            inputs += [e["path"] for n in self.config["notes"].values() for e in n["revisions"].values()]
            # Keep cache writes out of the collection directory as well as its inputs.
            parent = PurePosixPath(self.manifest_path).parent.as_posix()
            if parent != ".":
                inputs.append(parent)
            if any(_under(p, cache_dir) or _under(cache_dir, p) for p in inputs):
                raise ValueError("cache must not overlap collection inputs")
        self._cache = ArtifactCache(self.root, cache_dir)
        self.cache_stats = self._cache.stats

    def _file_path(self, relative: str) -> Path:
        path = self.root
        for part in PurePosixPath(relative).parts:
            path = path / part
            if path.is_symlink():
                raise ValueError("symlinks are not admitted")
        if not path.is_file():
            raise ValueError("file unavailable")
        return path

    def _read(self, relative: str, limit: int) -> bytes:
        path = self._file_path(relative)
        with path.open("rb") as stream:
            data = stream.read(limit + 1)
        if len(data) > limit:
            raise ValueError("file exceeds size limit")
        return data

    def _validate(self):
        c = self.config
        if type(c["schema"]) is not int or c["schema"] != 1:
            raise ValueError("unsupported collection schema")
        if not isinstance(c["sources"], dict) or not isinstance(c["notes"], dict):
            raise ValueError("sources and notes must be mappings")
        if not 1 <= len(c["notes"]) <= MAX_COLLECTION_ITEMS or len(c["sources"]) > MAX_COLLECTION_ITEMS:
            raise ValueError("invalid collection size")
        for sid, source in c["sources"].items():
            _name(sid)
            _pinned(source)
            if "bytes" in source and (type(source["bytes"]) is not int or source["bytes"] < 0):
                raise ValueError("invalid source byte count")
        total = 0
        for nid, note in c["notes"].items():
            _name(nid)
            revisions = note["revisions"]
            if not isinstance(revisions, dict) or note["current"] not in revisions:
                raise ValueError("current revision must be present")
            total += len(revisions)
            for revision, entry in revisions.items():
                _name(revision)
                _pinned(entry)
                seen = set()
                predecessor = revision
                while predecessor is not None:
                    if predecessor not in revisions or predecessor in seen:
                        raise ValueError("supersession must be retained and acyclic")
                    seen.add(predecessor)
                    predecessor = revisions[predecessor].get("supersedes")
                if entry["status"] not in STATUSES:
                    raise ValueError("unknown decision status")
                if not isinstance(entry["applies_to"], list) or len(entry["applies_to"]) > 30:
                    raise ValueError("invalid applicability")
                for tag in entry["applies_to"]:
                    _name(tag)
                if not isinstance(entry["citations"], list) or not 1 <= len(entry["citations"]) <= 20:
                    raise ValueError("invalid citations")
                for cite in entry["citations"]:
                    if cite["source"] not in c["sources"]:
                        raise ValueError("unregistered source")
                    if type(cite["start"]) is not int or type(cite["end"]) is not int or not 1 <= cite["start"] <= cite["end"]:
                        raise ValueError("invalid source span")
                    if ("text_start" in cite) != ("text_end" in cite):
                        raise ValueError("invalid extracted text span")
                    if "text_start" in cite and (
                        type(cite["text_start"]) is not int
                        or type(cite["text_end"]) is not int
                        or not 0 <= cite["text_start"] < cite["text_end"]
                    ):
                        raise ValueError("invalid extracted text span")
                    if not isinstance(cite["quote"], str) or not cite["quote"] or len(cite["quote"].encode()) > MAX_NOTE:
                        raise ValueError("invalid quotation")
                    if "extraction" in cite:
                        _extractor_name(cite["extraction"])
                    if "extractor_signature" in cite and (
                        type(cite["extractor_signature"]) is not str
                        or not re.fullmatch(r"[0-9a-f]{64}", cite["extractor_signature"])
                    ):
                        raise ValueError("invalid extractor signature")
        if total > MAX_COLLECTION_ITEMS:
            raise ValueError("too many revisions")
        if not isinstance(c["relations"], list) or len(c["relations"]) > 200:
            raise ValueError("invalid relations")
        for relation in c["relations"]:
            for key in ("from", "to", "kind"):
                _name(relation[key])

    def _digest(self, path, limit=MAX_SOURCE):
        try:
            if limit is None:
                return _hash_file(self._file_path(path))
            return _hash(self._read(path, limit))
        except (OSError, ValueError):
            return "unavailable"

    def fingerprint(self) -> str:
        paths = {self.manifest_path: MAX_MANIFEST, **{p: MAX_SOURCE for p in self.candidates}}
        for s in self.config["sources"].values():
            paths[s["path"]] = None
        for note in self.config["notes"].values():
            for entry in note["revisions"].values():
                paths[entry["path"]] = MAX_NOTE
        identity = {
            "files": {p: self._digest(p, limit) for p, limit in sorted(paths.items())},
            "loaded_manifest": self.manifest_hash,
            "loaded_engine": _LOADED_ENGINE,
            "engine_on_disk": _hash(Path(__file__).read_bytes()),
            "loaded_cache_engine": _LOADED_CACHE_ENGINE,
            "cache_engine_on_disk": _hash(Path(knowledge_cache.__file__).read_bytes()),
            "extractors": {extension: _signature(self.extractors.get(extension, self.extractors.get('')))
                           for extension in sorted({PurePosixPath(s["path"]).suffix.casefold()
                                                    for s in self.config["sources"].values()})},
            "yaml": yaml.__version__,
        }
        return _hash(json.dumps(identity, sort_keys=True).encode())

    def is_current(self, packet: dict) -> bool:
        """Input identity only. This does not authenticate a check or its author."""
        return packet.get("fingerprint") == self.fingerprint()

    def _record(self, nid: str, context: set[str], revision: str | None = None):
        note = self.config["notes"].get(nid)
        if note is None:
            return None, "unknown-note"
        revision = note["current"] if revision is None else revision
        if revision not in note["revisions"]:
            return None, "unknown-revision"
        entry = note["revisions"][revision]
        if not set(entry["applies_to"]) <= context:
            return None, "inapplicable"
        try:
            raw = self._read(entry["path"], MAX_NOTE)
        except (OSError, ValueError):
            return None, "note-unavailable"
        if _hash(raw) != entry["sha256"]:
            return None, "note-changed"
        try:
            metadata, body = parse_okf(raw.decode("utf-8"))
        except (UnicodeError, ValueError):
            return None, "invalid-okf"
        citations = []
        for cite in entry["citations"]:
            source = self.config["sources"][cite["source"]]
            try:
                source_path = self._file_path(source["path"])
            except (OSError, ValueError):
                return None, "source-unavailable"
            try:
                if _hash_file(source_path) != source["sha256"]:
                    return None, "source-changed"
            except OSError:
                return None, "source-unavailable"
            extractor = _select_extractor(source_path, self.extractors)
            signature = _signature(extractor)
            if "extractor_signature" in cite and signature != cite["extractor_signature"]:
                return None, "extractor-mismatch"
            cache_key = (source["path"], source["sha256"], cite.get("extraction", "raw-utf-8"), signature)
            if cache_key in self._source_text_cache:
                text = self._source_text_cache[cache_key]
            else:
                try:
                    source_raw = source_path.read_bytes()
                except OSError:
                    return None, "source-unavailable"
                if _hash(source_raw) != source["sha256"]:
                    return None, "source-changed"
                if "extraction" in cite:
                    try:
                        if extractor is None:
                            return None, "unsupported-extension"
                        extracted = _cached_extraction(source_path, source_raw, extractor, self._cache)
                    except _ExtractionError as exc:
                        return None, exc.reason
                    except ValueError:
                        return None, "invalid-extractor"
                    except OSError:
                        return None, "source-unavailable"
                    if extracted["extraction"] != cite["extraction"]:
                        return None, "extractor-mismatch"
                    text = extracted["text"]
                else:
                    try:
                        text = source_raw.decode("utf-8")
                    except UnicodeError:
                        return None, "source-unavailable"
                self._source_text_cache[cache_key] = text
            if "text_start" in cite:
                if cite["text_end"] > len(text) or text[cite["text_start"]:cite["text_end"]] != cite["quote"]:
                    return None, "span-mismatch"
            else:
                lines = text.splitlines()
                if cite["end"] > len(lines) or "\n".join(lines[cite["start"] - 1:cite["end"]]) != cite["quote"]:
                    return None, "span-mismatch"
            citations.append({**cite, "path": source["path"], "sha256": source["sha256"]})
        record = {
            "id": nid, "revision": revision, "path": entry["path"], "sha256": entry["sha256"],
            "temporal": "current" if revision == note["current"] else "historical",
            "current_revision": note["current"], "supersedes": entry.get("supersedes"),
            "status": entry["status"], "applies_to": entry["applies_to"], "body": body,
            "extraction": entry.get("extraction", "curated-okf"),
            "support": "source-bytes-and-spans-verified",
            "interpretation": "curator-synthesis-not-independently-verified", "citations": citations,
        }
        for key in ("source_path", "source_document_id", "chunk_index", "chunk_count"):
            if key in metadata:
                record[key] = metadata[key]
        return record, None

    def packet(self, ids: Iterable[str], *, context: Iterable[str], max_bytes=16_000,
               revisions: dict[str, str] | None = None) -> dict:
        ids = list(dict.fromkeys(_name(n) for n in ids))
        context = {_name(t) for t in context}
        revisions = {} if revisions is None else revisions
        if not isinstance(revisions, dict) or not set(revisions) <= set(ids):
            raise ValueError("revision selection must name a requested note")
        for revision in revisions.values():
            _name(revision)
        if not 1 <= len(ids) <= 100:
            raise ValueError("invalid request size")
        start = self._start(max_bytes)
        result = {"schema": 1, "status": "partial", "fingerprint": start, "records": [], "gaps": []}
        for nid in ids:
            record, error = self._record(nid, context, revisions.get(nid))
            if error:
                gap = {"id": nid, "reason": error}
                if nid in revisions:
                    gap["revision"] = revisions[nid]
                result["gaps"].append(gap)
            else:
                result["records"].append(record)
        return self._finish(result, max_bytes)

    def _start(self, max_bytes):
        if type(max_bytes) is not int or not 1024 <= max_bytes <= MAX_SOURCE:
            raise ValueError("invalid budget")
        if self._digest(self.manifest_path, MAX_MANIFEST) != self.manifest_hash:
            raise ValueError("collection manifest changed; reload before lookup")
        return self.fingerprint()

    def _finish(self, result, max_bytes):
        for path in self.candidates:
            if self._digest(path) == "unavailable":
                result["gaps"].append({"id": "candidate", "reason": "candidate-unavailable"})
        while len(json.dumps(result, ensure_ascii=False).encode()) > max_bytes and result["records"]:
            record = result["records"].pop()
            result["gaps"].append({"id": record["id"], "reason": "budget-omitted"})
        if not result["gaps"]:
            result["status"] = "complete"
        if len(json.dumps(result, ensure_ascii=False).encode()) > max_bytes:
            raise ValueError("budget cannot hold the gap report")
        if self.fingerprint() != result["fingerprint"]:
            raise ValueError("inputs changed during lookup; retry with stable inputs")
        return result

    def search(self, query: str, *, context: Iterable[str], limit=5, max_bytes=16_000,
               expand_requires=False) -> dict:
        """Explainable lexical selection of current, supported notes; not semantic search."""
        if not isinstance(query, str) or not 1 <= len(query.encode()) <= 512:
            raise ValueError("query must be 1–512 UTF-8 bytes")
        terms = set(re.findall(r"[^\W_]+", query.casefold()))
        if not terms or type(limit) is not int or not 1 <= limit <= 20:
            raise ValueError("query needs word tokens and limit must be 1–20")
        if type(expand_requires) is not bool:
            raise ValueError("expand_requires must be a boolean")
        context = {_name(t) for t in context}
        result = {"schema": 1, "status": "partial", "fingerprint": self._start(max_bytes),
                  "request": {"query": query, "terms": sorted(terms),
                              "context": sorted(context), "limit": limit,
                              "expand_requires": expand_requires},
                  "records": [], "gaps": []}
        hits, checked = [], {}
        for nid in sorted(self.config["notes"]):
            record, error = self._record(nid, context)
            checked[nid] = (record, error)
            if error:
                result["gaps"].append({"id": nid, "reason": error})
                continue
            words = set(re.findall(r"[^\W_]+", (nid + " " + record["body"]).casefold()))
            matched = sorted(terms & words)
            if matched:
                record["retrieval"] = {"kind": "lexical", "score": len(matched), "matched_terms": matched}
                hits.append(record)
        hits.sort(key=lambda r: (-r["retrieval"]["score"], r["id"]))
        result["records"] = hits[:limit]
        result["selection"] = {"matched": len(hits), "unselected": [r["id"] for r in hits[limit:]]}
        if not hits:
            result["gaps"].append({"id": "search", "reason": "no-match"})
        if expand_requires:
            self._expand_requires(result, checked)
        return self._finish(result, max_bytes)

    def _expand_requires(self, result, checked):
        seeds = {r["id"] for r in result["records"]}
        added = {}
        for index, relation in enumerate(self.config["relations"]):
            if relation["from"] not in seeds or relation["kind"] != "requires":
                continue
            nid, location = relation["to"], f"relations[{index}]"
            record, error = checked.get(nid, (None, "unknown-note"))
            if error:
                result["gaps"].append({"id": nid, "reason": error, "relation": location})
                continue
            record.setdefault("dependency_via", []).append({
                **relation, "path": self.manifest_path, "location": location, "provenance": "curated"})
            if nid not in seeds:
                record["retrieval"] = {"kind": "dependency"}
                added[nid] = record
        result["records"].extend(added[nid] for nid in sorted(added))
        result["selection"]["unselected"] = [nid for nid in result["selection"]["unselected"] if nid not in added]

    def graph(self, *, context: Iterable[str], max_bytes=MAX_SOURCE) -> dict:
        context = {_name(t) for t in context}
        if type(max_bytes) is not int or not 1024 <= max_bytes <= MAX_SOURCE:
            raise ValueError("invalid budget")
        fingerprint = self._start(MAX_SOURCE)
        nodes, edges = {}, []
        gaps = []
        def node(nid, label, path, location, **extra):
            nodes[nid] = {"id": nid, "label": f"{label} [{nid}]", "source_file": path, "source_location": location, **extra}
        def relation(rid, source, target, kind, path, location):
            node(rid, kind, path, location, relation=kind, provenance="curated")
            for a, b in ((source, rid), (rid, target)):
                edges.append({"source": a, "target": b, "relation": kind,
                              "confidence": "INFERRED", "source_file": path, "source_location": location})
        for nid in sorted(self.config["notes"]):
            record, error = self._record(nid, context)
            if error:
                gaps.append({"id": nid, "reason": error})
                continue
            nid = "note:" + record["id"]
            node(nid, record["id"], record["path"], "whole note", revision=record["revision"], status=record["status"])
            for i, cite in enumerate(record["citations"]):
                sid = "source:" + cite["source"]
                location = f"L{cite['start']}-L{cite['end']}"
                node(sid, cite["source"], cite["path"], "whole source", sha256=cite["sha256"])
                relation(f"support:{record['id']}:{i}", sid, nid, "supports", cite["path"], location)
        for i, rel in enumerate(self.config["relations"]):
            source, target = "note:" + rel["from"], "note:" + rel["to"]
            if source not in nodes or target not in nodes:
                gaps.append({"id": f"relation:{i}", "reason": "unavailable-endpoint"})
                continue
            relation(f"relation:{i}", source, target, rel["kind"], self.manifest_path, f"relations[{i}]")
        for path in self.candidates:
            if self._digest(path) == "unavailable":
                gaps.append({"id": "candidate", "reason": "candidate-unavailable"})
        if self.fingerprint() != fingerprint:
            raise ValueError("inputs changed during graph projection; retry with stable inputs")
        return {
            "schema": 1, "status": "complete" if not gaps else "partial",
            "nodes": list(nodes.values()), "edges": edges, "gaps": gaps,
            "fingerprint": fingerprint,
            "request": {"context": sorted(context), "max_bytes": max_bytes, "projection": "metadata-first"},
        }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--manifest")
    parser.add_argument("--folder", help="project-relative folder for import-folder")
    parser.add_argument("--output", help="new project-relative output directory for import-folder")
    parser.add_argument("--import-reason", default="bounded local folder import")
    parser.add_argument("--max-files", type=int)
    parser.add_argument("--cache-dir", help="project-relative disposable extraction/chunk cache")
    parser.add_argument("--chunk-bytes", type=int, default=None, help="import chunk bytes (4–48000)")
    parser.add_argument("--candidate", action="append", default=[])
    parser.add_argument("--context", action="append", default=[])
    parser.add_argument("--max-bytes", type=int)
    parser.add_argument("--revision", action="append", default=[], metavar="NOTE=REVISION")
    parser.add_argument("--limit", type=int, default=5, help="maximum search seeds (1–20)")
    parser.add_argument("--expand-requires", action="store_true", help="include one hop of declared search dependencies")
    parser.add_argument("command", choices=["packet", "graph", "search", "import-folder"])
    parser.add_argument("notes", nargs="*")
    args = parser.parse_args()
    try:
        lookup_budget = 16_000 if args.max_bytes is None else args.max_bytes
        revisions = {}
        for selection in args.revision:
            nid, separator, revision = selection.partition("=")
            if not separator or nid in revisions:
                raise ValueError("revision selections must be unique NOTE=REVISION pairs")
            revisions[_name(nid)] = _name(revision)
        if args.command == "import-folder":
            if (args.manifest or args.candidate or args.notes or revisions or args.expand_requires
                    or args.limit != 5 or args.max_bytes is not None):
                raise ValueError("manifest, candidates, notes, revisions, limit and expansion are not folder import arguments")
            if not args.folder or not args.output:
                raise ValueError("import-folder requires --folder and --output")
            result = import_folder_collection(
                args.root,
                args.folder,
                args.output,
                context=args.context or DEFAULT_FOLDER_CONTEXT,
                reason=args.import_reason,
                max_files=args.max_files,
                cache_dir=args.cache_dir,
                chunk_bytes=MAX_IMPORTED_CHUNK_TEXT if args.chunk_bytes is None else args.chunk_bytes,
            )
            print(json.dumps(result, ensure_ascii=False))
            return 0 if not result["gaps"] else 2
        if not args.manifest:
            raise ValueError("manifest is required")
        if (args.folder or args.output or args.import_reason != "bounded local folder import"
                or args.max_files is not None or args.chunk_bytes is not None):
            raise ValueError("folder import arguments are import-folder only")
        if args.command != "packet" and revisions:
            raise ValueError("search and graph projection are current-only")
        if args.command != "search" and (args.expand_requires or args.limit != 5):
            raise ValueError("limit and dependency expansion are search-only")
        collection = Collection(args.root, args.manifest, candidate_paths=args.candidate, cache_dir=args.cache_dir)
        if args.command == "graph":
            graph_budget = MAX_SOURCE if args.max_bytes is None else args.max_bytes
            result = collection.graph(context=args.context, max_bytes=graph_budget)
        elif args.command == "search":
            result = collection.search(" ".join(args.notes), context=args.context,
                                       limit=args.limit, max_bytes=lookup_budget,
                                       expand_requires=args.expand_requires)
        else:
            result = collection.packet(args.notes, context=args.context, max_bytes=lookup_budget, revisions=revisions)
        print(json.dumps(result, ensure_ascii=False))
        return 0 if not result["gaps"] else 2
    except (OSError, ValueError) as exc:
        print(json.dumps({"status": "invalid", "error": str(exc)}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
