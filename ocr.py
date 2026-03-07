"""OCR utilities using EasyOCR with a graceful fallback to Tesseract."""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Tuple

import cv2
import numpy as np

logger = logging.getLogger(__name__)

_easyocr_reader = None
_easyocr_ready = False

try:
    import easyocr
except Exception:  # pragma: no cover - optional dependency
    easyocr = None

try:
    import pytesseract
except Exception:  # pragma: no cover - optional dependency
    pytesseract = None


def _ensure_easyocr_reader() -> Any:
    """Create a singleton EasyOCR reader when available."""
    global _easyocr_reader, _easyocr_ready

    if _easyocr_reader is not None:
        return _easyocr_reader
    if easyocr is None:
        return None

    try:
        _easyocr_reader = easyocr.Reader(["en"], gpu=False)
        _easyocr_ready = True
        return _easyocr_reader
    except Exception:
        logger.exception("Failed to initialize EasyOCR reader.")
        _easyocr_reader = False  # prevents repeated attempts on cold-start failures
        return None


def ocr_is_available() -> bool:
    """Return True if an OCR engine can be used."""
    reader = _ensure_easyocr_reader()
    if reader is not None and reader is not False:
        return True
    return pytesseract is not None


def _easyocr_result_to_blocks(results: List[Any]) -> Tuple[str, List[Dict[str, Any]]]:
    """Convert EasyOCR output into plain text and structured text blocks."""
    blocks: List[Dict[str, Any]] = []
    lines = []

    for result in results or []:
        # EasyOCR result format: [bbox, text, confidence]
        if len(result) < 3:
            continue
        bbox, text, confidence = result
        if not isinstance(text, str):
            continue
        text_clean = text.strip()
        if not text_clean or confidence < 0.35:
            continue

        lines.append(text_clean)
        blocks.append(
            {
                "text": text_clean,
                "confidence": round(float(confidence), 2),
                "bbox": {
                    "x1": int(min(pt[0] for pt in bbox)),
                    "y1": int(min(pt[1] for pt in bbox)),
                    "x2": int(max(pt[0] for pt in bbox)),
                    "y2": int(max(pt[1] for pt in bbox)),
                },
            }
        )

    return "\n".join(lines), blocks


def _tesseract_result(image_bgr: np.ndarray) -> Tuple[str, List[Dict[str, Any]]]:
    """Fallback OCR using pytesseract when EasyOCR is unavailable."""
    if pytesseract is None:
        return "", []

    try:
        text = pytesseract.image_to_string(image_bgr, config="--psm 6")
        normalized = text.strip()
        return normalized, [{"text": normalized, "confidence": 1.0, "bbox": {}}] if normalized else []
    except Exception:
        logger.exception("pytesseract OCR failed.")
        return "", []


def recognize_text(image_bgr: np.ndarray) -> Dict[str, Any]:
    """
    Read text from image.

    Returns:
        {
            "text": str,
            "blocks": List[{"text", "confidence", "bbox"}]
        }
    """
    if image_bgr is None or image_bgr.size == 0:
        return {"text": "", "blocks": []}

    reader = _ensure_easyocr_reader()
    if reader is not False and reader is not None:
        try:
            # Keep grayscale input for easier character segmentation.
            gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
            results = reader.readtext(gray, detail=1)
            text, blocks = _easyocr_result_to_blocks(results)
            return {"text": text, "blocks": blocks}
        except Exception:
            logger.exception("EasyOCR processing failed; using fallback if available.")

    text, blocks = _tesseract_result(image_bgr)
    return {"text": text, "blocks": blocks}
