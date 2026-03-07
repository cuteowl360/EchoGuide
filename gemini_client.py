"""Gemini client for multimodal scene understanding."""

from __future__ import annotations

import asyncio
import base64
import os
from typing import Any, Dict, List, Sequence

try:
    import google.generativeai as genai
except Exception:  # pragma: no cover - optional dependency
    genai = None

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
