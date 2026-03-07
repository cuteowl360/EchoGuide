/**
 * EchoGuide – Voice Command Module
 *
 * Uses the browser's built-in Web Speech API for speech-to-text (no key needed).
 * After the wake word "Echo" is detected, the phrase is sent to the backend
 * which uses Gemini to understand the intent — handling unlimited variations,
 * accents, and casual phrasing.
 *
 * Wake word: "echo" (or "hey echo", "ok echo", "yo echo" etc.)
 *
 * Examples — all understood:
 *   "Echo, what's in front of me?"
 *   "Echo can you read that sign"
 *   "Echo I need to go to the hospital"
 *   "Echo save this person, her name is Sarah"
 *   "Echo who is this?"
 *   "Echo turn on the camera"
 *   "Echo stop"
 */

"use strict";

const WAKE_WORD = "echo";

class VoiceCommander {
  constructor() {
    this._rec          = null;
    this._active       = false;
    this._awaitingName = false;
    this._onCommand    = null;
    this._onChange     = null;
    this.supported     = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  start(onCommand, onStateChange) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return false;

    this._onCommand = onCommand;
    this._onChange  = onStateChange || (() => {});

    this._rec = new SR();
    this._rec.continuous      = true;
    this._rec.interimResults  = false;
    this._rec.lang            = "en-US";
    this._rec.maxAlternatives = 3; // try multiple alternatives for better wake-word detection

    this._rec.onresult = (e) => {
      // Collect all alternatives for each new result
      const results = Array.from(e.results).slice(e.resultIndex);
      for (const result of results) {
        const alternatives = Array.from(result).map(a => a.transcript.trim().toLowerCase());
        for (const transcript of alternatives) {
          if (this._process(transcript)) break;
        }
      }
    };

    this._rec.onend = () => {
      if (this._active) {
        setTimeout(() => { try { this._rec.start(); } catch (_) {} }, 200);
      }
    };

    this._rec.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      if (e.error === "not-allowed") {
        this._active = false;
        this._onChange("error");
        return;
      }
      if (this._active) {
        setTimeout(() => { try { this._rec.start(); } catch (_) {} }, 1000);
      }
    };

    this._active = true;
    try {
      this._rec.start();
      this._onChange("listening");
      return true;
    } catch (_) {
      this._active = false;
      return false;
    }
  }

  stop() {
    this._active       = false;
    this._awaitingName = false;
    try { this._rec?.stop(); } catch (_) {}
    this._onChange?.("stopped");
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /** Returns true if the transcript was acted upon. */
  _process(transcript) {
    // If we're waiting for a follow-up name, capture it immediately
    if (this._awaitingName) {
      this._awaitingName = false;
      const name = transcript.trim();
      if (name) this._onCommand("remember_person", { name });
      return true;
    }

    // Accept "echo", "hey echo", "ok echo", "yo echo", "okay echo"
    const wakeMatch = transcript.match(/\b(?:hey |ok(?:ay)? |yo )?echo[,.]?\s*(.*)/);
    if (!wakeMatch) return false;

    const phrase = wakeMatch[1].trim();
    if (!phrase) return false; // just heard the wake word alone, wait for more

    this._handlePhrase(phrase);
    return true;
  }

  async _handlePhrase(phrase) {
    // Try instant local match first (zero latency for very obvious commands)
    const instant = this._instantMatch(phrase);
    if (instant) {
      this._dispatch(instant.intent, instant.params);
      return;
    }

    // Fall back to Gemini for anything ambiguous
    try {
      const res = await fetch("/voice/interpret", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phrase }),
      });
      if (!res.ok) throw new Error("interpret failed");
      const data = await res.json();
      this._dispatch(data.intent || "unknown", data.params || {});
    } catch (_) {
      this._dispatch("unknown", { raw: phrase });
    }
  }

  /** Lightning-fast regex for dead-obvious one-word commands. */
  _instantMatch(cmd) {
    // Hard stop — never mis-fire
    if (/^\s*stop\s*$/.test(cmd))           return { intent: "stop_navigation", params: {} };
    if (/^\s*help\s*$/.test(cmd))           return { intent: "help", params: {} };
    if (/^\s*(?:scan|describe|look)\s*$/.test(cmd)) return { intent: "scan_scene", params: {} };
    return null;
  }

  _dispatch(intent, params) {
    switch (intent) {
      case "remember_person":
        if (!params.name) {
          this._onCommand("ask_for_name", {});
          this._awaitingName = true;
          return;
        }
        break;
    }
    this._onCommand(intent, params);
  }
}

const voiceCommander = new VoiceCommander();


