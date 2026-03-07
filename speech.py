"""Speech helper module."""

from __future__ import annotations

from typing import Optional, Tuple

from .elevenlabs_api import synthesize_speech


def text_to_speech_bytes(text: str) -> Optional[bytes]:
    """
    Convert text to speech and return mp3 bytes.
    Frontend can use this to create an audio Blob.
    """
    text_clean = (text or "").strip()
    return synthesize_speech(text_clean)
