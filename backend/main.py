"""FastAPI backend for VisionAssist AI."""

from __future__ import annotations

import base64
import json
import logging
import os
from io import BytesIO
from pathlib import Path
from typing import Any, Dict, List, Tuple

import asyncio
import cv2
import numpy as np
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .elevenlabs_client import is_available as tts_is_available, synthesize_speech
from .gemini_client import describe_scene, is_available as gemini_is_available
from .ocr import ocr_is_available, recognize_text
from .person_memory import (
    face_lib_available,
    identify_person as identify_person_from_frame,
    remember_person as remember_person_from_frame,
)
from .vision import detect_objects, model_is_available, summarize_objects
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

app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")

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
        text = result.get("text") or "I could not detect anyone."
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
