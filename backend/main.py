"""FastAPI backend for VisionAssist AI."""

from __future__ import annotations

import base64
import json
import logging
import os
import time
from io import BytesIO
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import asyncio
import cv2
import numpy as np
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from .elevenlabs_client import is_available as tts_is_available, synthesize_speech
from .gemini_client import describe_scene, interpret_voice, guide_scan_frame, is_available as gemini_is_available
from .ocr import ocr_is_available, recognize_text
from .person_memory import (
    face_lib_available,
    get_last_recognized,
    identify_person as identify_person_from_frame,
    remember_person as remember_person_from_frame,
)
from .vision import detect_objects, model_is_available, summarize_objects
from .vision import detect_objects_aws, rekognition_is_available
from .navigation import (
    get_route,
    geocode_place,
    filter_obstacles,
    build_obstacle_announcement,
)
from . import auth as _auth

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parents[1]
FRONTEND_DIR = PROJECT_ROOT / "frontend"

app = FastAPI(title="VisionAssist AI", version="1.0.0")

origins = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()]
if not origins:
    origins = ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=False if "*" in origins else True,
    allow_methods=["*"],
    allow_headers=["*"],
)

from fastapi.responses import HTMLResponse, Response

# Serve static files with no-cache headers so the browser always gets fresh JS/CSS
@app.get("/static/{file_path:path}")
async def static_files(file_path: str) -> Response:
    full_path = FRONTEND_DIR / file_path
    if not full_path.is_file():
        raise HTTPException(status_code=404, detail="File not found.")
    suffix = full_path.suffix.lower()
    media_types = {".js": "application/javascript", ".css": "text/css",
                   ".html": "text/html", ".png": "image/png",
                   ".jpg": "image/jpeg", ".ico": "image/x-icon",
                   ".webmanifest": "application/manifest+json"}
    content_type = media_types.get(suffix, "application/octet-stream")
    return Response(
        content=full_path.read_bytes(),
        media_type=content_type,
        headers={"Cache-Control": "no-store"},
    )


@app.get("/sw.js")
async def service_worker() -> Response:
    """Serve the service worker script from the app root so it can scope to "/"."""
    full_path = FRONTEND_DIR / "sw.js"
    if not full_path.is_file():
        raise HTTPException(status_code=404, detail="File not found.")
    return Response(
        content=full_path.read_bytes(),
        media_type="application/javascript",
        headers={"Cache-Control": "no-store"},
    )

# Auth routes (/auth/register, /auth/login, /auth/logout, /auth/me)
app.include_router(_auth.router)

@app.on_event("startup")
def _startup() -> None:
    _auth.init_db()


def _decode_frame(image_bytes: bytes) -> np.ndarray:
    """Convert uploaded bytes into OpenCV BGR frame."""
    np_arr = np.frombuffer(image_bytes, dtype=np.uint8)
    frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
    if frame is None:
        raise HTTPException(status_code=400, detail="Uploaded image is invalid.")
    return frame


def _combine_result(description: str, detections: List[Dict[str, Any]], ocr_text: str) -> str:
    """Build a clear final description text for the user."""
    object_summary = summarize_objects(detections)
    if ocr_text.strip():
        return (
            f"{description or 'I can see the scene.'} "
            f"Detected objects: {object_summary}. Text on screen: {ocr_text.strip()}."
        )
    return description or f"Detected objects: {object_summary}."


def _run_analysis(frame: np.ndarray) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    detections = detect_objects(frame)
    ocr_result = recognize_text(frame)
    return detections, ocr_result


@app.get("/health")
async def health() -> Dict[str, Any]:
    """Return service availability."""
    return {
        "status": "ok",
        "features": {
            "object_detection": model_is_available(),
            "aws_rekognition": rekognition_is_available(),
            "ocr": ocr_is_available(),
            "gemini": gemini_is_available(),
            "tts": tts_is_available(),
            "face_memory": face_lib_available(),
        },
    }


@app.get("/")
async def root() -> FileResponse:
    """Serve frontend HTML."""
    index_file = FRONTEND_DIR / "index.html"
    if not index_file.exists():
        raise HTTPException(status_code=500, detail="Frontend not found.")
    return FileResponse(index_file)


@app.get("/login")
async def login_page() -> FileResponse:
    """Serve the login page."""
    page = FRONTEND_DIR / "login.html"
    if not page.exists():
        raise HTTPException(status_code=500, detail="Login page not found.")
    return FileResponse(page)


@app.get("/register")
async def register_page() -> FileResponse:
    """Serve the account creation page."""
    page = FRONTEND_DIR / "register.html"
    if not page.exists():
        raise HTTPException(status_code=500, detail="Register page not found.")
    return FileResponse(page)


