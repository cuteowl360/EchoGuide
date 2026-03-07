"""People memory persistence for face recognition."""

from __future__ import annotations

import json
import logging
import threading
from pathlib import Path
import os
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

logger = logging.getLogger(__name__)

_DB_LOCK = threading.Lock()


def _db_path() -> Path:
    """Resolve people DB path relative to project root."""
    explicit_path = os.getenv("PERSON_DB_PATH", "").strip()
    if explicit_path:
        return Path(explicit_path).expanduser().resolve()

    base = Path(__file__).resolve().parents[1]
    return base / "people_db.json"


def _load_raw() -> List[Dict[str, Any]]:
    """Load the JSON DB contents."""
    path = _db_path()
    if not path.exists():
        return []

    try:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            return data
        return []
    except Exception:
        logger.exception("Failed to read people DB.")
        return []


def load_people_db() -> List[Dict[str, Any]]:
    """Return all stored person entries."""
    with _DB_LOCK:
        return _load_raw()


def save_people_db(people: Sequence[Dict[str, Any]]) -> None:
    """Persist people list to disk."""
    path = _db_path()
    serializable = []
    for p in people:
        if not isinstance(p, dict):
            continue
        record: Dict[str, Any] = {"name": str(p.get("name", "")).strip()}
        if not record["name"]:
            continue
        encoding = p.get("face_encoding", [])
        try:
            np_encoding = np.asarray(encoding, dtype=float).flatten()
            record["face_encoding"] = np_encoding.tolist()
            serializable.append(record)
        except Exception:
            logger.exception("Skipping invalid face encoding for person: %s", record["name"])

    with _DB_LOCK:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(serializable, indent=2), encoding="utf-8")


def upsert_person(name: str, encoding: Sequence[float] | np.ndarray) -> Dict[str, Any]:
    """Store or update a person by name.
    
    Up to 5 sample encodings are kept per person and averaged for matching,
    which improves accuracy across different lighting and head angles.
    """
    people = load_people_db()
    normalized_name = str(name).strip()
    if not normalized_name:
        raise ValueError("Person name cannot be empty.")

    new_enc = np.asarray(encoding, dtype=float).flatten().tolist()

    existing = next(
        (p for p in people if str(p.get("name", "")).strip().lower() == normalized_name.lower()),
        None,
    )

    MAX_SAMPLES = 5
    if existing is not None:
        # Accumulate samples; keep the most recent MAX_SAMPLES
        samples = existing.get("samples", [existing.get("face_encoding", [])])
        samples = [s for s in samples if isinstance(s, list) and s]
        samples.append(new_enc)
        if len(samples) > MAX_SAMPLES:
            samples = samples[-MAX_SAMPLES:]
        existing["samples"] = samples
        # Averaged encoding for fast lookup
        existing["face_encoding"] = np.mean(np.array(samples), axis=0).tolist()
    else:
        people.append({
            "name": normalized_name,
            "face_encoding": new_enc,
            "samples": [new_enc],
        })

    save_people_db(people)
    return {"name": normalized_name, "face_encoding": new_enc}


def find_match(
    encoding: Sequence[float] | np.ndarray,
    tolerance: float = 0.45,
) -> Optional[Tuple[str, float]]:
    """Return the best person name and similarity score for an encoding."""
    people = load_people_db()
    if not people:
        return None

    try:
        query = np.asarray(encoding, dtype=float).flatten()
    except Exception:
        logger.exception("Invalid encoding for match lookup.")
        return None

    best_name: Optional[str] = None
    best_distance = float("inf")

    for person in people:
        raw = person.get("face_encoding")
        if not isinstance(raw, list) or not raw:
            continue
        try:
            candidate = np.asarray(raw, dtype=float).flatten()
            distance = float(np.linalg.norm(query - candidate))
        except Exception:
            logger.exception("Invalid stored encoding for %s", person.get("name"))
            continue

        if distance < best_distance:
            best_distance = distance
            best_name = str(person.get("name", "")).strip()

    if best_name is None:
        return None

    if best_distance > tolerance:
        return None

    confidence = 1.0 - min(1.0, best_distance)
    return best_name, max(0.0, min(1.0, confidence))
