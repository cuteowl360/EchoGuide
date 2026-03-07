"""ElevenLabs client for generating speech."""

from __future__ import annotations

import base64
import json
import logging
import os
from typing import Optional

import requests

logger = logging.getLogger(__name__)

DEFAULT_VOICE_ID = "EXAVITQu4vr4xnSDxMaLz"
ELEVENLABS_URL = "https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"


def is_available() -> bool:
    """Return True if ElevenLabs credentials are configured."""
    return bool(os.getenv("ELEVENLABS_API_KEY"))


def synthesize_speech(text: str, voice_id: Optional[str] = None) -> Optional[bytes]:
    """
    Convert text to speech and return mp3 bytes.
    """
    cleaned = (text or "").strip()
    if not cleaned:
        return b""

    api_key = os.getenv("ELEVENLABS_API_KEY", "").strip()
    if not api_key:
        return None

    try:
        # Try official SDK if installed.
        from elevenlabs.client import ElevenLabs
    except Exception:
        return _synthesize_via_http(cleaned, api_key, voice_id)

    try:
        voice = voice_id or os.getenv("ELEVENLABS_VOICE_ID", DEFAULT_VOICE_ID)
        stability = float(os.getenv("ELEVENLABS_STABILITY", "0.45"))
        similarity = float(os.getenv("ELEVENLABS_SIMILARITY", "0.65"))

        client = ElevenLabs(api_key=api_key)
        audio_data = client.generate(
            text=cleaned[:1800],
            voice=voice,
            model=os.getenv("ELEVENLABS_TTS_MODEL", "eleven_multilingual_v2"),
            voice_settings={"stability": stability, "similarity_boost": similarity},
        )
        if isinstance(audio_data, (bytes, bytearray)):
            return bytes(audio_data)

        # SDK may stream bytes; gather them if needed.
        return b"".join(chunk for chunk in audio_data)
    except Exception:
        return _synthesize_via_http(cleaned, api_key, voice_id)


def _synthesize_via_http(text: str, api_key: str, voice_id: Optional[str] = None) -> Optional[bytes]:
    """Fallback HTTP path to ElevenLabs."""
    voice = (voice_id or os.getenv("ELEVENLABS_VOICE_ID", DEFAULT_VOICE_ID)).strip()
    if not voice:
        voice = DEFAULT_VOICE_ID

    payload = {
        "text": text[:1800],
        "model_id": os.getenv("ELEVENLABS_TTS_MODEL", "eleven_multilingual_v2"),
        "voice_settings": {
            "stability": float(os.getenv("ELEVENLABS_STABILITY", "0.45")),
            "similarity_boost": float(os.getenv("ELEVENLABS_SIMILARITY", "0.65")),
            "use_speaker_boost": True,
        },
    }

    headers = {
        "xi-api-key": api_key,
        "accept": "audio/mpeg",
        "content-type": "application/json",
    }

    try:
        response = requests.post(
            ELEVENLABS_URL.format(voice_id=voice),
            headers=headers,
            data=json.dumps(payload),
            timeout=30,
        )
    except Exception as exc:
        logger.exception("ElevenLabs request failed: %s", exc)
        return None

    if response.status_code != 200:
        return None

    if not response.content:
        return b""

    return response.content
