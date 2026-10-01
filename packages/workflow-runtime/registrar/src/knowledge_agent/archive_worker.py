"""Isolated bounded adapter over the existing document extractor registry."""
from __future__ import annotations

import io
import json
from pathlib import Path
import sys
import zipfile
from xml.parsers import expat


def _validate_office(raw):
    from knowledge_agent.knowledge import _ExtractionError

    def reject_declaration(*_args):
        raise _ExtractionError('office-dtd-unsupported')

    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        members = archive.infolist()
        limit = 32 * 1024 * 1024
        if len(members) > 1000 or sum(m.file_size for m in members) > limit:
            raise _ExtractionError('office-expansion-limit')
        expanded = 0
        for member in members:
            xml = member.filename.endswith(('.xml', '.rels'))
            if not xml and member.filename != 'mimetype':
                continue
            # Expat interprets the XML encoding and carries partial tokens across
            # reads without building a tree. Refuse DTDs before any expansion or
            # external resolution, rather than searching raw encoded bytes.
            parser = expat.ParserCreate() if xml else None
            if parser is not None:
                parser.StartDoctypeDeclHandler = reject_declaration
                parser.EntityDeclHandler = reject_declaration
                parser.ExternalEntityRefHandler = reject_declaration
            try:
                with archive.open(member) as stream:
                    while block := stream.read(65536):
                        expanded += len(block)
                        if expanded > limit:
                            raise _ExtractionError('office-expansion-limit')
                        if parser is not None:
                            parser.Parse(block, False)
                if parser is not None:
                    parser.Parse(b'', True)
            except _ExtractionError:
                raise
            except (expat.ExpatError, UnicodeError, LookupError, ValueError) as exc:
                raise _ExtractionError('office-xml-unsupported') from exc


def main():
    original, output, relative, text_limit, *mode = sys.argv[1:]
    text_limit = int(text_limit)
    ocr_mode = mode[0] if mode else 'none'
    if ocr_mode not in ('none', 'macos-vision'):
        return 3
    # Fail closed if the platform cannot establish these hard process limits.
    try:
        import resource
        memory_bounded = True
        try:
            resource.setrlimit(resource.RLIMIT_AS, (512*1024*1024, 512*1024*1024))
        except (OSError, ValueError):
            memory_bounded = False
        resource.setrlimit(resource.RLIMIT_CPU, (5, 5))
        resource.setrlimit(resource.RLIMIT_FSIZE, (text_limit*6+65536, text_limit*6+65536))
    except (ImportError, OSError, ValueError):
        return 3
    from knowledge_agent.knowledge import DEFAULT_EXTRACTORS, _select_extractor, _run_extractor, _signature, _ExtractionError, register_document_extractor
    raw = Path(original).read_bytes()
    result = dict(status='unsupported', reason='unsupported-format', gaps=['visual-evidence-unavailable', 'asset-inventory-unknown'])
    try:
        if (raw.startswith(b'%PDF-') or Path(relative).suffix.lower() == '.pdf') and not memory_bounded:
            raise _ExtractionError('pdf-memory-boundary-unavailable')
        # ZipFile accepts leading bytes. Check its accepted containers, not just
        # offset-zero signatures, before either selected or detected extraction.
        if raw.startswith(b'PK') or zipfile.is_zipfile(io.BytesIO(raw)):
            _validate_office(raw)
        extractors = DEFAULT_EXTRACTORS
        if ocr_mode == 'macos-vision' and Path(relative).suffix.lower() == '.png':
            from knowledge_agent.macos_ocr import extract_png, settings
            extractors = register_document_extractor('.png', extract_png,
                cache_identity=dict(name='macos-vision-ocr', revision='1', settings=settings()))
        extractor = _select_extractor(Path(relative), extractors)
        extracted = _run_extractor(Path(relative), raw, extractor)
        if len(extracted['text'].encode()) > text_limit:
            raise _ExtractionError('extraction-output-limit')
        gaps = []
        if (extracted['extraction'] in {'pdf-text', 'docx-text', 'pptx-text', 'xlsx-text', 'odf-text', 'html-visible-1'}
                or Path(relative).suffix.lower() in ('.md', '.markdown')):
            gaps = ['visual-evidence-unavailable', 'asset-inventory-partial']
        elif extracted['extraction'] == 'macos-vision-ocr-1':
            gaps = ['visual-evidence-unavailable', 'ocr-transcription-unreviewed']
        result = dict(status='captured', **extracted, extractor_signature=_signature(extractor),
                      settings=json.loads(extractor.identity), gaps=gaps)
    except _ExtractionError as exc:
        result.update(status='limited' if 'limit' in exc.reason or 'boundary' in exc.reason else 'unsupported', reason=exc.reason)
        result['gaps'].append(exc.reason)
    except (ValueError, OSError, zipfile.BadZipFile):
        result.update(status='unavailable', reason='extraction-failed')
    Path(output).write_text(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
