"""Object detection helpers powered by YOLOv8."""

from __future__ import annotations

import logging
import os
from pathlib import Path
from threading import Lock
from typing import Any, Dict, List, Optional

import cv2
import numpy as np

logger = logging.getLogger(__name__)

try:
    from ultralytics import YOLO
except Exception:  # pragma: no cover - optional dependency
    YOLO = None

_MODEL = None
_MODEL_LOCK = Lock()


def get_model_path() -> str:
    """Resolve the YOLO model file path."""
    explicit_path = (os.environ.get("YOLO_MODEL_PATH", "").strip())
    if explicit_path:
        candidate = Path(explicit_path).expanduser().resolve()
        if candidate.is_file():
            return str(candidate)

    local_model = (Path(__file__).resolve().parents[1] / "models" / "yolov8.pt").resolve()
    if local_model.is_file():
        return str(local_model)

    # If custom files are unavailable, fall back to the official lightweight
    # model name. Ultralytics will download this automatically when possible.
    return "yolov8n.pt"


def _load_model() -> Optional["YOLO"]:
    """Load YOLO once with thread-safe caching."""
    global _MODEL

    if YOLO is None:
        logger.warning("Ultralytics package is not installed. Object detection disabled.")
        return None

    if _MODEL is not None:
        return _MODEL

    with _MODEL_LOCK:
        if _MODEL is not None:
            return _MODEL

        model_path = get_model_path()
        try:
            _MODEL = YOLO(model_path)
            logger.info("YOLO model loaded from %s", model_path)
        except Exception:
            logger.exception("Failed to load model from %s. Attempting fallback model.", model_path)
            try:
                _MODEL = YOLO("yolov8n.pt")
                logger.info("Loaded fallback YOLO model yolov8n.pt")
            except Exception:
                logger.exception("Fallback YOLO model load failed.")
                _MODEL = None

        return _MODEL


def model_is_available() -> bool:
    """Return True when model backend can be used."""
    return _load_model() is not None


def _normalize_box(box_xyxy: np.ndarray) -> Dict[str, int]:
    """Convert a YOLO box into integer coordinates."""
    x1, y1, x2, y2 = [int(v) for v in box_xyxy]
    return {
        "x1": max(0, x1),
        "y1": max(0, y1),
        "x2": max(x1, x2),
        "y2": max(y1, y2),
    }


def detect_objects(
    frame_bgr: np.ndarray,
    confidence_threshold: float = 0.35,
    max_objects: int = 30,
) -> List[Dict[str, Any]]:
    """
    Detect objects in an OpenCV BGR frame.

    Returns a list of normalized detections:
    - label
    - confidence
    - bbox (x1, y1, x2, y2)
    """
    if frame_bgr is None or frame_bgr.size == 0:
        return []

    model = _load_model()
    if model is None:
        return []

    try:
        results = model.predict(source=frame_bgr, conf=confidence_threshold, verbose=False)
        if not results:
            return []

        raw = results[0]
        boxes = raw.boxes
        if boxes is None or len(boxes) == 0:
            return []

        names = model.names or {}
        detections: List[Dict[str, Any]] = []
        for idx in range(len(boxes.cls)):
            confidence = float(boxes.conf[idx])
            class_id = int(boxes.cls[idx])
            if isinstance(names, dict):
                label = str(names.get(class_id, f"object_{class_id}"))
            elif isinstance(names, (list, tuple)) and 0 <= class_id < len(names):
                label = str(names[class_id])
            else:
                label = f"object_{class_id}"
            bbox = _normalize_box(np.array(boxes.xyxy[idx].cpu().numpy(), dtype=float))

            detections.append(
                {
                    "label": str(label),
                    "confidence": round(confidence, 2),
                    "bbox": bbox,
                }
            )

        detections.sort(key=lambda d: d["confidence"], reverse=True)
        return detections[:max_objects]
    except Exception:
        logger.exception("Object detection failed.")
        return []


def summarize_objects(detections: List[Dict[str, Any]]) -> str:
    """Create a short human-readable object summary."""
    if not detections:
        return "No clear objects were detected."

    label_count: Dict[str, int] = {}
    for item in detections:
        label = item.get("label", "object")
        label_count[label] = label_count.get(label, 0) + 1

    parts = [f"{count} {label}{'s' if count > 1 else ''}" for label, count in sorted(label_count.items())]
    return "; ".join(parts)
