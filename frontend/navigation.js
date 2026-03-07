/**
 * EchoGuide – Navigation module
 *
 * Flow:
 *  1. User speaks a destination  →  geocode it  →  POST /navigate/route
 *  2. GPS watchPosition() tracks the user every second
 *  3. When the user arrives within ARRIVAL_RADIUS of the next waypoint,
 *     the next instruction is spoken via POST /navigate/speak_step
 *  4. Every OBSTACLE_INTERVAL ms a camera frame is posted to
 *     /navigate/scan_obstacles – obstacles are announced via TTS
 */

"use strict";

const ARRIVAL_RADIUS_M = 15;      // metres – how close = "arrived at waypoint"
const OBSTACLE_INTERVAL = 4000;   // ms between camera scans while navigating

// ── Haversine ─────────────────────────────────────────────────────────────────
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6_371_000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Geocoding (via backend → ORS, key stays server-side) ────────────────────
async function geocodeDestination(query, proximityLat, proximityLon) {
  const res = await fetch("/navigate/geocode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, near_lat: proximityLat, near_lon: proximityLon }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `Geocoding failed: ${res.status}`);
  }
  return await res.json();  // { lat, lon, name }
}

// ── Audio helper ──────────────────────────────────────────────────────────────
function playBase64Audio(b64) {
  if (!b64) return;
  const audio = new Audio(`data:audio/mpeg;base64,${b64}`);
  audio.play().catch(() => {});
}

async function speakInstruction(text) {
  try {
    const fd = new FormData();
    fd.append("text", text);
    const res = await fetch("/navigate/speak_step", { method: "POST", body: fd });
    if (!res.ok) return;
    const data = await res.json();
    playBase64Audio(data.audio_base64);
  } catch (_) {}
}

// ── Web Speech API fallback (if TTS not configured) ──────────────────────────
function speakFallback(text) {
  if (!("speechSynthesis" in window)) return;
  const utt = new SpeechSynthesisUtterance(text);
  utt.rate = 0.95;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utt);
}

// ── Navigation state ──────────────────────────────────────────────────────────
const nav = {
  _token: "",
  _steps: [],
  _currentStep: 0,
  _watchId: null,
  _obstacleTimer: null,
  _videoEl: null,
  _canvasEl: null,
  _onStatus: null,  // callback(msg)
  _ttsAvailable: false,

  /** Call once on page load. */
  init(videoEl, canvasEl, onStatus) {
    this._videoEl = videoEl;
    this._canvasEl = canvasEl;
    this._onStatus = onStatus || console.log;
    // Check if TTS is configured
    fetch("/health").then(r => r.json()).then(d => {
      this._ttsAvailable = d?.features?.tts ?? false;
    }).catch(() => {});
  },

  _speak(text) {
    this._onStatus(text);
    if (this._ttsAvailable) {
      speakInstruction(text);
    } else {
      speakFallback(text);
    }
  },

  /** Start navigation to a spoken/typed destination string. */
  async startNavigation(destinationText) {
    this._onStatus("Getting your location…");

    let originPos;
    try {
      originPos = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true, timeout: 10000,
        });
      });
    } catch (e) {
      this._onStatus("Could not get your GPS location.");
      speakFallback("Could not get your GPS location. Please enable location access.");
      return;
    }

    const { latitude: oLat, longitude: oLon } = originPos.coords;
    this._onStatus(`Searching for "${destinationText}"…`);

    let dest;
    try {
      dest = await geocodeDestination(destinationText, oLat, oLon);
    } catch (e) {
      this._speak(`Sorry, I could not find ${destinationText}.`);
      return;
    }

    this._onStatus(`Routing to ${dest.name}…`);

    let routeData;
    try {
      const res = await fetch("/navigate/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          origin_lat: oLat, origin_lon: oLon,
          dest_lat: dest.lat, dest_lon: dest.lon,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      routeData = await res.json();
    } catch (e) {
      this._speak("Could not calculate a route. Check your Mapbox API key.");
      return;
    }

    this._steps = routeData.route.steps;
    this._currentStep = 0;

    const distKm = (routeData.route.total_distance_m / 1000).toFixed(1);
    const durMin = Math.round(routeData.route.total_duration_s / 60);
    this._speak(
      `Route found to ${dest.name}. ${distKm} kilometres, about ${durMin} minutes. ` +
      this._steps[0]?.instruction ?? ""
    );
    if (routeData.first_instruction_audio) {
      // The server already synthesised the first step
      playBase64Audio(routeData.first_instruction_audio);
    }

    this._startTracking();
    this._startObstacleScanning();
  },

  _startTracking() {
    if (this._watchId !== null) navigator.geolocation.clearWatch(this._watchId);
    this._watchId = navigator.geolocation.watchPosition(
      (pos) => this._onPosition(pos),
      (err) => this._onStatus(`GPS error: ${err.message}`),
      { enableHighAccuracy: true, maximumAge: 1000 }
    );
  },

  _onPosition(pos) {
    const { latitude: lat, longitude: lon } = pos.coords;

    if (this._currentStep >= this._steps.length) {
      this._speak("You have arrived at your destination.");
      this.stop();
      return;
    }

    const step = this._steps[this._currentStep];
    const dist = haversineM(lat, lon, step.lat, step.lon);

    if (dist < ARRIVAL_RADIUS_M) {
      this._currentStep++;
      if (this._currentStep >= this._steps.length) {
        this._speak("You have arrived at your destination.");
        this.stop();
      } else {
        const next = this._steps[this._currentStep];
        this._speak(next.instruction);
      }
    } else if (dist < 50) {
      // Approaching — give a heads-up
      this._onStatus(`In ${Math.round(dist)} metres: ${step.instruction}`);
    }
  },

  _startObstacleScanning() {
    this._stopObstacleScanning();
    this._obstacleTimer = setInterval(() => this._scanObstacles(), OBSTACLE_INTERVAL);
  },

  _stopObstacleScanning() {
    if (this._obstacleTimer) {
      clearInterval(this._obstacleTimer);
      this._obstacleTimer = null;
    }
  },

  async _scanObstacles() {
    if (!this._videoEl || this._videoEl.readyState < 2) return;

    const canvas = this._canvasEl;
    const ctx = canvas.getContext("2d");
    canvas.width = 320;
    canvas.height = 240;
    ctx.drawImage(this._videoEl, 0, 0, 320, 240);
    const b64 = canvas.toDataURL("image/jpeg", 0.7).split(",")[1];

    try {
      const res = await fetch("/navigate/scan_obstacles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_b64: b64, current_step: this._currentStep }),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.announcement) {
        if (data.audio_base64) {
          playBase64Audio(data.audio_base64);
        } else {
          speakFallback(data.announcement);
        }
        this._onStatus(data.announcement);
      }
    } catch (_) {}
  },

  stop() {
    if (this._watchId !== null) {
      navigator.geolocation.clearWatch(this._watchId);
      this._watchId = null;
    }
    this._stopObstacleScanning();
    this._steps = [];
    this._currentStep = 0;
    this._onStatus("Navigation stopped.");
  },
};
