"""Navigation helpers — OpenRouteService Directions + Geocoding."""

from __future__ import annotations

import logging
import math
import os
from typing import Any, Dict, List, Optional, Tuple

import requests

logger = logging.getLogger(__name__)

ORS_DIRECTIONS_URL  = "https://api.openrouteservice.org/v2/directions/foot-walking/geojson"
ORS_GEOCODE_URL     = "https://api.openrouteservice.org/geocode/search"
ORS_AUTOCOMPLETE_URL = "https://api.openrouteservice.org/geocode/autocomplete"

# Obstacles that are worth announcing while the user is walking
OBSTACLE_LABELS = {
    "person", "bicycle", "car", "motorcycle", "bus", "truck",
    "traffic light", "stop sign", "bench", "chair", "potted plant",
    "fire hydrant", "parking meter", "dog", "cat", "suitcase",
    "backpack", "umbrella", "cone", "barrier",
}


# ── Geocoding ─────────────────────────────────────────────────────────────────

def geocode_place(
    query: str,
    near_lat: float,
    near_lon: float,
    limit: int = 3,
) -> List[Dict[str, Any]]:
    """
    Search for a place using ORS autocomplete (typo-tolerant fuzzy matching).
    Falls back to standard search if autocomplete returns nothing or errors.

    Returns a list of up to `limit` candidates, each:
      {
        "lat": float, "lon": float,
        "name": str,          # e.g. "Starbucks"
        "address": str,       # full human-readable address
        "distance_m": float,  # metres from the user's current position
        "category": str,      # e.g. "cafe" or ""
      }
    Raises ValueError if nothing is found.
    """
    api_key = os.getenv("ORS_API_KEY", "").strip()
    if not api_key:
        raise ValueError("ORS_API_KEY is not set in .env")

    common_params = {
        "api_key": api_key,
        "text": query,
        "focus.point.lat": near_lat,     # bias results toward user's location
        "focus.point.lon": near_lon,
        "boundary.circle.lat": near_lat,
        "boundary.circle.lon": near_lon,
        "boundary.circle.radius": 25,    # km
        "size": limit,
        "lang": "en",
    }

    features: List[Any] = []

    # 1️⃣  Try autocomplete first — handles partial words and typos
    try:
        r = requests.get(ORS_AUTOCOMPLETE_URL, params=common_params, timeout=10)
        if r.status_code == 200:
            features = r.json().get("features", [])
    except Exception:
        pass

    # 2️⃣  Fall back to standard search for longer / corrected queries
    if not features:
        try:
            r = requests.get(ORS_GEOCODE_URL, params=common_params, timeout=10)
            if r.status_code == 200:
                features = r.json().get("features", [])
            else:
                raise ValueError(f"ORS geocoding error {r.status_code}: {r.text[:200]}")
        except ValueError:
            raise
        except Exception as exc:
            raise ValueError(f"Geocoding request failed: {exc}") from exc

    if not features:
        raise ValueError(f"No locations found for '{query}'. Try a different spelling or add a city name.")

    results: List[Dict[str, Any]] = []
    for feat in features:
        lon, lat = feat["geometry"]["coordinates"]
        props    = feat.get("properties", {})
        name     = props.get("name") or props.get("label", query)
        address  = props.get("label", name)
        category = ""
        cats     = props.get("addendum", {}).get("osm", {}).get("amenity", "")
        if cats:
            category = cats
        dist_m   = haversine_m(near_lat, near_lon, lat, lon)
        results.append({
            "lat": lat,
            "lon": lon,
            "name": name,
            "address": address,
            "distance_m": round(dist_m),
            "category": category,
        })

    # Sort by distance so the closest is always first
    results.sort(key=lambda x: x["distance_m"])
    return results


# ── Route fetching ────────────────────────────────────────────────────────────

