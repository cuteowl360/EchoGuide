"""Gemini client for multimodal scene understanding."""

from __future__ import annotations

import asyncio
import base64
import json
import os
from typing import Any, Dict, List, Sequence

try:
    import google.generativeai as genai
except Exception:  # pragma: no cover - optional dependency
    genai = None

try:
    from google import genai as genai_new
except Exception:  # pragma: no cover - optional dependency
    genai_new = None

from .vision import summarize_objects

DEFAULT_SCENE_PROMPT = "Describe this image clearly for a visually impaired user."
ERROR_RESPONSE_BASE = (
    "I cannot describe this scene right now. "
    "The visual-language service is temporarily unavailable."
)
MAX_HISTORY_LINES = 8


def _safe_text_block(blocks: Sequence[Dict[str, Any]]) -> str:
    """Build short OCR text block for prompt context."""
    lines = []
    for block in blocks:
        text = str(block.get("text", "")).strip()
        if text:
            lines.append(f"- {text}")
    return "\n".join(lines)


def _format_history(history: Sequence[Dict[str, Any]]) -> List[str]:
    """Turn conversation history into compact prompt lines."""
    lines: List[str] = []
    if not history:
        return lines

    for item in history[-MAX_HISTORY_LINES:]:
        role = str(item.get("role", "")).strip().lower()
        text = str(item.get("text", "")).strip()
        if not text:
            continue
        label = "User" if role == "user" else "Assistant"
        lines.append(f"{label}: {text}")
    return lines


def _build_prompt(
    question: str,
    detections: Sequence[Dict[str, Any]],
    ocr_text: str,
    history: Sequence[Dict[str, Any]] | None = None,
) -> str:
    """Build context-rich Gemini prompt for a single frame."""
    object_summary = summarize_objects(list(detections))
    ocr_snippet = _safe_text_block(
        [{"text": t} for t in (ocr_text or "").splitlines() if t.strip()]
    )
    history_lines = _format_history(history or [])

    prompt_parts = [
        DEFAULT_SCENE_PROMPT,
        "",
        "Scene context:",
        f"Detected objects: {object_summary}",
    ]
    if ocr_snippet:
        prompt_parts.extend(["", "Detected text:", ocr_snippet])
    if history_lines:
        prompt_parts.extend(["", "Recent conversation:"])
        prompt_parts.extend(history_lines)
    prompt_parts.extend(
        [
            "",
            f"User question: {question.strip() or DEFAULT_SCENE_PROMPT}",
            "",
            "Return a short, direct description suitable for screen readers.",
        ]
    )
    return "\n".join(prompt_parts)


def _fallback_description(detections: Sequence[Dict[str, Any]], ocr_result: Dict[str, Any]) -> str:
    object_summary = summarize_objects(list(detections))
    ocr_text = (ocr_result.get("text", "") or "").strip()
    text = f"I can see: {object_summary}."
    if ocr_text:
        text += f' Text found: "{ocr_text}".'
    return text


def is_available() -> bool:
    """Return True when Gemini key/package is configured."""
    return bool(os.getenv("GEMINI_API_KEY")) and genai is not None


async def describe_scene(
    frame_bgr,
    question: str,
    detections: Sequence[Dict[str, Any]],
    ocr_result: Dict[str, Any],
    history: Sequence[Dict[str, Any]] | None = None,
) -> str:
    """
    Return a Gemini description for the given frame and context.
    """
    if genai is None:
        return (
            f"{ERROR_RESPONSE_BASE} OCR text detected: {ocr_result.get('text', '') or 'none'}."
        )

    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not api_key:
        return (
            f"{ERROR_RESPONSE_BASE} Configure GEMINI_API_KEY. "
            f"Detected objects: {summarize_objects(list(detections))}."
        )

    try:
        import cv2

        _, encoded = cv2.imencode(".jpg", frame_bgr)
        payload = base64.b64encode(encoded.tobytes()).decode("utf-8")
        prompt = _build_prompt(
            question,
            detections,
            (ocr_result.get("text", "") or "").strip(),
            history,
        )
        model_name = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")

        def _call() -> str:
            genai.configure(api_key=api_key)
            model = genai.GenerativeModel(model_name)
            response = model.generate_content(
                [
                    prompt,
                    {"mime_type": "image/jpeg", "data": payload},
                ],
                generation_config={"max_output_tokens": 512},
            )
            return getattr(response, "text", "").strip()

        text = await asyncio.to_thread(_call)
        return text or _fallback_description(detections, ocr_result)
    except Exception:
        return _fallback_description(detections, ocr_result)


