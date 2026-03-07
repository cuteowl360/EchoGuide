/**
 * EchoGuide - Voice Command Module
 *
 * Uses the browser's built-in Web Speech API for speech-to-text (no key needed).
 * After the wake word "Echo" is detected, the phrase is sent to the backend
 * which uses Gemini to understand the intent - handling unlimited variations,
 * accents, and casual phrasing.
 *
 * Wake word: "echo" (or "hey echo", "ok echo", "yo echo" etc.)
 */

"use strict";

const ACTIVATED_TIMEOUT_MS = 6000;

class VoiceCommander {
  constructor() {
    this._rec            = null;
    this._active         = false;
    this._awaitingName   = false;
    this._activated      = false;
    this._activatedTimer = null;
    this._onCommand      = null;
    this._onChange       = null;
    this._onTranscript   = null;  // called with every heard phrase for debug display
    this.supported       = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  start(onCommand, onStateChange, onTranscript) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return false;

    this._onCommand    = onCommand;
    this._onChange     = onStateChange || (() => {});
    this._onTranscript = onTranscript  || null;

    this._rec = new SR();
    this._rec.continuous      = true;
    this._rec.interimResults  = false;
    this._rec.lang            = "en-US";
    this._rec.maxAlternatives = 3;

    this._rec.onresult = (e) => {
      const results = Array.from(e.results).slice(e.resultIndex);
      for (const result of results) {
        // Try all recognition alternatives
        const alternatives = Array.from(result).map(a => a.transcript.trim().toLowerCase());
        console.log("[Voice] heard:", alternatives);
        this._onTranscript?.(alternatives[0]); // show top result in UI
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
    this._deactivate();
    try { this._rec?.stop(); } catch (_) {}
    this._onChange?.("stopped");
  }

  _activate() {
    this._activated = true;
    this._onChange?.("activated");
    clearTimeout(this._activatedTimer);
    this._activatedTimer = setTimeout(() => {
      if (this._activated) {
        this._deactivate();
        this._onChange?.("listening");
      }
    }, ACTIVATED_TIMEOUT_MS);
  }

  _deactivate() {
    this._activated = false;
    clearTimeout(this._activatedTimer);
    this._activatedTimer = null;
  }

  _process(transcript) {
    // If waiting for a name, next phrase IS the name
    if (this._awaitingName) {
      this._awaitingName = false;
      const name = transcript.trim();
      if (name) this._onCommand("remember_person", { name });
      return true;
    }

    // Already activated — any phrase is the command
    if (this._activated) {
      this._deactivate();
      this._onChange?.("listening");
      console.log("[Voice] activated command:", transcript);
      this._handlePhrase(transcript.trim());
      return true;
    }

    // Simple, lenient wake word check — does the phrase contain "echo"?
    if (!transcript.includes("echo")) return false;

    // Extract what came AFTER "echo"
    const afterEcho = transcript.split("echo").slice(1).join("echo").replace(/^[,. ]+/, "").trim();
    console.log("[Voice] wake word detected, command:", afterEcho);

    if (!afterEcho) {
      // Heard "echo" alone — enter activated mode
      this._activate();
      return true;
    }

    this._handlePhrase(afterEcho);
    return true;
  }

  async _handlePhrase(phrase) {
    if (!phrase) return;
    const instant = this._instantMatch(phrase);
    if (instant) {
      console.log("[Voice] instant match:", instant.intent);
      this._dispatch(instant.intent, instant.params);
      return;
    }

    // Send to Gemini for natural language understanding
    console.log("[Voice] sending to Gemini:", phrase);
    this._onChange?.("thinking");
    try {
      const res = await fetch("/voice/interpret", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phrase }),
      });
      if (!res.ok) throw new Error("interpret failed");
      const data = await res.json();
      console.log("[Voice] Gemini response:", data);
      this._onChange?.("listening");
      this._dispatch(data.intent || "unknown", data.params || {});
    } catch (err) {
      console.error("[Voice] Gemini error:", err);
      this._onChange?.("listening");
      this._dispatch("unknown", { raw: phrase });
    }
  }

  _instantMatch(cmd) {
    if (/^\s*stop\s*$/.test(cmd))                   return { intent: "stop_navigation", params: {} };
    if (/^\s*help\s*$/.test(cmd))                   return { intent: "help", params: {} };
    if (/^\s*(?:scan|describe|look)\s*$/.test(cmd)) return { intent: "scan_scene", params: {} };
    if (/^\s*(?:read|text|ocr)\s*$/.test(cmd))      return { intent: "read_text", params: {} };
    if (/^\s*(?:identify|who)\s*$/.test(cmd))       return { intent: "identify_person", params: {} };
    return null;
  }

  _dispatch(intent, params) {
    if (intent === "remember_person" && !params.name) {
      this._onCommand("ask_for_name", {});
      this._awaitingName = true;
      return;
    }
    this._onCommand(intent, params);
  }
}

const voiceCommander = new VoiceCommander();

class VoiceCommander {
  constructor() {
    this._rec            = null;
    this._active         = false;
    this._awaitingName   = false;
    this._activated      = false;
    this._activatedTimer = null;
    this._onCommand      = null;
    this._onChange       = null;
    this.supported       = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
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
    this._rec.maxAlternatives = 3;

    this._rec.onresult = (e) => {
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
    this._deactivate();
    try { this._rec?.stop(); } catch (_) {}
    this._onChange?.("stopped");
  }

  _activate() {
    this._activated = true;
    this._onChange?.("activated");
    clearTimeout(this._activatedTimer);
    this._activatedTimer = setTimeout(() => {
      if (this._activated) {
        this._deactivate();
        this._onChange?.("listening");
      }
    }, ACTIVATED_TIMEOUT_MS);
  }

  _deactivate() {
    this._activated = false;
    clearTimeout(this._activatedTimer);
    this._activatedTimer = null;
  }

  _process(transcript) {
    if (this._awaitingName) {
      this._awaitingName = false;
      const name = transcript.trim();
      if (name) this._onCommand("remember_person", { name });
      return true;
    }

    if (this._activated) {
      this._deactivate();
      this._onChange?.("listening");
      this._handlePhrase(transcript.trim());
      return true;
    }

    const wakeMatch = transcript.match(/\b(?:hey |ok(?:ay)? |yo )?echo[,.]?\s*(.*)/);
    if (!wakeMatch) return false;

    const phrase = wakeMatch[1].trim();

    if (!phrase) {
      this._activate();
      return true;
    }

    this._handlePhrase(phrase);
    return true;
  }

  async _handlePhrase(phrase) {
    const instant = this._instantMatch(phrase);
    if (instant) {
      this._dispatch(instant.intent, instant.params);
      return;
    }

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

  _instantMatch(cmd) {
    if (/^\s*stop\s*$/.test(cmd))                   return { intent: "stop_navigation", params: {} };
    if (/^\s*help\s*$/.test(cmd))                   return { intent: "help", params: {} };
    if (/^\s*(?:scan|describe|look)\s*$/.test(cmd)) return { intent: "scan_scene", params: {} };
    if (/^\s*(?:read|text|ocr)\s*$/.test(cmd))      return { intent: "read_text", params: {} };
    if (/^\s*(?:identify|who)\s*$/.test(cmd))       return { intent: "identify_person", params: {} };
    return null;
  }

  _dispatch(intent, params) {
    if (intent === "remember_person" && !params.name) {
      this._onCommand("ask_for_name", {});
      this._awaitingName = true;
      return;
    }
    this._onCommand(intent, params);
  }
}

const voiceCommander = new VoiceCommander();
