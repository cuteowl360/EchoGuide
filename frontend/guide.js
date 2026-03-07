/**
 * EchoGuide — Guide Mode
 *
 * Captures a camera frame every 2 seconds, sends to /guide/scan,
 * and speaks back navigation guidance via ElevenLabs TTS.
 *
 * Safety guarantees:
 *   • DANGER messages always interrupt any playing audio immediately.
 *   • Speech deduplication: identical non-danger messages within 5 s are silently skipped.
 *   • Cooldown: non-danger speech fires at most once every 2 s.
 *   • emergencyStop(): silences everything and halts the loop.
 */

"use strict";

const SPEECH_COOLDOWN_MS  = 2000;   // min gap between non-danger utterances
const SPEECH_DEDUP_MS     = 5000;   // suppress identical message within this window

class GuideMode {
  constructor(videoEl, canvasEl, options = {}) {
    this._video    = videoEl;
    this._canvas   = canvasEl;
    this._timer    = null;
    this._active   = false;
    this._busy     = false;
    this._curAudio = null;
    this._target   = "";

    // Speech dedup / cooldown state
    this._lastSpokenText  = "";
    this._lastSpokenTime  = 0;       // Date.now() of last speech output

    this.INTERVAL_MS     = options.intervalMs    || 2000;
    this._onGuidance     = options.onGuidance    || (() => {});
    this._onStateChange  = options.onStateChange || (() => {});
    this._onTargetChange = options.onTargetChange || (() => {});
  }

  get active() { return this._active; }
  get target() { return this._target; }

  /** Set or clear the target the user is trying to find. */
  setTarget(target) {
    this._target = (target || "").trim().toLowerCase();
    this._onTargetChange(this._target);
    if (this._active) this._scan();
  }

  /** Start the real-time scanning loop. */
  start(target) {
    if (this._active) return;
    if (target !== undefined) this._target = (target || "").trim().toLowerCase();
    this._active = true;
    this._onStateChange(true);
    this._scan();
    this._timer = setInterval(() => this._scan(), this.INTERVAL_MS);
    console.log("[Guide] started — interval", this.INTERVAL_MS, "ms, target:", this._target || "(none)");
  }

  /** Stop the loop and silence any playing audio. */
  stop() {
    if (!this._active) return;
    this._active = false;
    this._target = "";
    this._lastSpokenText = "";
    clearInterval(this._timer);
    this._timer = null;
    this._silence();
    this._onStateChange(false);
    this._onTargetChange("");
    console.log("[Guide] stopped");
  }

  /**
   * Emergency stop — immediately silences all audio, halts guide loop.
   * Called by voice command "Echo stop", "Stop Echo", etc.
   */
  emergencyStop() {
    this._silence();
    if (this._active) this.stop();
    console.log("[Guide] EMERGENCY STOP");
  }

  // ── private ──────────────────────────────────────────────────────────────

  async _scan() {
    if (this._busy || !this._active) return;
    if (!this._video.videoWidth)     return;

    this._busy = true;
    try {
      const blob = await this._captureBlob();
      const form = new FormData();
      form.append("image", blob, "guide.jpg");
      if (this._target) form.append("target", this._target);

      const res = await fetch("/guide/scan", { method: "POST", body: form });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      const { guidance, is_danger, target_found, approaching } = data;
      console.log("[Guide]", is_danger ? "⚠ DANGER" : "✓", guidance,
        approaching?.length ? `| approaching: ${approaching.join(", ")}` : "");

      this._onGuidance(guidance, is_danger, target_found);

      // ── Speech deduplication + cooldown ──────────────────────────────────
      const shouldSpeak = this._shouldSpeak(guidance, is_danger);
      if (!shouldSpeak) {
        console.log("[Guide] speech suppressed (dedup/cooldown):", guidance.slice(0, 40));
      } else {
        this._lastSpokenText = guidance;
        this._lastSpokenTime = Date.now();
        if (data.audio_base64) {
          this._playBase64Audio(data.audio_base64, is_danger);
        } else {
          this._speakFallback(guidance, is_danger);
        }
      }
    } catch (err) {
      console.error("[Guide] scan error:", err);
    } finally {
      this._busy = false;
    }
  }

  /**
   * Returns true only when the message should actually be spoken.
   * DANGER messages always pass. Non-danger messages are filtered by:
   *   1. cooldown — max one utterance per SPEECH_COOLDOWN_MS
   *   2. dedup    — identical text within SPEECH_DEDUP_MS is skipped
   */
  _shouldSpeak(text, isDanger) {
    if (isDanger) return true;   // safety warnings always get through
    const now  = Date.now();
    const gap  = now - this._lastSpokenTime;
    if (gap < SPEECH_COOLDOWN_MS) return false;
    if (text === this._lastSpokenText && gap < SPEECH_DEDUP_MS) return false;
    return true;
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
    if (isDanger) this._silence();
    try {
      const bytes  = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const blob   = new Blob([bytes], { type: "audio/mpeg" });
      const url    = URL.createObjectURL(blob);
      const audio  = new Audio(url);
      audio.volume = isDanger ? 1.0 : 0.9;
      audio.play().catch(e => {
        console.warn("[Guide] audio play blocked:", e);
        this._speakFallback(null, isDanger);
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
    const u   = new SpeechSynthesisUtterance(text);
    u.rate    = isDanger ? 1.3 : 1.05;
    u.volume  = 1.0;
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