_INTENT_PROMPT = """
You are the voice command parser for EchoGuide, an AI assistant for blind users.
The user said the following phrase after the wake word "Echo":

"{phrase}"

Classify this into exactly one of these intents and return ONLY valid JSON (no markdown):

{{
  "intent": "<one of the intents below>",
  "params": {{}}
}}

Intents:
- scan_scene        → user wants to describe / see / scan what is in front of them
- read_text         → user wants to read text, signs, labels, menus, or documents
- identify_person   → user wants to know who is in front of them
- remember_person   → user wants to save/remember a face. Extract "name" into params: {{"name": "..."}}
- repeat_name       → user wants to hear the name of the last identified person again ("repeat their name", "what did you call them", "say their name again")
- navigate          → user wants directions / to go somewhere. Extract "destination" into params: {{"destination": "..."}}
- stop_navigation   → user wants to cancel / stop navigation
- start_camera      → user wants to turn on / open the camera
- stop_camera       → user wants to turn off / close the camera
- start_guide       → user wants to start / activate guide mode / walking assistant
- stop_guide        → user wants to stop / exit guide mode
- help              → user wants to know what commands are available
- unknown           → cannot determine intent

Examples:
"what's around me" → {{"intent":"scan_scene","params":{{}}}}
"can you look in front of me" → {{"intent":"scan_scene","params":{{}}}}
"read what that sign says" → {{"intent":"read_text","params":{{}}}}
"tell me what this says" → {{"intent":"read_text","params":{{}}}}
"who is this person" → {{"intent":"identify_person","params":{{}}}}
"face in front of me, who is it" → {{"intent":"identify_person","params":{{}}}}
"do you know them" → {{"intent":"identify_person","params":{{}}}}
"save this as mom" → {{"intent":"remember_person","params":{{"name":"mom"}}}}
"remember this person as Alice" → {{"intent":"remember_person","params":{{"name":"Alice"}}}}
"learn this person, call them David" → {{"intent":"remember_person","params":{{"name":"David"}}}}
"repeat their name" → {{"intent":"repeat_name","params":{{}}}}
"what did you call them" → {{"intent":"repeat_name","params":{{}}}}
"say their name again" → {{"intent":"repeat_name","params":{{}}}}
"take me to the nearest starbucks" → {{"intent":"navigate","params":{{"destination":"starbucks"}}}}
"how do i get to cvs pharmacy" → {{"intent":"navigate","params":{{"destination":"cvs pharmacy"}}}}
"i need to go to the hospital" → {{"intent":"navigate","params":{{"destination":"hospital"}}}}
"stop" → {{"intent":"stop_navigation","params":{{}}}}
"turn on camera" → {{"intent":"start_camera","params":{{}}}}
"activate camera" → {{"intent":"start_camera","params":{{}}}}
"start guide mode" → {{"intent":"start_guide","params":{{}}}}
"help me walk, turn on guide" → {{"intent":"start_guide","params":{{}}}}
"stop guide mode" → {{"intent":"stop_guide","params":{{}}}}

Return ONLY the JSON object. No explanation.
"""