@app.post("/analyze_scene")
async def analyze_scene(
    image: UploadFile = File(...),
    question: str = Form("Describe this image clearly for a visually impaired user."),
    history: str = Form("[]"),
) -> Dict[str, Any]:
    """
    Run object detection + OCR + Gemini and return a combined natural description.
    """
    if image.content_type and not image.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Only image uploads are supported.")

    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="No image uploaded.")

    frame = _decode_frame(image_bytes)
    try:
        detections, ocr_result = await asyncio.to_thread(_run_analysis, frame)
    except Exception as exc:
        logger.exception("Error during analyze pipeline.")
        raise HTTPException(status_code=500, detail="Unable to process image.") from exc

    # Keep history validation minimal for this endpoint.
    if history:
        try:
            parsed = json.loads(history)
            if not isinstance(parsed, list):
                parsed = []
        except Exception:
            parsed = []
    else:
        parsed = []

    if not question.strip():
        question = "Describe this image clearly for a visually impaired user."

    try:
        description = await describe_scene(
            frame,
            question,
            detections,
            ocr_result,
            parsed,
        )
    except Exception as exc:
        logger.exception("Gemini processing failed.")
        description = _combine_result("I am having trouble describing the scene right now.", detections, ocr_result.get("text", ""))
    scene_description = _combine_result(description, detections, ocr_result.get("text", ""))

    return {
        "description": scene_description,
        "scene_description": scene_description,
        "detected_objects": detections,
        "ocr_text": ocr_result.get("text", ""),
        "history": parsed,
    }


@app.post("/scan_scene")
async def scan_scene(
    image: UploadFile = File(...),
    question: str = Form("Describe this image clearly for a visually impaired user."),
) -> Dict[str, Any]:
    """Scan scene endpoint for the wearable flow."""
    if image.content_type and not image.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Only image uploads are supported.")

    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="No image uploaded.")

    frame = _decode_frame(image_bytes)

    try:
        detections, ocr_result = await asyncio.to_thread(_run_analysis, frame)
        desc_raw = await describe_scene(
            frame,
            question,
            detections,
            ocr_result,
        )
        description = _combine_result(desc_raw, detections, ocr_result.get("text", ""))
        return {
            "status": "ok",
            "mode": "scan_scene",
            "text": description,
            "detected_objects": detections,
            "ocr_text": ocr_result.get("text", ""),
        }
    except HTTPException:
        raise
    except Exception:
        logger.exception("scan_scene failed")
        raise HTTPException(status_code=500, detail="Failed to analyze scene.")


@app.post("/voice_response")
async def voice_response(text: str = Form(...)):
    """
    Convert response text into voice audio.
    Returns audio/mpeg bytes for direct playback.
    """
    spoken = (text or "").strip()
    if not spoken:
        raise HTTPException(status_code=400, detail="Text cannot be empty.")

    audio_bytes = await asyncio.to_thread(synthesize_speech, spoken)
    if audio_bytes is None:
        raise HTTPException(status_code=503, detail="TTS unavailable. Configure ELEVENLABS_API_KEY.")
    if not audio_bytes:
        raise HTTPException(status_code=500, detail="No audio returned.")

    return StreamingResponse(
        BytesIO(audio_bytes),
        media_type="audio/mpeg",
        headers={"Cache-Control": "no-store", "Content-Disposition": "inline; filename=voice.mp3"},
    )


@app.post("/read_text")
async def read_text(image: UploadFile = File(...)) -> Dict[str, Any]:
    """Read visible text from a captured frame."""
    if image.content_type and not image.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Only image uploads are supported.")

    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="No image uploaded.")

    frame = _decode_frame(image_bytes)

    try:
        result = await asyncio.to_thread(recognize_text, frame)
        text = (result.get("text") or "").strip()
        response_text = text if text else "No readable text detected."
        return {
            "status": "ok",
            "mode": "read_text",
            "text": response_text,
            "raw": result,
        }
    except Exception as exc:
        logger.exception("read_text failed")
        raise HTTPException(status_code=500, detail="Failed to read text.") from exc


@app.post("/remember_person")
async def remember_person(image: UploadFile = File(...), name: str = Form(...)) -> Dict[str, Any]:
    """Capture and store a face embedding for a person."""
    if not name or not name.strip():
        raise HTTPException(status_code=400, detail="Name is required.")
    if not face_lib_available():
        raise HTTPException(status_code=503, detail="Face recognition is not available. Install face_recognition.")
    if image.content_type and not image.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Only image uploads are supported.")

    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="No image uploaded.")
    frame = _decode_frame(image_bytes)

    try:
        saved = await asyncio.to_thread(remember_person_from_frame, frame, name)
        return {"status": "ok", "mode": "remember_person", "name": saved.get("name"), "text": saved.get("message", "Person stored.")}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception:
        logger.exception("remember_person failed")
        raise HTTPException(status_code=500, detail="Unable to remember person.")


