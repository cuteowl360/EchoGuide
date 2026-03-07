"""Webcam OCR text reader.

Dependencies:
  pip install opencv-python pytesseract pyttsx3

Make sure Tesseract OCR is installed and configure the path below if needed:
  # pytesseract.pytesseract.tesseract_cmd = r"C:\\Program Files\\Tesseract-OCR\\tesseract.exe"
"""

from __future__ import annotations

import re
import sys
import time

import cv2
import pyttsx3
import pytesseract


# Optional: set this if Tesseract is not on PATH.
# Example (Windows):
# pytesseract.pytesseract.tesseract_cmd = r"C:\\Program Files\\Tesseract-OCR\\tesseract.exe"


def speak_text(engine: pyttsx3.Engine, text: str) -> None:
    """Speak non-empty text using the provided TTS engine."""
    text = text.strip()
    if not text:
        return
    engine.say(text)
    engine.runAndWait()


def clean_text(text: str) -> str:
    """Normalize whitespace in OCR output."""
    return re.sub(r"\s+", " ", text.strip())


def main() -> int:
    try:
        engine = pyttsx3.init()
    except Exception as exc:  # pragma: no cover
        print(f"Failed to initialize TTS engine: {exc}", file=sys.stderr)
        return 1

    cap = cv2.VideoCapture(0)
    if not cap.isOpened():
        print("Could not open webcam. Please check your camera/device index.", file=sys.stderr)
        return 1

    last_spoken = ""
    last_speak_time = 0.0
    speak_interval = 2.0

    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                print("Failed to read frame from webcam.")
                break

            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            gray = cv2.resize(gray, None, fx=1.5, fy=1.5, interpolation=cv2.INTER_CUBIC)
            gray = cv2.bilateralFilter(gray, 11, 17, 17)
            _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

            try:
                raw_text = pytesseract.image_to_string(thresh, config="--oem 3 --psm 6")
            except Exception as exc:
                print(f"OCR error: {exc}", file=sys.stderr)
                raw_text = ""

            text = clean_text(raw_text)
            now = time.time()
            if text and text != last_spoken and (now - last_speak_time) >= speak_interval:
                print(f"Detected text: {text}")
                speak_text(engine, text)
                last_spoken = text
                last_speak_time = now

            cv2.imshow("Camera - Press Q to Quit", frame)

            if cv2.waitKey(1) & 0xFF == ord("q"):
                break
    finally:
        cap.release()
        cv2.destroyAllWindows()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
