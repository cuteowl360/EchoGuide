"""TTS client supporting both Amazon Polly and ElevenLabs."""

from __future__ import annotations

import json
import logging
import os
from typing import Optional

import requests
try:
    import boto3
except Exception:  # pragma: no cover - optional dependency
    boto3 = None

logger = logging.getLogger(__name__)

DEFAULT_VOICE_ID = "EXAVITQu4vr4xnSDxMaLz"
ELEVENLABS_URL = "https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
DEFAULT_TTS_PROVIDER = "polly"
DEFAULT_POLLY_VOICE_ID = "Joanna"

_POLLY_CLIENT = None


def _tts_provider() -> str:
    return (os.getenv("TTS_PROVIDER", DEFAULT_TTS_PROVIDER).strip().lower() or DEFAULT_TTS_PROVIDER)


def _load_polly_client():
    global _POLLY_CLIENT
    if _POLLY_CLIENT is not None:
        return _POLLY_CLIENT
    if boto3 is None:
        return None
    try:
        region = (os.getenv("POLLY_REGION") or os.getenv("AWS_REGION") or "us-east-1").strip()
        session = boto3.session.Session()
        _POLLY_CLIENT = session.client("polly", region_name=region)
        return _POLLY_CLIENT
    except Exception:
        logger.exception("Failed to initialize Amazon Polly client.")
        _POLLY_CLIENT = None
        return None


def is_available() -> bool:
    """Return True if configured TTS provider can be used."""
    provider = _tts_provider()
    if provider == "polly":
        return _load_polly_client() is not None
    if provider == "elevenlabs":
        return bool(os.getenv("ELEVENLABS_API_KEY"))
    return (_load_polly_client() is not None) or bool(os.getenv("ELEVENLABS_API_KEY"))


def synthesize_speech(text: str, voice_id: Optional[str] = None) -> Optional[bytes]:
    """
    Convert text to speech and return mp3 bytes.
    """
    cleaned = (text or "").strip()
    if not cleaned:
        return b""

    provider = _tts_provider()
    if provider == "polly":
        audio = _synthesize_via_polly(cleaned)
        if audio is not None:
            return audio
        return _synthesize_via_elevenlabs(cleaned, voice_id)
    if provider == "elevenlabs":
        audio = _synthesize_via_elevenlabs(cleaned, voice_id)
        if audio is not None:
            return audio
        return _synthesize_via_polly(cleaned)

    # auto/unknown: prefer Polly first, then ElevenLabs.
    audio = _synthesize_via_polly(cleaned)
    if audio is not None:
        return audio
    return _synthesize_via_elevenlabs(cleaned, voice_id)


def _synthesize_via_polly(text: str) -> Optional[bytes]:
    client = _load_polly_client()
    if client is None:
        return None

    voice = (os.getenv("POLLY_VOICE_ID", DEFAULT_POLLY_VOICE_ID).strip() or DEFAULT_POLLY_VOICE_ID)
    engine = (os.getenv("POLLY_ENGINE", "neural").strip() or "neural")
    engine = engine if engine in {"standard", "neural", "long-form", "generative"} else "neural"

    try:
        resp = client.synthesize_speech(
            Text=text[:3000],
            OutputFormat="mp3",
            VoiceId=voice,
            Engine=engine,
        )
        stream = resp.get("AudioStream")
        if stream is None:
            return b""
        audio = stream.read()
        return audio if audio else b""
    except Exception:
        logger.exception("Amazon Polly synthesis failed.")
        return None


def _synthesize_via_elevenlabs(text: str, voice_id: Optional[str] = None) -> Optional[bytes]:
    api_key = os.getenv("ELEVENLABS_API_KEY", "").strip()
    if not api_key:
        return None
    try:
        # Try official SDK if installed.
        from elevenlabs.client import ElevenLabs
    except Exception:
        return _synthesize_via_http(text, api_key, voice_id)

    try:
        voice = voice_id or os.getenv("ELEVENLABS_VOICE_ID", DEFAULT_VOICE_ID)
        stability = float(os.getenv("ELEVENLABS_STABILITY", "0.45"))
        similarity = float(os.getenv("ELEVENLABS_SIMILARITY", "0.65"))

        client = ElevenLabs(api_key=api_key)
        audio_data = client.generate(
            text=text[:1800],
            voice=voice,
            model=os.getenv("ELEVENLABS_TTS_MODEL", "eleven_multilingual_v2"),
            voice_settings={"stability": stability, "similarity_boost": similarity},
        )
        if isinstance(audio_data, (bytes, bytearray)):
            return bytes(audio_data)
        return b"".join(chunk for chunk in audio_data)
    except Exception:
        return _synthesize_via_http(text, api_key, voice_id)


def _synthesize_via_http(text: str, api_key: str, voice_id: Optional[str] = None) -> Optional[bytes]:
    """HTTP fallback path to ElevenLabs."""
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