@app.post("/identify_person")
async def identify_person(image: UploadFile = File(...)) -> Dict[str, Any]:
    """Identify a face against stored people memory."""
    if not face_lib_available():
        raise HTTPException(status_code=503, detail="Face recognition is not available. Install face_recognition.")
    if image.content_type and not image.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Only image uploads are supported.")

    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="No image uploaded.")
    frame = _decode_frame(image_bytes)

    try:
        result = await asyncio.to_thread(identify_person_from_frame, frame)
        text = result.get("text") or "I don't know this person."
        return {
            "status": "ok",
            "mode": "identify_person",
            "name": result.get("name"),
            "confidence": result.get("confidence"),
            "text": text,
        }
    except Exception:
        logger.exception("identify_person failed")
        raise HTTPException(status_code=500, detail="Unable to identify person.")


@app.get("/last_person")
async def last_person() -> Dict[str, Any]:
    """Return the name of the most recently identified person."""
    name = get_last_recognized()
    if name:
        return {"status": "ok", "name": name, "text": name}
    return {"status": "ok", "name": None, "text": "I haven't identified anyone yet."}


# Backward-compatible endpoints for earlier frontends.
@app.post("/api/analyze")
async def analyze_legacy(
    image: UploadFile = File(...),
    question: str = Form("Describe this image clearly for a visually impaired user."),
    history: str = Form("[]"),
) -> Dict[str, Any]:
    return await analyze_scene(image=image, question=question, history=history)


@app.post("/api/speak")
async def speak_legacy(text: str = Form(...)) -> Dict[str, str]:
    audio_bytes = await asyncio.to_thread(synthesize_speech, text)
    if audio_bytes is None:
        raise HTTPException(status_code=503, detail="TTS unavailable.")
    if not audio_bytes:
        raise HTTPException(status_code=500, detail="No audio returned.")
    return {
        "audio_base64": base64.b64encode(audio_bytes).decode("utf-8"),
        "mime_type": "audio/mpeg",
    }


# ── Navigation endpoints ──────────────────────────────────────────────────────

class _NavRouteRequest(dict):
    pass


from pydantic import BaseModel

class NavRouteRequest(BaseModel):
    origin_lat: float
    origin_lon: float
    dest_lat: float
    dest_lon: float


class NavObstacleRequest(BaseModel):
    # base64-encoded JPEG/PNG frame from the camera
    image_b64: str
    # current step index so the frontend can correlate the reply
    current_step: int = 0


class NavGeocodeRequest(BaseModel):
    query: str
    near_lat: float
    near_lon: float


@app.post("/navigate/geocode")
async def navigate_geocode(req: NavGeocodeRequest) -> Dict[str, Any]:
    """
    Search for a place name near the user's location.
    Returns up to 3 candidates with name, address, and distance.
    """
    if not req.query.strip():
        raise HTTPException(status_code=400, detail="query is required.")
    try:
        candidates = await asyncio.to_thread(geocode_place, req.query, req.near_lat, req.near_lon)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception:
        logger.exception("navigate_geocode failed")
        raise HTTPException(status_code=500, detail="Geocoding failed.")
    return {"status": "ok", "candidates": candidates}


