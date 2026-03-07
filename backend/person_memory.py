"""Face recognition helpers for Person Memory system."""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Tuple, Sequence

import cv2
import numpy as np

from .person_db import find_match, upsert_person

logger = logging.getLogger(__name__)

try:
    import face_recognition
except Exception:  # pragma: no cover - optional dependency
    face_recognition = None

# Tracks the most recently identified person so "repeat their name" works
_last_recognized_name: Optional[str] = None


def face_lib_available() -> bool:
    """Whether face recognition dependencies are available."""
    return face_recognition is not None


def get_last_recognized() -> Optional[str]:
    """Return the name of the most recently identified person, or None."""
    return _last_recognized_name


def _largest_face(encodings_with_boxes: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Return face record with the largest area."""
    if not encodings_with_boxes:
        return None
    def _area(item: Dict[str, Any]) -> int:
        box = item.get("box", {})
        return int((box.get("w", 0) or 0) * (box.get("h", 0) or 0))

    return sorted(encodings_with_boxes, key=_area, reverse=True)[0]


def extract_face_encodings(frame_bgr: np.ndarray) -> List[Dict[str, Any]]:
    """Extract face encodings from frame, returning one entry per face."""
    if face_recognition is None:
        raise RuntimeError("Face recognition engine is not installed.")
    if frame_bgr is None or frame_bgr.size == 0:
        return []

    try:
        rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        boxes = face_recognition.face_locations(rgb, model="hog")
        encodings = face_recognition.face_encodings(rgb, boxes, num_jitters=1)
    except Exception:
        logger.exception("Face detection/encoding failed.")
        return []

    results: List[Dict[str, Any]] = []
    for (top, right, bottom, left), encoding in zip(boxes, encodings):
        if encoding is None:
            continue
        try:
            arr = np.asarray(encoding, dtype=float).flatten()
        except Exception:
            continue
        results.append(
            {
                "encoding": arr,
                "box": {"x1": int(left), "y1": int(top), "x2": int(right), "y2": int(bottom), "w": int(right-left), "h": int(bottom-top)},
            }
        )
    return results


def remember_person(frame_bgr: np.ndarray, name: str) -> Dict[str, Any]:
    """Store the largest visible face as a named person."""
    if not name.strip():
        raise ValueError("Name is required.")
    faces = extract_face_encodings(frame_bgr)
    if not faces:
        raise RuntimeError("No face detected in the image.")

    best = _largest_face(faces)
    if not best:
        raise RuntimeError("No face detected in the image.")

    stored = upsert_person(name.strip(), best["encoding"])
    return {
        "name": stored["name"],
        "message": f"OK, I will remember this person as {stored['name']}.",
    }


def identify_person(frame_bgr: np.ndarray, tolerance: float = 0.55) -> Dict[str, Any]:
    """Find the best matching stored person for the largest face in frame."""
    global _last_recognized_name

    faces = extract_face_encodings(frame_bgr)
    if not faces:
        return {"name": None, "text": "I could not detect a face."}

    best = _largest_face(faces)
    if not best:
        return {"name": None, "text": "I could not detect a face."}

    match = find_match(best["encoding"], tolerance=tolerance)
    if not match:
        return {"name": None, "text": "I don't know this person."}

    name, confidence = match
    _last_recognized_name = name
    return {
        "name": name,
        "confidence": confidence,
        "text": name,
    }


def identify_all_persons(frame_bgr: np.ndarray, tolerance: float = 0.55) -> Dict[str, Any]:
    """Detect and identify ALL visible faces in the frame.

    Returns count, per-face results (name, confidence, bounding box), and a
    natural-language spoken summary describing how many people are visible and
    who they are.
    """
    global _last_recognized_name

    faces = extract_face_encodings(frame_bgr)
    if not faces:
        return {
            "faces": [],
            "count": 0,
            "known_names": [],
            "text": "I could not detect any faces in view.",
        }

    results: List[Dict[str, Any]] = []
    for face in faces:
        match = find_match(face["encoding"], tolerance=tolerance)
        name = match[0] if match else None
        confidence = match[1] if match else None
        results.append(
            {
                "name": name,
                "confidence": confidence,
                "box": face["box"],
            }
        )

    # Update last-recognized from the largest face
    best = _largest_face(faces)
    if best:
        try:
            best_idx = faces.index(best)
            best_name = results[best_idx].get("name")
            if best_name:
                _last_recognized_name = best_name
        except Exception:
            pass

    known: List[str] = [r["name"] for r in results if r["name"]]
    unknown_count = sum(1 for r in results if not r["name"])
    total = len(results)

    # Build natural-language summary
    if total == 1:
        if known:
            text = f"I can see 1 person: {known[0]}."
        else:
            text = "I can see 1 person, but I don't recognise them."
    else:
        parts: List[str] = []
        if known:
            parts.append(", ".join(known))
        if unknown_count == 1:
            parts.append("1 unknown person")
        elif unknown_count > 1:
            parts.append(f"{unknown_count} unknown people")
        people_str = " and ".join(parts) if parts else "some people"
        text = f"I can see {total} people: {people_str}."

    return {
        "faces": results,
        "count": total,
        "known_names": known,
        "text": text,
    }
