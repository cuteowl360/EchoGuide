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

try:
    import boto3
except Exception:  # pragma: no cover - optional dependency
    boto3 = None

_MODEL = None
_MODEL_LOCK = Lock()
_AWS_CLIENT = None
_AWS_CLIENT_LOCK = Lock()


def get_model_path() -> str:
    """Resolve the YOLO model file path."""
    explicit_path = (os.environ.get("YOLO_MODEL_PATH", "").strip())
    if explicit_path:
        candidate = Path(explicit_path).expanduser().resolve()
        if candidate.is_file():
            return str(candidate)

    local_model = (Path(__file__).resolve().parents[1] / "models" / "yolov8n.pt").resolve()
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


def _load_rekognition_client():
    """Load and cache an AWS Rekognition client."""
    global _AWS_CLIENT
    if boto3 is None:
        logger.warning("boto3 is not installed. AWS Rekognition disabled.")
        return None
    if _AWS_CLIENT is not None:
        return _AWS_CLIENT

    with _AWS_CLIENT_LOCK:
        if _AWS_CLIENT is not None:
            return _AWS_CLIENT

        region = os.getenv("AWS_REGION", "us-east-1").strip()
        access_key = os.getenv("AWS_ACCESS_KEY_ID", "").strip()
        secret_key = os.getenv("AWS_SECRET_ACCESS_KEY", "").strip()
        session_kwargs = {}
        if access_key and secret_key:
            session_kwargs["aws_access_key_id"] = access_key
            session_kwargs["aws_secret_access_key"] = secret_key

        try:
            session = boto3.session.Session(**session_kwargs)
            _AWS_CLIENT = session.client("rekognition", region_name=region)
            logger.info("AWS Rekognition client initialized for region %s", region)
        except Exception:
            logger.exception("Failed to init AWS Rekognition client.")
            _AWS_CLIENT = None

        return _AWS_CLIENT


def rekognition_is_available() -> bool:
    """Return True when AWS Rekognition can be used in this runtime."""
    return _load_rekognition_client() is not None


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


def detect_objects_aws(
    frame_bgr: np.ndarray,
    min_confidence: float = 55.0,
    max_labels: int = 15,
) -> List[Dict[str, Any]]:
    """
    Detect objects in an OpenCV BGR frame using AWS Rekognition.
    Returns detections in the same structure as local YOLO output.
    """
    if frame_bgr is None or frame_bgr.size == 0:
        return []

    client = _load_rekognition_client()
    if client is None:
        return []

    try:
        success, encoded = cv2.imencode(".jpg", frame_bgr, [cv2.IMWRITE_JPEG_QUALITY, 75])
        if not success:
            return []

        response = client.detect_labels(
            Image={"Bytes": encoded.tobytes()},
            MinConfidence=min_confidence,
            MaxLabels=max_labels,
        )
    except Exception:
        logger.exception("AWS Rekognition detect_labels failed.")
        return []

    h, w = frame_bgr.shape[:2]
    detections: List[Dict[str, Any]] = []
    for item in response.get("Labels", []):
        label = str(item.get("Name", "")).lower().strip()
        if not label:
            continue
        conf = float(item.get("Confidence", 0.0)) / 100.0
        instances = item.get("Instances", [])
        if instances:
            for instance in instances:
                bb = instance.get("BoundingBox") or {}
                left = float(bb.get("Left", 0.0))
                top = float(bb.get("Top", 0.0))
                width = float(bb.get("Width", 0.0))
                height = float(bb.get("Height", 0.0))
                detections.append(
                    {
                        "label": label,
                        "confidence": round(conf, 2),
                        "bbox": {
                            "x1": int(max(0.0, left) * w),
                            "y1": int(max(0.0, top) * h),
                            "x2": int(min(1.0, left + width) * w),
                            "y2": int(min(1.0, top + height) * h),
                        },
                    }
                )
        else:
            detections.append({"label": label, "confidence": round(conf, 2), "bbox": None})

    detections.sort(key=lambda d: d.get("confidence", 0.0), reverse=True)
    return detections[:max_labels]


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
