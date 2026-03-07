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
        if not text_clean or confidence < 0.10:
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


def _preprocess_for_easyocr(image_bgr: np.ndarray) -> np.ndarray:
    """Improve contrast/scale for small or blurry text before EasyOCR."""
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape[:2]
    scale = 1.0
    if max(h, w) < 1200:
        scale = min(2.0, 1400 / max(h, w))
    if scale != 1.0:
        gray = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)

    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    gray = clahe.apply(gray)
    gray = cv2.fastNlMeansDenoising(gray, None, h=10, templateWindowSize=7, searchWindowSize=21)
    return gray


def _rescale_for_ocr(gray: np.ndarray, target_short_side: int = 900) -> np.ndarray:
    """Scale grayscale images up when too small for small text."""
    h, w = gray.shape[:2]
    if max(h, w) == 0:
        return gray
    scale = max(target_short_side / min(h, w), 1.0) if min(h, w) else 1.0
    scale = min(scale, 3.0)
    if scale <= 1.0:
        return gray
    return cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)


def _make_sharpened(gray: np.ndarray) -> np.ndarray:
    """Sharpen grayscale image to improve thin character edges."""
    kernel = np.array([[0, -1, 0], [-1, 5, -1], [0, -1, 0]], dtype=np.float32)
    return cv2.filter2D(gray, -1, kernel)


def _easyocr_candidates(image_bgr: np.ndarray) -> List[np.ndarray]:
    """Generate multiple grayscale variants for EasyOCR retries."""
    base = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    if base.dtype != np.uint8:
        base = np.clip(base, 0, 255).astype(np.uint8)

    variants: List[np.ndarray] = []
    base = _rescale_for_ocr(base, target_short_side=900)
    variants.append(base)
    denoised = _preprocess_for_easyocr(image_bgr)
    if denoised is not None:
        variants.append(_rescale_for_ocr(denoised, target_short_side=900))
    variants.append(_make_sharpened(base))
    variants.append(cv2.equalizeHist(base))
    variants.append(_rescale_for_ocr(cv2.bitwise_not(base), target_short_side=900))
    variants.append(_rescale_for_ocr(cv2.morphologyEx(base, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)), target_short_side=900))
    return variants


def _preprocess_for_tesseract(image_bgr: np.ndarray) -> np.ndarray:
    """Apply basic preprocessing to improve Tesseract OCR accuracy."""
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    # Upscale a bit to help OCR read small text.
    gray = cv2.resize(gray, None, fx=2.0, fy=2.0, interpolation=cv2.INTER_CUBIC)
    # Reduce noise while keeping edges sharp
    gray = cv2.bilateralFilter(gray, 11, 17, 17)
    _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    # Generate alternate preprocessed versions for different lighting/contrast setups.
    if gray.dtype != np.uint8:
        gray = np.clip(gray, 0, 255).astype(np.uint8)

    return thresh


def _tesseract_candidates(image_bgr: np.ndarray) -> List[np.ndarray]:
    """Create multiple preprocess variants for a more robust Tesseract attempt."""
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    if max(gray.shape[:2]) < 1600:
        gray = cv2.resize(gray, None, fx=2.0, fy=2.0, interpolation=cv2.INTER_CUBIC)

    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    eq = cv2.equalizeHist(gray)
    adaptive = cv2.adaptiveThreshold(
        blur,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY,
        31,
        15,
    )
    inv = cv2.bitwise_not(gray)
    opened = cv2.morphologyEx(gray, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    return [
        _preprocess_for_tesseract(image_bgr),
        _rescale_for_ocr(gray, target_short_side=900),
        cv2.threshold(eq, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1],
        adaptive,
        inv,
        opened,
        cv2.threshold(opened, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1],
    ]


def _tesseract_result(images: List[np.ndarray]) -> Tuple[str, List[Dict[str, Any]]]:
    """Fallback OCR using pytesseract when EasyOCR is unavailable."""
    if pytesseract is None:
        return "", []

    configs = [
        "--oem 3 --psm 6",
        "--oem 3 --psm 11",
        "--oem 1 --psm 6",
        "--oem 1 --psm 11",
    ]
    best_text = ""
    for img in images:
        for config in configs:
            try:
                text = pytesseract.image_to_string(img, config=config).strip()
                if len(text.strip()) > len(best_text.strip()):
                    best_text = text.strip()
            except Exception:
                continue
    if not best_text:
        return "", []
    return best_text, [{"text": best_text, "confidence": 1.0, "bbox": {}}]


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
            best_text = ""
            best_blocks: List[Dict[str, Any]] = []

            for frame in _easyocr_candidates(image_bgr):
                for paragraph_mode in (True, False):
                    results = reader.readtext(frame, detail=1, paragraph=paragraph_mode)
                    text, blocks = _easyocr_result_to_blocks(results)
                    if len(text.strip()) > len(best_text.strip()):
                        best_text = text.strip()
                        best_blocks = blocks
                    if best_text and "\n" in best_text:
                        return {"text": best_text, "blocks": best_blocks}

            if best_text:
                return {"text": best_text, "blocks": best_blocks}

            # If easyOCR did not detect lines, keep trying one more time with strong contrast.
            try:
                resized = _rescale_for_ocr(image_bgr, target_short_side=1200)
                extra = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY)
                if len(extra.shape) != 2:
                    extra = cv2.cvtColor(extra, cv2.COLOR_BGR2GRAY)
                extra = cv2.equalizeHist(extra)
            except Exception:
                extra = None
            if extra is not None:
                results = reader.readtext(extra, detail=1, paragraph=False)
                text, blocks = _easyocr_result_to_blocks(results)
                if text.strip() or blocks:
                    return {"text": text, "blocks": blocks}
        except Exception:
            logger.exception("EasyOCR processing failed; using fallback if available.")

    text, blocks = _tesseract_result(_tesseract_candidates(image_bgr))
    return {"text": text, "blocks": blocks}
