/**
 * EchoGuide — Guide Mode
 *
 * Captures a camera frame every 2 seconds, sends to /guide/scan,
 * and speaks back navigation guidance via Web Speech API.
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
    this._scanCount = 0;
    this._lastMessage = null;

    // Keep scan loop fast for responsive object updates.
    this.INTERVAL_MS    = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : 300;
    this._onGuidance    = options.onGuidance    || (() => {});  // (text, isDanger)
    this._onDetections  = options.onDetections  || (() => {});  // (detections)
    this._onScanLog     = options.onScanLog     || (() => {});  // (entry: object)
    this._onStateChange = options.onStateChange || (() => {});  // (active)
  }

  get active() { return this._active; }

  /** Start the real-time scanning loop. */
  start() {
    if (this._active) return;
    this._active = true;
    this._scanCount = 0;
    this._lastMessage = null;
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
    this._lastMessage = null;
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
      const processed = this._processGuideResponse(data);
      const message = processed.message;
      const direction = processed.direction;
      const isDanger = processed.isDanger;
      const detectionCount = processed.detections.length;
      const hasNewSpeech = processed.hasNewSpeech;

      console.log(
        `[GuideSession] Scan #${scanId} response`,
        { message, direction, distance: data.distance, isDanger, statusCode: res.status }
      );
      this._onGuidance(message || "", isDanger);
      this._onScanLog({
        id: scanId,
        guidance: message || "",
        isDanger,
        detectionCount: detectionCount || data.detection_count || 0,
      });
      if (hasNewSpeech) {
        console.log(`[GuideSession] Scan #${scanId} spoke message:`, message);
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

  _processGuideResponse(data) {
    const detections = Array.isArray(data?.detections) ? data.detections : [];
    this._onDetections(detections);

    const message = data?.message || null;
    const direction = data?.direction || null;
    const isDanger = data?.is_danger === true
      || (typeof message === "string" && message.includes("Warning. You are now in the danger zone for this obstacle."));
    const hasNewSpeech = this._handleSpeech(data);

    return { detections, message, direction, isDanger, hasNewSpeech };
  }

  _handleSpeech(data) {
    const message = data?.message || null;
    if (!message || message === this._lastMessage) return false;
    this.speak(message);
    this._lastMessage = message;
    return true;
  }

  speak(text) {
    if (!text) return;
    const synth = window.speechSynthesis;
    if (!synth) return;
    const u = new SpeechSynthesisUtterance(text);
    u.rate   = 1;
    u.pitch  = 1;
    u.volume = 1;
    synth.cancel();
    synth.speak(u);
  }

  _silence() {
    window.speechSynthesis?.cancel();
  }
}
