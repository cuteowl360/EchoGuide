"""YOLOv8 detection module with distance estimation and position labelling.

This is the dedicated detection layer for Guide Mode.
All object positions (left / center / right) and distance estimates
(close / near / far, with rough metre estimate) are computed here so
that the navigation layer and Gemini only deal with structured data.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

from .vision import detect_objects as _yolo_detect
from .config import CLOSE_THRESHOLD, MEDIUM_THRESHOLD

logger = logging.getLogger(__name__)

# ── Position labels ───────────────────────────────────────────────────────────

def _horizontal_position(cx: float, frame_w: float) -> str:
    """Return 'left', 'center', or 'right' based on horizontal center of bbox."""
    ratio = cx / frame_w if frame_w > 0 else 0.5
    if ratio < 0.35:
        return "left"
    if ratio > 0.65:
        return "right"
    return "center"


def _depth_estimate(box_area: float, frame_area: float) -> Tuple[str, float]:
    """
    Estimate distance category and rough metres from bounding-box size.

    Returns (label, metres):  "close" ~1m, "near" ~3m, "far" ~6m
    """
    if frame_area <= 0:
        return "unknown", 5.0
    ratio = box_area / frame_area
    if ratio >= CLOSE_THRESHOLD:
        # Fill >15% of frame → roughly within 1-2 metres
        metres = max(0.5, round(1.5 * (CLOSE_THRESHOLD / ratio), 1))
        return "close", metres
    if ratio >= MEDIUM_THRESHOLD:
        # 5-15% → roughly 2-5 metres
        metres = round(2.0 + 3.0 * ((CLOSE_THRESHOLD - ratio) / (CLOSE_THRESHOLD - MEDIUM_THRESHOLD)), 1)
        return "near", metres
    # <5% → far (5-10 m)
    metres = round(min(10.0, 5.0 + 5.0 * (MEDIUM_THRESHOLD / max(ratio, 0.001) - 1.0) * 0.1), 1)
    return "far", metres


# ── Main detection function ───────────────────────────────────────────────────

def detect_with_context(
    frame_bgr: np.ndarray,
    confidence_threshold: float = 0.35,
) -> List[Dict[str, Any]]:
    """
    Run YOLOv8 and enrich each detection with:
      - position  : "left" | "center" | "right"
      - distance  : "close" | "near" | "far"
      - metres    : estimated metres to object (float)

    Returns list sorted by estimated distance (closest first).
    """
    if frame_bgr is None or frame_bgr.size == 0:
        return []

    h, w = frame_bgr.shape[:2]
    frame_area = float(w * h)

    raw = _yolo_detect(frame_bgr, confidence_threshold=confidence_threshold)
    enriched: List[Dict[str, Any]] = []

    for det in raw:
        box = det.get("bbox", {})
        x1, y1, x2, y2 = box.get("x1", 0), box.get("y1", 0), box.get("x2", w), box.get("y2", h)
        cx = (x1 + x2) / 2.0
        box_area = float((x2 - x1) * (y2 - y1))

        pos = _horizontal_position(cx, float(w))
        dist_label, metres = _depth_estimate(box_area, frame_area)

        enriched.append({
            **det,
            "position": pos,
            "distance": dist_label,
            "metres": metres,
        })

    # Sort: closest first, then by confidence
    enriched.sort(key=lambda d: (d["metres"], -d["confidence"]))
    return enriched


# ── Target finder ─────────────────────────────────────────────────────────────

def find_target(
    detections: List[Dict[str, Any]],
    target: str,
) -> Optional[Dict[str, Any]]:
    """
    Search enriched detections for the requested target label.
    Returns the closest matching detection or None.

    Matching is fuzzy: 'door' matches 'door', 'exit door', etc.
    """
    target_lower = target.strip().lower()
    matches = []
    for det in detections:
        label = det.get("label", "").lower()
        if target_lower in label or label in target_lower:
            matches.append(det)
    if not matches:
        return None
    # Return closest (already sorted by metres)
    return matches[0]


# ── Obstacle extractor ────────────────────────────────────────────────────────

def extract_obstacles(
    detections: List[Dict[str, Any]],
    obstacle_labels: set,
    max_distance: str = "near",   # only warn about close/near obstacles
) -> List[Dict[str, Any]]:
    """
    Return detected objects that are hazards and close enough to matter.
    Sorted by distance (closest first).
    """
    distance_rank = {"close": 0, "near": 1, "far": 2, "unknown": 3}
    max_rank = distance_rank.get(max_distance, 1)

    obstacles = []
    for det in detections:
        label = det.get("label", "").lower()
        if any(obs in label or label in obs for obs in obstacle_labels):
            if distance_rank.get(det.get("distance", "far"), 3) <= max_rank:
                obstacles.append(det)
    return obstacles


# ── Compact text summary for Gemini prompt ────────────────────────────────────

def detections_to_prompt_lines(detections: List[Dict[str, Any]], max_items: int = 10) -> str:
    """
    Convert enriched detections to concise lines for Gemini prompt context.

    Example output:
        chair  left   close  1.2m  (conf 0.88)
        person center near   3.1m  (conf 0.72)
        door   center far    6.0m  (conf 0.55)
    """
    lines = []
    for det in detections[:max_items]:
        lines.append(
            f"{det.get('label','?'):<18} {det.get('position','?'):<7} "
            f"{det.get('distance','?'):<6} {det.get('metres','?')}m  "
            f"(conf {det.get('confidence', 0):.2f})"
        )
    return "\n".join(lines) if lines else "No objects detected."