@app.post("/navigate/route")
async def navigate_route(req: NavRouteRequest) -> Dict[str, Any]:
    """
    Fetch a walking route from Mapbox.
    Returns ordered steps with spoken instructions and coordinates.
    """
    try:
        route = await asyncio.to_thread(
            get_route,
            req.origin_lat, req.origin_lon,
            req.dest_lat, req.dest_lon,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception:
        logger.exception("navigate_route failed")
        raise HTTPException(status_code=500, detail="Could not fetch route.")

    # Optionally pre-synthesise the first instruction
    first_text = route["steps"][0]["instruction"] if route["steps"] else "Route ready."
    audio_b64: Optional[str] = None
    if tts_is_available():
        audio_bytes = await asyncio.to_thread(synthesize_speech, first_text)
        if audio_bytes:
            audio_b64 = base64.b64encode(audio_bytes).decode("utf-8")

    return {
        "status": "ok",
        "route": route,
        "first_instruction_audio": audio_b64,
    }


@app.post("/navigate/speak_step")
async def navigate_speak_step(text: str = Form(...)) -> Dict[str, str]:
    """
    Convert a navigation instruction string to TTS audio.
    The frontend calls this whenever the user advances to a new step.
    """
    if not text.strip():
        raise HTTPException(status_code=400, detail="text is required.")
    if not tts_is_available():
        raise HTTPException(status_code=503, detail="TTS is not configured.")
    audio_bytes = await asyncio.to_thread(synthesize_speech, text.strip())
    if not audio_bytes:
        raise HTTPException(status_code=500, detail="No audio returned.")
    return {
        "audio_base64": base64.b64encode(audio_bytes).decode("utf-8"),
        "mime_type": "audio/mpeg",
    }


@app.post("/voice/interpret")
async def voice_interpret(payload: dict):
    """
    Accepts {"phrase": "..."} and returns {"intent": "...", "params": {...}}.
    Uses Gemini to understand free-form speech commands.
    """
    phrase = (payload.get("phrase") or "").strip()
    if not phrase:
        return {"intent": "unknown", "params": {}}
    result = await interpret_voice(phrase)
    return result


@app.post("/navigate/scan_obstacles")
async def navigate_scan_obstacles(req: NavObstacleRequest) -> Dict[str, Any]:
    """
    Accept a base64 camera frame, run YOLO, return obstacle announcement + audio.
    Called by the frontend on a timer (e.g. every 3 seconds) while navigating.
    """
    try:
        img_bytes = base64.b64decode(req.image_b64)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64 image.")

    frame = _decode_frame(img_bytes)
    detections = await asyncio.to_thread(detect_objects, frame)
    obstacles = filter_obstacles(detections)
    announcement = build_obstacle_announcement(obstacles)

    audio_b64: Optional[str] = None
    if announcement and tts_is_available():
        audio_bytes = await asyncio.to_thread(synthesize_speech, announcement)
        if audio_bytes:
            audio_b64 = base64.b64encode(audio_bytes).decode("utf-8")

    return {
        "status": "ok",
        "current_step": req.current_step,
        "obstacles": obstacles,
        "announcement": announcement,
        "audio_base64": audio_b64,
    }


# ── Guide Mode ────────────────────────────────────────────────────────────────

@app.post("/guide/scan")
async def guide_scan(image: UploadFile = File(...)) -> Dict[str, Any]:
    """
    Guide Mode real-time loop endpoint.
    Accepts a camera frame, runs Gemini Vision hazard detection,
    returns guidance text + ElevenLabs audio (base64 mp3).
    Called by the frontend every 2 seconds while Guide Mode is active.
    """
    if image.content_type and not image.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Image file required.")

    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Empty image.")

    request_id = int(time.time() * 1000)
    logger.info("[guide] scan start id=%s bytes=%s", request_id, len(image_bytes))

    frame = _decode_frame(image_bytes)

    # GUIDE_ENGINE controls detection backend for live guide frames.
    # Set to "aws" (default) or "yolo" to switch back to the local model.
    engine = os.getenv("GUIDE_ENGINE", "aws").strip().lower()
    use_aws = engine in {"aws", "rekognition", "aws_rekognition"}
    detections: List[Dict[str, Any]] = []
    if use_aws:
        aws_min_conf = 45.0
        aws_max_labels = 25
        try:
            aws_min_conf = float(os.getenv("GUIDE_AWS_MIN_CONF", str(aws_min_conf)))
            aws_max_labels = int(os.getenv("GUIDE_AWS_MAX_LABELS", str(aws_max_labels)))
        except ValueError:
            pass

        detections = await asyncio.to_thread(
            detect_objects_aws,
            frame,
            min_confidence=aws_min_conf,
            max_labels=aws_max_labels,
        )
        if not detections:
            logger.warning("[guide] AWS detection empty. Falling back to YOLO.")
            detections = await asyncio.to_thread(detect_objects, frame)
    else:
        yolo_conf = 0.2
        yolo_max = 50
        try:
            yolo_conf = float(os.getenv("GUIDE_YOLO_CONF", str(yolo_conf)))
            yolo_max = int(os.getenv("GUIDE_YOLO_MAX", str(yolo_max)))
        except ValueError:
            pass

        detections = await asyncio.to_thread(
            detect_objects,
            frame,
            confidence_threshold=yolo_conf,
            max_objects=yolo_max,
        )

    result = await guide_scan_frame(frame, detections=detections)
    guidance: str  = result["guidance"]
    is_danger: bool = result["is_danger"]

    # ElevenLabs TTS
    audio_b64: Optional[str] = None
    if tts_is_available():
        audio_bytes = await asyncio.to_thread(synthesize_speech, guidance)
        if audio_bytes:
            audio_b64 = base64.b64encode(audio_bytes).decode("utf-8")

    logger.info(
        "[guide] scan end id=%s detections=%s danger=%s guidance=%s audio=%s",
        request_id,
        len(detections),
        is_danger,
        guidance,
        bool(audio_b64),
    )

    return {
        "guidance":    guidance,
        "is_danger":   is_danger,
        "detection_count": len(detections),
        "audio_base64": audio_b64,
    }
