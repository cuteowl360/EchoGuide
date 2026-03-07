/**
 * EchoGuide - Voice Command Module
 *
 * Uses the browser's built-in Web Speech API for speech-to-text (no key needed).
 * After the wake word "Echo" is detected, the phrase is sent to the backend
 * which uses Gemini to understand the intent - handling unlimited variations,
 * accents, and casual phrasing.
 *
 * Wake word: "echo" (or "hey echo", "ok echo", "yo echo", "eco", "ecco" etc.)
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
    this._onTranscript   = null;
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
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (!e.results[i].isFinal) continue;
        const alternatives = [];
        for (let j = 0; j < e.results[i].length; j++) {
          alternatives.push(e.results[i][j].transcript.trim().toLowerCase());
        }
        console.log("[Voice] heard:", alternatives);
        if (this._onTranscript) this._onTranscript(alternatives[0]);
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
      console.error("[Voice] SpeechRecognition error:", e.error);
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
    } catch (err) {
      console.error("[Voice] Failed to start SpeechRecognition:", err);
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

    // Already activated � any phrase is the command
    if (this._activated) {
      this._deactivate();
      this._onChange?.("listening");
      console.log("[Voice] activated command:", transcript);
      this._handlePhrase(transcript.trim());
      return true;
    }

    // Lenient wake word check
    // Accepts: echo, eco, ecco, echo guide, hey echo, ok echo, yo echo, etc.
    const hasWakeWord = (
      transcript.includes("echo") ||
      transcript.includes("eco ") ||
      /\beco$/.test(transcript)   ||
      transcript.includes("ecco") ||
      transcript.includes("echo guide")
    );
    if (!hasWakeWord) return false;

    // Extract what came AFTER the wake word
    let afterWake = transcript
      .replace(/.*\b(?:hey |ok(?:ay)? |yo )?(?:echo(?:\s?guide)?|eco|ecco)\b[,. ]*/i, "")
      .trim();
    console.log("[Voice] wake detected, command phrase:", afterWake || "(none)");

    if (!afterWake) {
      this._activate();
      return true;
    }

    this._handlePhrase(afterWake);
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
      // If Gemini returns unknown, try one more keyword pass on the full phrase
      if (data.intent === "unknown" || !data.intent) {
        const fallback = this._keywordFallback(phrase);
        this._dispatch(fallback.intent, fallback.params);
      } else {
        this._dispatch(data.intent, data.params || {});
      }
    } catch (err) {
      console.error("[Voice] Gemini error:", err);
      this._onChange?.("listening");
      const fallback = this._keywordFallback(phrase);
      this._dispatch(fallback.intent, fallback.params);
    }
  }

  // Broad keyword fallback — used when Gemini is unavailable or returns unknown
  _keywordFallback(phrase) {
    if (/\bguide\b/.test(phrase) && /\b(start|begin|on|activate)\b/.test(phrase))
      return { intent: "start_guide", params: {} };
    if (/\bguide\b/.test(phrase) && /\b(stop|end|off|exit)\b/.test(phrase))
      return { intent: "stop_guide", params: {} };
    if (/\b(scan|describe|look|see|around|front|surroundings)\b/.test(phrase))
      return { intent: "scan_scene", params: {} };
    if (/\b(read|text|sign|written|label)\b/.test(phrase))
      return { intent: "read_text", params: {} };
    if (/\b(who|identify|face|person|do you know)\b/.test(phrase))
      return { intent: "identify_person", params: {} };
    if (/\b(repeat|their name|what.*call|name again)\b/.test(phrase))
      return { intent: "repeat_name", params: {} };
    if (/\b(stop|end|cancel)\b/.test(phrase))
      return { intent: "stop_navigation", params: {} };
    if (/\b(help|assist|commands)\b/.test(phrase))
      return { intent: "help", params: {} };
    // Navigate — last chance
    const navM = phrase.match(/\b(?:go|navigate|directions?)\b.*?\bto\b\s+([\w\s,]+)/i);
    if (navM) return { intent: "navigate", params: { destination: navM[1].trim() } };
    return { intent: "unknown", params: { raw: phrase } };
  }

  _instantMatch(cmd) {
    // Stop / navigation
    if (/\bstop\b/.test(cmd) && !/navigate|go to|take me/i.test(cmd))
      return { intent: "stop_navigation", params: {} };

    // Help
    if (/\bhelp\b|\bwhat can you do\b|\bcommands\b/.test(cmd))
      return { intent: "help", params: {} };

    // Scan / describe scene
    if (/\b(scan|describe|look|see|what.*(around|there|here|front|this)|tell me what|surroundings|environment)\b/.test(cmd))
      return { intent: "scan_scene", params: {} };

    // Read text / OCR
    if (/\b(read|text|ocr|sign|words|written|writing|label|message)\b/.test(cmd))
      return { intent: "read_text", params: {} };

    // Identify person / face
    if (/\b(identify|who.*is|do you know them|recogni[sz]e|face|person|people)\b/.test(cmd))
      return { intent: "identify_person", params: {} };

    // Repeat / echo last recognized name
    if (/\b(repeat|what.*call|their name|his name|her name|say.*name again|name again)\b/.test(cmd))
      return { intent: "repeat_name", params: {} };

    // Remember / save person — handles "as [name]" and "named [name]" patterns
    const rememberMatch = cmd.match(/\b(?:remember|save|learn|add|store)\b.*?\b(?:as|named?|call(?:ed)?)\s+([\w][\w\s]{0,30}?)\s*$/);
    if (rememberMatch)
      return { intent: "remember_person", params: { name: rememberMatch[1].trim() } };

    // Start / stop camera
    if (/\b(start|open|turn on|enable)\b.*\bcamera\b|\bcamera\b.*\b(start|on)\b/.test(cmd))
      return { intent: "start_camera", params: {} };
    if (/\b(stop|close|turn off|disable)\b.*\bcamera\b|\bcamera\b.*\b(stop|off)\b/.test(cmd))
      return { intent: "stop_camera", params: {} };

    // Guide Mode
    if (/\b(start|begin|activate|enable|turn on)\b.*\bguide\b|\bguide\b.*(mode|on|start)/.test(cmd) || /^guide\s*mode?$/.test(cmd))
      return { intent: "start_guide", params: {} };
    if (/\b(stop|end|exit|deactivate|disable|turn off)\b.*\bguide\b|\bguide\b.*(off|stop|end)/.test(cmd))
      return { intent: "stop_guide", params: {} };

    // Navigate — extract destination
    const navMatch = cmd.match(/\b(?:navigate|go|take me|directions?|how do i get)\b.*?\bto\b\s+([\w\s,]+?)(?:\s*$|\s*please)/i);
    if (navMatch && navMatch[1])
      return { intent: "navigate", params: { destination: navMatch[1].trim() } };

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
