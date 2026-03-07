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
    this._scanCount = 0;
    this._lastSpokenAt = 0;
    this._announceIntervalMs = Number.isFinite(Number(options.guideAnnouncementIntervalMs))
      ? Number(options.guideAnnouncementIntervalMs)
      : 2000;
    this._announceIntervalMs = Math.max(2000, Number(this._announceIntervalMs));

    // Guide mode cadence and announcement throttle.
    this.INTERVAL_MS    = 2000;
    this._onGuidance    = options.onGuidance    || (() => {});  // (text, isDanger)
    this._onScanLog     = options.onScanLog     || (() => {});  // (entry: object)
    this._onStateChange = options.onStateChange || (() => {});  // (active)
  }

  get active() { return this._active; }

  /** Start the real-time scanning loop. */
  start() {
    if (this._active) return;
    this._active = true;
    this._scanCount = 0;
    this._lastSpokenAt = 0;
    console.log("[GuideSession] started");
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
    console.log("[GuideSession] stopped");
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
      this._scanCount += 1;
      const scanId = this._scanCount;
      console.log(`[GuideSession] Scan #${scanId} start`, new Date().toISOString());
      const blob = await this._captureBlob();
      const form = new FormData();
      form.append("image", blob, "guide.jpg");

      const res = await fetch("/guide/scan", { method: "POST", body: form });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      const now = Date.now();
      const guidance = data.guidance || "";
      const hasAudio = Boolean(data.audio_base64);
      const shouldAnnounce = (now - this._lastSpokenAt) >= this._announceIntervalMs;

      console.log(
        `[GuideSession] Scan #${scanId} response`,
        {
          isDanger: data.is_danger,
          guidance,
          hasAudio,
          statusCode: res.status,
        }
      );
      this._onGuidance(guidance, data.is_danger);
      this._onScanLog({
        id: scanId,
        guidance,
        isDanger: data.is_danger,
        detectionCount: data.detection_count ?? null,
      });
      if (shouldAnnounce && hasAudio) {
        this._playBase64Audio(data.audio_base64, data.is_danger);
        this._lastSpokenAt = now;
      } else if (shouldAnnounce) {
        this._speakFallback(data.guidance, data.is_danger);
        this._lastSpokenAt = now;
      }

      if (!shouldAnnounce) {
        console.log(`[GuideSession] Scan #${scanId} silence (throttled):`, guidance);
      }
    } catch (err) {
      const scanId = this._scanCount;
      console.error(`[GuideSession] Scan #${scanId} error:`, err);
    } finally {
      this._busy = false;
    }
  }

  _captureBlob() {
    const targetWidth = Math.min(this._video.videoWidth, 640);
    const targetHeight = Math.round((targetWidth * this._video.videoHeight) / this._video.videoWidth);
    this._canvas.width  = targetWidth;
    this._canvas.height = targetHeight;
    this._canvas.getContext("2d").drawImage(this._video, 0, 0, targetWidth, targetHeight);
    return new Promise((resolve, reject) =>
      this._canvas.toBlob(
        b => b ? resolve(b) : reject(new Error("Canvas toBlob failed")),
        "image/jpeg", 0.55
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