class VoiceCommander {
  constructor() {
    this._rec          = null;
    this._active       = false;
    this._awaitingName = false; // true when waiting for a follow-up person name
    this._onCommand    = null;
    this._onChange     = null;
    this.supported     = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  /**
   * Start listening continuously.
   * @param {function} onCommand    - called as onCommand(type, params)
   * @param {function} onStateChange - called with "listening" | "stopped" | "error"
   */
  start(onCommand, onStateChange) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return false;

    this._onCommand = onCommand;
    this._onChange  = onStateChange || (() => {});

    this._rec = new SR();
    this._rec.continuous      = true;
    this._rec.interimResults  = false;
    this._rec.lang            = "en-US";
    this._rec.maxAlternatives = 1;

    this._rec.onresult = (e) => {
      const transcript = Array.from(e.results)
        .slice(e.resultIndex)
        .map(r => r[0].transcript.trim().toLowerCase())
        .join(" ");
      this._process(transcript);
    };

    // Auto-restart so it never stops listening
    this._rec.onend = () => {
      if (this._active) {
        setTimeout(() => { try { this._rec.start(); } catch (_) {} }, 200);
      }
    };

    this._rec.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      if (e.error === "not-allowed") {
        this._active = false;
        this._onChange("error");
        return;
      }
      if (this._active) {
        setTimeout(() => { try { this._rec.start(); } catch (_) {} }, 1000);
      }
    };

    this._active = true;
    try {
      this._rec.start();
      this._onChange("listening");
      return true;
    } catch (_) {
      this._active = false;
      return false;
    }
  }

  stop() {
    this._active       = false;
    this._awaitingName = false;
    try { this._rec?.stop(); } catch (_) {}
    this._onChange?.("stopped");
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  _process(transcript) {
    // If we asked "what's the name?", the very next utterance IS the name
    if (this._awaitingName) {
      this._awaitingName = false;
      const name = transcript.trim();
      if (name) this._onCommand("remember_person", { name });
      return;
    }

    const idx = transcript.indexOf(WAKE_WORD);
    if (idx === -1) return;

    const after = transcript.slice(idx + WAKE_WORD.length).trim();
    if (!after) return; // heard "echo" alone — wait for next phrase

    this._route(after);
  }

  _route(cmd) {
    let m;

    // ── Navigate to <place>
    if ((m = cmd.match(/\b(?:navigate to|go to|take me to|get to|directions? to|how do i (?:get|go) to)\s+(.+)/))) {
      this._onCommand("navigate", { destination: m[1].trim() });
      return;
    }

    // ── Scan / describe scene
    if (cmd.match(/\b(?:scan|describe|look|what(?:'s| is) (?:around|in front|there|this)|what do you see|scene)\b/)) {
      this._onCommand("scan_scene", {});
      return;
    }

    // ── Read text / OCR
    if (cmd.match(/\b(?:read(?: (?:the )?text)?|what does (?:it|this) say|text|ocr)\b/)) {
      this._onCommand("read_text", {});
      return;
    }

    // ── Identify person
    if (cmd.match(/\b(?:who (?:is|are) (?:this|that)|identify|who(?:'s| is) there|recognize)\b/)) {
      this._onCommand("identify_person", {});
      return;
    }

    // ── Remember / save person
    if ((m = cmd.match(/\b(?:remember|save)(?: this)?(?: (?:person|face))?(?: (?:as|named?))?\s+(.+)/)) ||
        (m = cmd.match(/\bthis is\s+(.+)/))) {
      const raw = (m[1] || "").trim();
      const stopWords = /^(this|the|a|an|person|face|man|woman|guy|lady|someone|them)$/i;
      const name = raw.split(/\s+/).filter(w => !stopWords.test(w)).join(" ").trim();
      if (name) {
        this._onCommand("remember_person", { name });
      } else {
        this._onCommand("ask_for_name", {});
        this._awaitingName = true;
      }
      return;
    }

    // ── Start camera
    if (cmd.match(/\b(?:start|open|turn on|activate)(?: the)? camera\b/)) {
      this._onCommand("start_camera", {});
      return;
    }

    // ── Stop camera
    if (cmd.match(/\b(?:stop|close|turn off)(?: the)? camera\b/)) {
      this._onCommand("stop_camera", {});
      return;
    }

    // ── Stop navigation (or generic "stop")
    if (cmd.match(/\b(?:stop(?: (?:the )?nav(?:igation)?)?|cancel(?: (?:the )?nav(?:igation)?)?|end(?: (?:the )?nav(?:igation)?)?)\b/)) {
      this._onCommand("stop_navigation", {});
      return;
    }

    // ── Help
    if (cmd.match(/\b(?:help|what can you do|commands?|what are my options)\b/)) {
      this._onCommand("help", {});
      return;
    }

    // ── Not understood
    this._onCommand("unknown", { raw: cmd });
  }
}

const voiceCommander = new VoiceCommander();