def get_route(
    origin_lat: float,
    origin_lon: float,
    dest_lat: float,
    dest_lon: float,
) -> Dict[str, Any]:
    """
    Fetch a walking route from OpenRouteService and return a normalised dict:
      {
        "steps": [
          {"instruction": "Head north on Main St", "distance_m": 120,
           "lat": ..., "lon": ...},
          ...
        ],
        "total_distance_m": 450,
        "total_duration_s": 360,
      }
    Raises ValueError on API error.
    """
    api_key = os.getenv("ORS_API_KEY", "").strip()
    if not api_key:
        raise ValueError("ORS_API_KEY is not set in .env")

    resp = requests.post(
        ORS_DIRECTIONS_URL,
        headers={"Authorization": api_key, "Content-Type": "application/json"},
        json={
            "coordinates": [[origin_lon, origin_lat], [dest_lon, dest_lat]],
            "instructions": True,
            "language": "en",
            "units": "m",
        },
        timeout=15,
    )

    if resp.status_code != 200:
        raise ValueError(f"ORS routing error {resp.status_code}: {resp.text[:200]}")

    data = resp.json()
    features = data.get("features", [])
    if not features:
        raise ValueError("ORS returned no routes for these coordinates.")

    feature  = features[0]
    coords   = feature["geometry"]["coordinates"]  # [[lon, lat], ...]
    props    = feature["properties"]
    summary  = props.get("summary", {})
    segments = props.get("segments", [])

    steps: List[Dict[str, Any]] = []
    for seg in segments:
        for raw in seg.get("steps", []):
            wp_idx = raw.get("way_points", [0])[0]
            lon, lat = coords[wp_idx] if wp_idx < len(coords) else (origin_lon, origin_lat)
            steps.append({
                "instruction": raw.get("instruction", "Continue."),
                "distance_m":  raw.get("distance", 0),
                "duration_s":  raw.get("duration", 0),
                "lat": lat,
                "lon": lon,
            })

    return {
        "steps": steps,
        "total_distance_m": summary.get("distance", 0),
        "total_duration_s": summary.get("duration", 0),
    }


# ── Proximity helpers ─────────────────────────────────────────────────────────

def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Return distance in metres between two GPS coordinates."""
    R = 6_371_000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def next_step_index(
    steps: List[Dict[str, Any]],
    current_lat: float,
    current_lon: float,
    current_step: int,
    arrival_radius_m: float = 15.0,
) -> Tuple[int, float]:
    """
    Return (new_step_index, distance_to_next_waypoint_m).
    Advances the step counter when the user is within arrival_radius_m.
    """
    if current_step >= len(steps):
        return current_step, 0.0

    step = steps[current_step]
    dist = haversine_m(current_lat, current_lon, step["lat"], step["lon"])

    if dist <= arrival_radius_m and current_step + 1 < len(steps):
        return current_step + 1, haversine_m(
            current_lat, current_lon,
            steps[current_step + 1]["lat"],
            steps[current_step + 1]["lon"],
        )

    return current_step, dist


# ── Obstacle filtering ────────────────────────────────────────────────────────

def filter_obstacles(detections: List[Dict[str, Any]]) -> List[str]:
    """
    Given YOLO detections from vision.detect_objects(), return a list of
    obstacle labels worth announcing (deduplicated, sorted by confidence).
    """
    seen: Dict[str, float] = {}
    for d in detections:
        label = d.get("label", "").lower()
        conf  = float(d.get("confidence", 0))
        if label in OBSTACLE_LABELS:
            if conf > seen.get(label, 0):
                seen[label] = conf

    return sorted(seen, key=lambda k: -seen[k])


def build_obstacle_announcement(obstacles: List[str]) -> str:
    if not obstacles:
        return ""
    if len(obstacles) == 1:
        return f"Warning: {obstacles[0]} ahead."
    listed = ", ".join(obstacles[:-1]) + f", and {obstacles[-1]}"
    return f"Warning: {listed} ahead."
