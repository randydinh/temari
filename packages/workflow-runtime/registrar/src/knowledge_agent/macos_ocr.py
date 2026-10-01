"""Optional, on-device macOS Vision text extraction from bounded PNG originals."""
from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
import platform

from knowledge_agent.knowledge import _ExtractionError


PNG_SIGNATURE = b'\x89PNG\r\n\x1a\n'
MAX_PIXELS = 12_000_000
MAX_SIDE = 4096


def validate_png_for_ocr(raw: bytes) -> tuple[int, int]:
    if (not isinstance(raw, bytes) or len(raw) < 24 or not raw.startswith(PNG_SIGNATURE)
            or raw[8:12] != b'\0\0\0\r' or raw[12:16] != b'IHDR'):
        raise _ExtractionError('image-format-unsupported')
    width = int.from_bytes(raw[16:20], 'big')
    height = int.from_bytes(raw[20:24], 'big')
    if (not 1 <= width <= MAX_SIDE or not 1 <= height <= MAX_SIDE
            or width * height > MAX_PIXELS):
        raise _ExtractionError('image-dimensions-limit')
    return width, height


def settings() -> dict[str, object]:
    try:
        bridge = version('pyobjc-framework-Vision')
    except PackageNotFoundError:
        bridge = 'unavailable'
    return dict(platform='macos', macos=platform.mac_ver()[0], pyobjc_vision=bridge,
                recognition_level='accurate', language_correction=False,
                max_pixels=MAX_PIXELS, max_side=MAX_SIDE)


def extract_png(_path: Path, raw: bytes) -> dict[str, str]:
    validate_png_for_ocr(raw)
    if platform.system() != 'Darwin':
        raise _ExtractionError('macos-vision-unavailable')
    try:
        import Vision
        from Foundation import NSData

        data = NSData.dataWithBytes_length_(raw, len(raw))
        request = Vision.VNRecognizeTextRequest.alloc().init()
        request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
        request.setUsesLanguageCorrection_(False)
        handler = Vision.VNImageRequestHandler.alloc().initWithData_options_(data, {})
        success, _error = handler.performRequests_error_([request], None)
        if not success:
            raise _ExtractionError('macos-vision-unavailable')
        observations = request.results() or []
        if len(observations) > 2000:
            raise _ExtractionError('image-text-limit')
        ordered = sorted(observations, key=lambda item: (
            -round(item.boundingBox().origin.y, 4), round(item.boundingBox().origin.x, 4)))
        lines = [candidate.string() for item in ordered
                 if (candidates := item.topCandidates_(1)) for candidate in candidates[:1]]
        text = '\n'.join(lines).strip()
        if not text:
            raise _ExtractionError('image-no-text')
        return dict(text=text, extraction='macos-vision-ocr-1')
    except _ExtractionError:
        raise
    except Exception as exc:
        raise _ExtractionError('macos-vision-unavailable') from exc
