"""Central configuration for EchoGuide backend.

All tunable constants in one place — override via .env.
"""

from __future__ import annotations
import os

# ── Models ────────────────────────────────────────────────────────────────────
YOLO_MODEL_PATH: str = os.getenv("YOLO_MODEL_PATH", "models/yolov8n.pt")
YOLO_CONFIDENCE: float = float(os.getenv("YOLO_CONFIDENCE", "0.35"))
GEMINI_MODEL: str = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")

# ── Guide Mode ─────────────────────────────────────────────────────────────────
# Objects that are navigation hazards and must trigger a warning
OBSTACLE_LABELS: set[str] = {
    "person", "bicycle", "car", "motorcycle", "bus", "truck",
    "traffic light", "stop sign", "bench", "chair", "potted plant",
    "fire hydrant", "parking meter", "dog", "cat", "suitcase",
    "backpack", "umbrella", "cone", "barrier", "trash can",
    "stairs", "pole", "wall",
}

# Navigable target objects the user can request
TARGET_LABELS: set[str] = {
    "door", "exit", "stairs", "crosswalk", "elevator", "escalator",
    "toilet", "bathroom", "restroom", "gate", "entrance", "ramp",
    # YOLO COCO classes that are useful as targets
    "bench", "chair", "dining table", "tv", "laptop", "refrigerator",
    "sink", "toilet", "couch", "bed",
}

# How large a bounding box must be (fraction of frame area) to be "close"
CLOSE_THRESHOLD: float = float(os.getenv("CLOSE_THRESHOLD", "0.15"))   # >15% of frame
MEDIUM_THRESHOLD: float = float(os.getenv("MEDIUM_THRESHOLD", "0.05"))  # 5-15%
# Below MEDIUM_THRESHOLD → far

# ── TTS ────────────────────────────────────────────────────────────────────────
ELEVENLABS_VOICE_ID: str = os.getenv("ELEVENLABS_VOICE_ID", "EXAVITQu4vr4xnSDxMaL")

# ── API keys (loaded by dotenv in main.py) ────────────────────────────────────
GEMINI_API_KEY: str = os.getenv("GEMINI_API_KEY", "")
ELEVENLABS_API_KEY: str = os.getenv("ELEVENLABS_API_KEY", "")