async def interpret_voice(phrase: str) -> dict:
    """Use Gemini to classify a voice command into a structured intent dict."""
    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not api_key:
        return {"intent": "unknown", "params": {}}

    prompt     = _INTENT_PROMPT.format(phrase=phrase.strip())
    model_name = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")

    # Prefer the new google-genai SDK; fall back to deprecated google-generativeai
    if genai_new is not None:
        def _call() -> str:
            client = genai_new.Client(api_key=api_key)
            response = client.models.generate_content(
                model=model_name,
                contents=prompt,
                config={"max_output_tokens": 128, "temperature": 0.1},
            )
            return (response.text or "").strip()
    elif genai is not None:
        def _call() -> str:
            genai.configure(api_key=api_key)
            model = genai.GenerativeModel(model_name)
            response = model.generate_content(
                prompt,
                generation_config={"max_output_tokens": 128, "temperature": 0.1},
            )
            return getattr(response, "text", "").strip()
    else:
        print("[interpret_voice] No Gemini SDK available")
        return {"intent": "unknown", "params": {}}

    try:
        raw = await asyncio.to_thread(_call)
        # Strip any accidental markdown fences
        raw = raw.strip().lstrip("```json").lstrip("```").rstrip("```").strip()
        return json.loads(raw)
    except Exception as e:
        import traceback
        print(f"[interpret_voice] ERROR: {e}")
        traceback.print_exc()
        return {"intent": "unknown", "params": {}}


# ── Guide Mode ────────────────────────────────────────────────────────────────

_GUIDE_PROMPT = """You are a real-time walking assistant for a blind person outdoors.

Analyze this camera image and give ONE short navigation instruction (max 15 words).

Priority rules (apply the FIRST matching rule):
1. Moving vehicle / car / bike heading toward person → {"guidance": "STOP — vehicle approaching", "is_danger": true}
2. Stairs going down / ledge / drop → {"guidance": "STEP DOWN — stairs ahead", "is_danger": true}
3. Large obstacle blocking path → {"guidance": "MOVE LEFT — obstacle" or "MOVE RIGHT — obstacle", "is_danger": true}
4. Red traffic light / signal → {"guidance": "STOP — red light", "is_danger": true}
5. Clear path ahead → {"guidance": "Path clear, continue forward", "is_danger": false}
6. Crosswalk / intersection → {"guidance": "Crosswalk ahead, wait for signal", "is_danger": false}
7. Door / entrance → {"guidance": "Door ahead on your left", "is_danger": false}
8. Narrow passage → {"guidance": "Narrow path, slow down", "is_danger": false}

Respond ONLY with a JSON object. No markdown, no explanation."""


async def guide_scan_frame(frame_bgr) -> Dict[str, Any]:
    """
    Analyze a camera frame for walking hazards using Gemini Vision.
    Returns {"guidance": str, "is_danger": bool}.
    """
    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not api_key:
        return {"guidance": "Guide mode unavailable — no API key.", "is_danger": False}

    import cv2
    _, encoded = cv2.imencode(".jpg", frame_bgr, [cv2.IMWRITE_JPEG_QUALITY, 70])
    img_b64 = base64.b64encode(encoded.tobytes()).decode("utf-8")

    # Use a fast/cheap model for the real-time loop
    model_name = os.getenv("GEMINI_GUIDE_MODEL", os.getenv("GEMINI_MODEL", "gemini-2.0-flash-lite"))

    if genai_new is not None:
        def _call() -> str:
            client = genai_new.Client(api_key=api_key)
            response = client.models.generate_content(
                model=model_name,
                contents=[{
                    "parts": [
                        {"text": _GUIDE_PROMPT},
                        {"inline_data": {"mime_type": "image/jpeg", "data": img_b64}},
                    ]
                }],
                config={"max_output_tokens": 80, "temperature": 0.1},
            )
            return (response.text or "").strip()
    elif genai is not None:
        def _call() -> str:
            genai.configure(api_key=api_key)
            model = genai.GenerativeModel(model_name)
            response = model.generate_content(
                [_GUIDE_PROMPT, {"mime_type": "image/jpeg", "data": img_b64}],
                generation_config={"max_output_tokens": 80, "temperature": 0.1},
            )
            return getattr(response, "text", "").strip()
    else:
        return {"guidance": "Gemini SDK not available.", "is_danger": False}

    try:
        raw = await asyncio.to_thread(_call)
        raw = raw.strip().lstrip("```json").lstrip("```").rstrip("```").strip()
        result = json.loads(raw)
        return {
            "guidance": str(result.get("guidance", "Continue forward.")),
            "is_danger": bool(result.get("is_danger", False)),
        }
    except Exception as e:
        print(f"[guide_scan_frame] ERROR: {e}")
        return {"guidance": "Continue with caution.", "is_danger": False}

