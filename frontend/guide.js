/**
 * EchoGuide — Guide Mode
 *
 * Captures a camera frame every 2 seconds, sends to /guide/scan,
 * and speaks back navigation guidance via ElevenLabs TTS.
 *
 * DANGER responses ("STOP", "STEP DOWN", "MOVE LEFT/RIGHT") immediately
 * interrupt any current audio for maximum safety.
 */

"use strict";

class GuideMode {
  constructor(videoEl, canvasEl, options = {}) {
    this._video    = videoEl;
    this._canvas   = canvasEl;
    this._timer    = null;
    this._active   = false;
    this._busy     = false;          // prevent overlapping requests
    this._curAudio = null;           // currently playing Audio element

    this.INTERVAL_MS    = options.intervalMs    || 2000;
    this._onGuidance    = options.onGuidance    || (() => {});  // (text, isDanger)
    this._onStateChange = options.onStateChange || (() => {});  // (active)
  }

  get active() { return this._active; }

  /** Start the real-time scanning loop. */
  start() {
    if (this._active) return;
    this._active = true;
    this._onStateChange(true);
    // First scan right away, then on interval
    this._scan();
    this._timer = setInterval(() => this._scan(), this.INTERVAL_MS);
    console.log("[Guide] started — interval", this.INTERVAL_MS, "ms");
  }

  /** Stop the loop and silence any playing audio. */
  stop() {
    if (!this._active) return;
    this._active = false;
    clearInterval(this._timer);
    this._timer = null;
    this._silence();
    this._onStateChange(false);
    console.log("[Guide] stopped");
  }

  // ── private ──────────────────────────────────────────────────────────────

  async _scan() {
    if (this._busy || !this._active) return;
    if (!this._video.videoWidth)     return;  // camera frame not ready yet

    this._busy = true;
    try {
      const blob = await this._captureBlob();
      const form = new FormData();
      form.append("image", blob, "guide.jpg");

      const res = await fetch("/guide/scan", { method: "POST", body: form });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      console.log("[Guide]", data.is_danger ? "⚠ DANGER" : "✓", data.guidance);
      this._onGuidance(data.guidance, data.is_danger);

      if (data.audio_base64) {
        this._playBase64Audio(data.audio_base64, data.is_danger);
      } else {
        this._speakFallback(data.guidance, data.is_danger);
      }
    } catch (err) {
      console.error("[Guide] scan error:", err);
    } finally {
      this._busy = false;
    }
  }

  _captureBlob() {
    const w = this._video.videoWidth;
    const h = this._video.videoHeight;
    this._canvas.width  = w;
    this._canvas.height = h;
    this._canvas.getContext("2d").drawImage(this._video, 0, 0, w, h);
    return new Promise((resolve, reject) =>
      this._canvas.toBlob(
        b => b ? resolve(b) : reject(new Error("Canvas toBlob failed")),
        "image/jpeg", 0.7
      )
    );
  }

  _playBase64Audio(b64, isDanger) {
    // Danger: always cut current speech first
    if (isDanger) this._silence();

    try {
      const bytes  = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const blob   = new Blob([bytes], { type: "audio/mpeg" });
      const url    = URL.createObjectURL(blob);
      const audio  = new Audio(url);
      audio.volume = isDanger ? 1.0 : 0.9;
      audio.play().catch(e => {
        console.warn("[Guide] audio play blocked:", e);
        this._speakFallback(null, isDanger);  // silent fallback — audio already spoken server-side
      });
      audio.onended = () => URL.revokeObjectURL(url);
      this._curAudio = audio;
    } catch (e) {
      console.error("[Guide] audio decode error:", e);
    }
  }

  _speakFallback(text, isDanger) {
    const synth = window.speechSynthesis;
    if (!synth || !text) return;
    if (isDanger) synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate   = isDanger ? 1.3 : 1.05;
    u.volume = 1.0;
    synth.speak(u);
  }

  _silence() {
    if (this._curAudio) {
      this._curAudio.pause();
      this._curAudio.currentTime = 0;
      this._curAudio = null;
    }
    window.speechSynthesis?.cancel();
  }
}
