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
async function searchDestinations(query, proximityLat, proximityLon) {
  const res = await fetch("/navigate/geocode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, near_lat: proximityLat, near_lon: proximityLon }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `Search failed: ${res.status}`);
  }
  const data = await res.json();
  return data.candidates; // [{ lat, lon, name, address, distance_m, category }]
}

function formatDistance(m) {
  if (m < 1000) return `${m} m away`;
  return `${(m / 1000).toFixed(1)} km away`;
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
  _steps: [],
  _currentStep: 0,
  _watchId: null,
  _obstacleTimer: null,
  _videoEl: null,
  _canvasEl: null,
  _onStatus: null,
  _onInstruction: null,
  _ttsAvailable: false,
  _originLat: null,
  _originLon: null,

  /** Call once on page load. */
  init(videoEl, canvasEl, onStatus, onInstruction) {
    this._videoEl       = videoEl;
    this._canvasEl      = canvasEl;
    this._onStatus      = onStatus      || console.log;
    this._onInstruction = onInstruction || console.log;
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

  /** Step 1: search and render candidate cards. */
  async search(destinationText, candidatesEl) {
    this._onStatus("Getting your location…");

    let pos;
    try {
      pos = await new Promise((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true, timeout: 10000,
        })
      );
    } catch {
      this._onStatus("GPS unavailable. Enable location access and try again.");
      speakFallback("Could not get your GPS location. Please enable location access.");
      return [];
    }

    this._originLat = pos.coords.latitude;
    this._originLon = pos.coords.longitude;
    this._onStatus(`Searching for “${destinationText}”…`);

    let candidates;
    try {
      candidates = await searchDestinations(destinationText, this._originLat, this._originLon);
    } catch (e) {
      this._onStatus(e.message || `Could not find “${destinationText}”.`);
      speakFallback(`Sorry, I could not find ${destinationText}.`);
      return [];
    }

    if (!candidates?.length) {
      this._onStatus(`No results for “${destinationText}”. Try a different spelling.`);
      speakFallback(`No results found for ${destinationText}.`);
      return [];
    }

    // Render candidate cards
    candidatesEl.innerHTML = "";
    candidates.forEach((c) => {
      const card = document.createElement("button");
      card.className = "nav-candidate-card";
      card.setAttribute("aria-label", `Navigate to ${c.name}, ${c.address}`);
      card.innerHTML = `
        <div class="nav-candidate-main">
          <span class="nav-candidate-name">${c.name}</span>
          <span class="nav-candidate-dist">${formatDistance(c.distance_m)}</span>
        </div>
        <div class="nav-candidate-address">${c.address}</div>
      `;
      card.addEventListener("click", () => this._confirmAndRoute(c, candidatesEl));
      candidatesEl.appendChild(card);
    });
    candidatesEl.classList.remove("hidden");

    const count = candidates.length;
    this._onStatus(`Found ${count} result${count > 1 ? "s" : ""}. Tap one to navigate.`);
    speakFallback(
      count === 1
        ? `Found ${candidates[0].name}, ${formatDistance(candidates[0].distance_m)}. Tap to start.`
        : `Found ${count} results nearby. Please choose one.`
    );
    return candidates;
  },

  /** Step 2: user tapped a card — calculate and start route. */
  async _confirmAndRoute(dest, candidatesEl) {
    candidatesEl.querySelectorAll(".nav-candidate-card").forEach(c => {
      c.classList.toggle("chosen", c.querySelector(".nav-candidate-name")?.textContent === dest.name);
    });

    this._onStatus(`Routing to ${dest.name}…`);

    let routeData;
    try {
      const res = await fetch("/navigate/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          origin_lat: this._originLat, origin_lon: this._originLon,
          dest_lat: dest.lat, dest_lon: dest.lon,
        }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.detail || `Server error ${res.status}`);
      }
      routeData = await res.json();
    } catch (e) {
      this._speak(`Could not calculate a route: ${e.message}`);
      return;
    }

    this._steps       = routeData.route.steps;
    this._currentStep = 0;

    const distKm  = (routeData.route.total_distance_m / 1000).toFixed(1);
    const durMin  = Math.round(routeData.route.total_duration_s / 60);
    const firstInstr = this._steps[0]?.instruction ?? "";

    const announcement =
      `Navigating to ${dest.name}. Address: ${dest.address}. ` +
      `${distKm} kilometres, about ${durMin} minute${durMin !== 1 ? "s" : ""} on foot. ` +
      firstInstr;

    this._speak(announcement);
    this._onInstruction(firstInstr);

    const instrSection = document.getElementById("navInstructionSection");
    const instrDivider = document.getElementById("navInstructionDivider");
    if (instrSection) instrSection.style.display = "";
    if (instrDivider) instrDivider.style.display = "";

    if (routeData.first_instruction_audio) playBase64Audio(routeData.first_instruction_audio);

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
        this._onInstruction(next.instruction);
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
    this._originLat = null;
    this._originLon = null;
    this._onStatus("Navigation stopped.");
    if (this._onInstruction) this._onInstruction("—");
    const instrSection = document.getElementById("navInstructionSection");
    const instrDivider = document.getElementById("navInstructionDivider");
    if (instrSection) instrSection.style.display = "none";
    if (instrDivider) instrDivider.style.display = "none";
  },
};
