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
    this._lastSpokenObject = null;
    this._lastPlayedTtsMessage = null;
    this._activeAudio = null;
    this._onAssignName = options.onAssignName || null; // async ({name, signature}) -> {ok, name}
    this._namedSignatures = new Set();
    this._lastNameAttemptAt = new Map();
    this._nameFlowInProgress = false;

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
    this._lastSpokenObject = null;
    this._lastPlayedTtsMessage = null;
    this._namedSignatures.clear();
    this._lastNameAttemptAt.clear();
    this._nameFlowInProgress = false;
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
    this._lastPlayedTtsMessage = null;
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
    this._maybeTriggerVoiceNaming(detections);

    const message = data?.message || null;
    const direction = data?.direction || null;
    const isDanger = data?.is_danger === true
      || (typeof message === "string" && message.includes("Warning. You are now in the danger zone for this obstacle."));
    const hasNewSpeech = this._handleSpeech(data);

    return { detections, message, direction, isDanger, hasNewSpeech };
  }

  _handleSpeech(data) {
    const objects = Array.isArray(data?.objects) ? data.objects : [];
    const firstObject = typeof objects[0] === "string" ? objects[0].trim().toLowerCase() : "";
    if (firstObject && firstObject !== this._lastSpokenObject) {
      void this.playTTS(`${firstObject} detected.`);
      this._lastSpokenObject = firstObject;
      return true;
    }

    const message = data?.message || null;
    if (!message || message === this._lastMessage) return false;
    void this.playTTS(message);
    this._lastMessage = message;
    return true;
  }

  _normalizeBBox(item) {
    const bb = item?.bbox;
    if (!bb || typeof bb !== "object") return null;
    const x1 = Number(bb.x1);
    const y1 = Number(bb.y1);
    const x2 = Number(bb.x2);
    const y2 = Number(bb.y2);
    if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
    return { x1, y1, x2, y2 };
  }

  _signatureForDetection(item) {
    const label = String(item?.label || "").trim().toLowerCase();
    const bb = this._normalizeBBox(item);
    if (!label || !bb) return null;
    const round = (v) => Math.round(v / 10) * 10;
    return `${label}|${round(bb.x1)}:${round(bb.y1)}:${round(bb.x2)}:${round(bb.y2)}`;
  }

  _isPersonLikeLabel(label) {
    const v = String(label || "").trim().toLowerCase();
    return v === "person" || v === "human" || v === "man" || v === "woman";
  }

  _pickUnnamedPersonDetection(detections) {
    for (const item of detections) {
      if (!this._isPersonLikeLabel(item?.label)) continue;
      const signature = this._signatureForDetection(item);
      if (!signature) continue;
      if (this._namedSignatures.has(signature)) continue;
      const lastAttemptAt = Number(this._lastNameAttemptAt.get(signature) || 0);
      if (Date.now() - lastAttemptAt < 12000) continue;
      return { item, signature };
    }
    return null;
  }

  _maybeTriggerVoiceNaming(detections) {
    if (!Array.isArray(detections) || !detections.length) return;
    if (!this._active || this._nameFlowInProgress) return;
    if (typeof this._onAssignName !== "function") return;

    const candidate = this._pickUnnamedPersonDetection(detections);
    if (!candidate) return;
    this._nameFlowInProgress = true;
    void this._runVoiceNamingFlow(candidate.signature).finally(() => {
      this._nameFlowInProgress = false;
    });
  }

  _listenForName(timeoutMs = 6000) {
    return new Promise((resolve) => {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) {
        resolve(null);
        return;
      }

      let settled = false;
      const rec = new SR();
      rec.lang = "en-US";
      rec.continuous = false;
      rec.interimResults = false;
      rec.maxAlternatives = 1;

      const done = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { rec.stop(); } catch (_) {}
        resolve(value);
      };

      rec.onresult = (ev) => {
        const raw = ev?.results?.[0]?.[0]?.transcript || "";
        const cleaned = String(raw).replace(/[^\w\s'-]/g, "").trim();
        done(cleaned || null);
      };
      rec.onerror = () => done(null);
      rec.onend = () => done(null);

      const timer = setTimeout(() => done(null), timeoutMs);
      try {
        rec.start();
      } catch (_) {
        done(null);
      }
    });
  }

  async _runVoiceNamingFlow(signature) {
    this._lastNameAttemptAt.set(signature, Date.now());
    await this.playTTS("Please say the name of this person.", { dedupe: false });

    let spokenName = await this._listenForName(6000);
    if (!spokenName) {
      await this.playTTS("I did not catch the name. Please say it again.", { dedupe: false });
      spokenName = await this._listenForName(6000);
    }
    if (!spokenName) {
      await this.playTTS("Name capture failed. You can retry or use the remember button.", { dedupe: false });
      return;
    }

    try {
      const result = await this._onAssignName({ name: spokenName, signature });
      if (result?.ok) {
        const savedName = String(result.name || spokenName).trim();
        this._namedSignatures.add(signature);
        await this.playTTS(`Name recorded as ${savedName}.`, { dedupe: false });
        return;
      }
      await this.playTTS("I could not save the name. Please try again.", { dedupe: false });
    } catch (err) {
      console.error("[Guide] name assignment failed:", err);
      await this.playTTS("I could not save the name. Please try again.", { dedupe: false });
    }
  }

  async playTTS(text, options = {}) {
    if (!text) return;
    const normalized = String(text).trim();
    const dedupe = options?.dedupe !== false;
    if (dedupe && normalized === this._lastPlayedTtsMessage) return;
    try {
      const response = await fetch("/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: normalized }),
      });
      if (!response.ok) {
        throw new Error(`Backend /speak HTTP ${response.status}`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      if (this._activeAudio) {
        try { this._activeAudio.pause(); } catch (_) {}
      }
      const audio = new Audio(url);
      this._activeAudio = audio;
      audio.onended = () => URL.revokeObjectURL(url);
      audio.onerror = () => URL.revokeObjectURL(url);
      await audio.play();
      this._lastPlayedTtsMessage = normalized;
    } catch (err) {
      console.error("[Guide] TTS playback failed:", err);
      this.speak(normalized);
    }
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
    if (this._activeAudio) {
      try { this._activeAudio.pause(); } catch (_) {}
      this._activeAudio = null;
    }
    window.speechSynthesis?.cancel();
  }
}
