const API_BASE = "";

const video = document.getElementById("camera");
const canvas = document.getElementById("captureCanvas");
const startBtn = document.getElementById("startBtn");
const scanSceneBtn = document.getElementById("scanSceneBtn");
const readTextBtn = document.getElementById("readTextBtn");
const rememberPersonBtn = document.getElementById("rememberPersonBtn");
const identifyPersonBtn = document.getElementById("identifyPersonBtn");
const navigateBtn       = document.getElementById("navigateBtn");
const navPanel          = document.getElementById("navPanel");
const navDestInput      = document.getElementById("navDestInput");
const navGoBtn          = document.getElementById("navGoBtn");
const navStopBtn        = document.getElementById("navStopBtn");
const navStatusEl       = document.getElementById("navStatus");
const navInstructionEl  = document.getElementById("navInstruction");
const statusEl = document.getElementById("status");
const statusDot = document.getElementById("statusDot");
const answerEl = document.getElementById("answer");
const objectsEl = document.getElementById("objects");
const ocrTextEl = document.getElementById("ocrText");
const audioPlayer = document.getElementById("audioPlayer");
const idleOverlay = document.getElementById("idleOverlay");
const scanRing = document.getElementById("scanRing");

let stream = null;
let isBusy = false;

function setStatus(message, state) {
  statusEl.textContent = message;
  statusDot.className = "status-dot" + (state ? " " + state : "");
}

function setActionState(working) {
  scanSceneBtn.disabled = working;
  readTextBtn.disabled = working;
  rememberPersonBtn.disabled = working;
  identifyPersonBtn.disabled = working;
}

function speakFallback(text) {
  const speech = window.speechSynthesis;
  if (!speech || !speech.speak) {
    return false;
  }
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.05;
  speech.speak(utterance);
  return true;
}

function renderObjects(detectedObjects) {
  objectsEl.innerHTML = "";
  if (!detectedObjects || detectedObjects.length === 0) {
    const li = document.createElement("li");
    li.textContent = "Nothing detected.";
    li.style.color = "rgba(160,185,230,0.45)";
    li.style.listStyle = "none";
    objectsEl.appendChild(li);
    return;
  }
  for (const item of detectedObjects) {
    const li = document.createElement("li");
    li.className = "tag";
    const confidence = Math.round((item.confidence ?? 0) * 100);
    const label = item.label || "Object";
    li.textContent = `${label} ${confidence}%`;
    objectsEl.appendChild(li);
  }
}

function resetResultPanels() {
  answerEl.textContent = "No response yet.";
  objectsEl.innerHTML = "";
  ocrTextEl.textContent = "";
  audioPlayer.pause();
  audioPlayer.removeAttribute("src");
}

function captureFrameBlob() {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) {
    throw new Error("Camera feed is not ready.");
  }

  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, w, h);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Unable to capture photo."));
          return;
        }
        resolve(blob);
      },
      "image/jpeg",
      0.8
    );
  });
}

async function callJsonEndpoint(path, formData) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    body: formData,
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`${path} failed (${response.status}): ${message}`);
  }
  return response.json();
}

async function speakText(text) {
  try {
    const form = new URLSearchParams();
    form.append("text", text);
    const response = await fetch(`${API_BASE}/voice_response`, {
      method: "POST",
      body: form,
    });
    if (!response.ok) {
      const msg = await response.text();
      throw new Error(`Voice failed (${response.status}): ${msg}`);
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    audioPlayer.src = url;
    audioPlayer.classList.remove("hidden");
    await audioPlayer.play();
  } catch (error) {
    speakFallback(text);
  }
}

async function runAction(path, formData) {
  if (isBusy) return;
  isBusy = true;
  setActionState(true);
  scanRing.classList.add("active");
  setStatus("Capturing and processing…", "working");

  try {
    const data = await callJsonEndpoint(path, formData);
    const description = data?.text || "No result returned.";

    answerEl.textContent = description;
    if (path === "/read_text") {
      ocrTextEl.textContent = description;
      objectsEl.innerHTML = "";
    } else if (path === "/identify_person" || path === "/remember_person") {
      ocrTextEl.textContent = data?.name ? `Detected: ${data.name}` : "";
    } else {
      ocrTextEl.textContent = data?.ocr_text || "No readable text found.";
      renderObjects(data?.detected_objects || []);
    }

    await speakText(description);
    setStatus("Done.", "active");
  } catch (error) {
    const message = error?.message || "Action failed.";
    answerEl.textContent = `Error: ${message}`;
    ocrTextEl.textContent = "";
    objectsEl.innerHTML = "";
    setStatus(message, "error");
    speakFallback(message);
  } finally {
    isBusy = false;
    scanRing.classList.remove("active");
    setActionState(false);
  }
}

async function handleScanScene() {
  if (!stream) {
    setStatus("Start the camera first.");
    return;
  }
  const blob = await captureFrameBlob();
  const form = new FormData();
  form.append("image", blob, "scan.jpg");
  await runAction("/scan_scene", form);
}

async function handleReadText() {
  if (!stream) {
    setStatus("Start the camera first.");
    return;
  }
  const blob = await captureFrameBlob();
  const form = new FormData();
  form.append("image", blob, "text.jpg");
  await runAction("/read_text", form);
}

async function handleRememberPerson() {
  if (!stream) {
    setStatus("Start the camera first.");
    return;
  }
  const name = window.prompt("Person name:");
  if (!name || !name.trim()) {
    setStatus("Person name required.");
    return;
  }

  const blob = await captureFrameBlob();
  const form = new FormData();
  form.append("image", blob, "person.jpg");
  form.append("name", name.trim());
  await runAction("/remember_person", form);
}

async function handleIdentifyPerson() {
  if (!stream) {
    setStatus("Start the camera first.");
    return;
  }
  const blob = await captureFrameBlob();
  const form = new FormData();
  form.append("image", blob, "identify.jpg");
  await runAction("/identify_person", form);
}

async function startCamera() {
  if (stream) return;

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
  });
    video.srcObject = stream;
    await video.play();
    idleOverlay.classList.add("hidden");
    setStatus("Camera active. Tap an action.", "active");
    startBtn.querySelector(".btn-icon").innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>';
    startBtn.querySelector(".btn-label").textContent = "Stop Camera";
  } catch (error) {
    setStatus("Camera access denied or unavailable.", "error");
    speakFallback("Camera access denied or unavailable.");
  }
}

function stopCamera() {
  if (!stream) return;
  stream.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
  idleOverlay.classList.remove("hidden");
  startBtn.querySelector(".btn-icon").innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>';
  startBtn.querySelector(".btn-label").textContent = "Start Camera";
  setStatus("Camera stopped.");
}

startBtn.addEventListener("click", async () => {
  // Guarantee voice starts on first user gesture if it didn't auto-start
  _startVoice();
  if (!stream) {
    await startCamera();
    return;
  }
  stopCamera();
});

scanSceneBtn.addEventListener("click", async () => {
  try {
    resetResultPanels();
    await handleScanScene();
  } catch (error) {
    setStatus(error?.message || "Unable to scan scene.");
  }
});

readTextBtn.addEventListener("click", async () => {
  try {
    resetResultPanels();
    await handleReadText();
  } catch (error) {
    setStatus(error?.message || "Unable to read text.");
  }
});

rememberPersonBtn.addEventListener("click", async () => {
  try {
    resetResultPanels();
    await handleRememberPerson();
  } catch (error) {
    setStatus(error?.message || "Unable to remember person.");
  }
});

identifyPersonBtn.addEventListener("click", async () => {
  try {
    resetResultPanels();
    await handleIdentifyPerson();
  } catch (error) {
    setStatus(error?.message || "Unable to identify person.");
  }
});

// ── Navigation ────────────────────────────────────────────────────────────────
navigateBtn.addEventListener("click", () => {
  navPanel.classList.toggle("hidden");
  if (!navPanel.classList.contains("hidden")) {
    navDestInput.focus();
    nav.init(video, canvas,
      (msg) => { navStatusEl.textContent = msg; },
      (instr) => { navInstructionEl.textContent = instr || "—"; }
    );
  }
});

navGoBtn.addEventListener("click", () => {
  const dest = navDestInput.value.trim();
  if (!dest) { navStatusEl.textContent = "Please enter a destination."; return; }
  const candidatesEl = document.getElementById("navCandidates");
  nav.search(dest, candidatesEl);
});

navDestInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") navGoBtn.click();
});

navStopBtn.addEventListener("click", () => {
  nav.stop();
  navInstructionEl.textContent = "—";
  const candidatesEl = document.getElementById("navCandidates");
  if (candidatesEl) { candidatesEl.innerHTML = ""; candidatesEl.classList.add("hidden"); }
});

// ── Guide Mode ────────────────────────────────────────────────────────────────
const guideModeBtn      = document.getElementById("guideModeBtn");
const guidePanel        = document.getElementById("guidePanel");
const guideGuidanceEl   = document.getElementById("guideGuidance");
const guideDangerBanner = document.getElementById("guideDangerBanner");
const guideDangerText   = document.getElementById("guideDangerText");

const guideMode = new GuideMode(video, canvas, {
  intervalMs: 2000,
  onGuidance: (text, isDanger) => {
    guideGuidanceEl.textContent = text;
    if (isDanger) {
      guidePanel.classList.add("danger");
      guideDangerBanner.classList.remove("hidden");
      guideDangerText.textContent = text;
      setStatus(`⚠ ${text}`, "error");
      // Auto-clear danger highlight after 3s
      setTimeout(() => {
        guidePanel.classList.remove("danger");
        guideDangerBanner.classList.add("hidden");
      }, 3000);
    } else {
      guidePanel.classList.remove("danger");
      guideDangerBanner.classList.add("hidden");
      setStatus(`Guide: ${text}`);
    }
  },
  onStateChange: (active) => {
    if (active) {
      guideModeBtn.classList.add("active");
      guideModeBtn.querySelector(".btn-label").textContent = "Stop Guide";
      guidePanel.classList.remove("hidden");
      guideGuidanceEl.textContent = "Starting scan…";
    } else {
      guideModeBtn.classList.remove("active");
      guideModeBtn.querySelector(".btn-label").textContent = "Guide Mode";
      guidePanel.classList.add("hidden");
      setStatus("Guide Mode stopped.");
    }
  },
});

guideModeBtn.addEventListener("click", async () => {
  if (guideMode.active) {
    guideMode.stop();
    return;
  }
  // Ensure camera is on before starting
  if (!stream) {
    setStatus("Starting camera for Guide Mode…", "working");
    try { await startCamera(); } catch (_) {}
    await new Promise(r => setTimeout(r, 600));
  }
  speakFallback("Guide Mode activated.");
  guideMode.start();
});



// ── Voice commands ────────────────────────────────────────────────────────────
const voicePill  = document.getElementById("voicePill");
const voiceLabel = document.getElementById("voiceLabel");

// Helper: ensure camera is on, then run a callback
async function _withCamera(action) {
  if (!stream) {
    setStatus("Starting camera for you…", "working");
    speakFallback("Starting camera.");
    try { await startCamera(); } catch (_) {}
    // Small delay so the camera frame is ready
    await new Promise(r => setTimeout(r, 800));
  }
  action();
}

function handleVoiceCommand(type, params) {
  switch (type) {
    case "start_camera":
      setStatus("Starting camera…", "working");
      speakFallback("Starting camera.");
      if (!stream) startCamera();
      break;

    case "stop_camera":
      setStatus("Stopping camera.");
      speakFallback("Stopping camera.");
      stopCamera();
      break;

    case "scan_scene":
      setStatus("Echo: scanning the scene…", "working");
      speakFallback("Scanning.");
      _withCamera(() => { resetResultPanels(); handleScanScene(); });
      break;

    case "read_text":
      setStatus("Echo: reading text…", "working");
      speakFallback("Reading text.");
      _withCamera(() => { resetResultPanels(); handleReadText(); });
      break;

    case "identify_person":
      setStatus("Echo: identifying person…", "working");
      speakFallback("Identifying person.");
      _withCamera(() => { resetResultPanels(); handleIdentifyPerson(); });
      break;

    case "remember_person": {
      setStatus(`Echo: saving face as ${params.name}…`, "working");
      speakFallback(`Saving ${params.name}.`);
      _withCamera(() => {
        (async () => {
          try {
            const blob = await captureFrameBlob();
            const form = new FormData();
            form.append("image", blob, "person.jpg");
            form.append("name", params.name);
            await runAction("/remember_person", form);
          } catch (e) {
            speakFallback("Could not save person.");
          }
        })();
      });
      break;
    }

    case "ask_for_name":
      setStatus("Listening for name — say the person's name now…");
      speakFallback("Please say the person's name.");
      break;

    case "navigate": {
      const dest = params.destination || "";
      setStatus(`Echo: navigating to ${dest}…`);
      speakFallback(`Searching for ${dest}.`);
      navPanel.classList.remove("hidden");
      navDestInput.value = dest;
      nav.init(video, canvas,
        (msg)   => { navStatusEl.textContent = msg; },
        (instr) => { navInstructionEl.textContent = instr || "—"; }
      );
      const candidatesEl = document.getElementById("navCandidates");
      nav.search(dest, candidatesEl);
      break;
    }

    case "stop_navigation": {
      setStatus("Navigation stopped.");
      speakFallback("Navigation stopped.");
      nav.stop();
      navInstructionEl.textContent = "—";
      const stopCandidatesEl = document.getElementById("navCandidates");
      if (stopCandidatesEl) { stopCandidatesEl.innerHTML = ""; stopCandidatesEl.classList.add("hidden"); }
      break;
    }

    case "start_guide":
      setStatus("Echo: starting Guide Mode…");
      speakFallback("Guide Mode activated.");
      guideModeBtn.click();
      break;

    case "stop_guide":
      setStatus("Echo: stopping Guide Mode.");
      speakFallback("Guide Mode stopped.");
      if (guideMode.active) guideMode.stop();
      break;

    case "repeat_name":
      setStatus("Echo: repeating last identified person…");
      (async () => {
        try {
          const res = await fetch(`${API_BASE}/last_person`);
          const data = await res.json();
          const text = data.text || "I haven't identified anyone yet.";
          setStatus(`Last person: ${data.name || "unknown"}`);
          await speakText(text);
        } catch (_) {
          speakFallback("I haven't identified anyone yet.");
        }
      })();
      break;

    case "help":
      setStatus("Echo: showing voice command help.");
      speakFallback(
        "Voice commands: " +
        "Say Echo describe to scan what you see. " +
        "Say Echo read text. " +
        "Say Echo identify to identify a person. " +
        "Say Echo remember, then a name, to save a face. " +
        "Say Echo navigate to a place name to get directions. " +
        "Say Echo stop to end navigation. " +
        "Say Echo start camera or stop camera."
      );
      break;

    case "unknown":
      setStatus(`Echo heard you but didn't understand. Try: "Echo scan", "Echo read", "Echo help".`);
      speakFallback(`Sorry, I didn't understand. Say Echo help to hear available commands.`);
      break;
  }
}

let _voiceStarted = false;

function _startVoice() {
  if (_voiceStarted || !voiceCommander.supported) return;
  const ok = voiceCommander.start(handleVoiceCommand, (state) => {
    if (state === "listening") {
      voicePill.className = "voice-pill listening";
      voiceLabel.textContent = 'Say "Echo"';
    } else if (state === "activated") {
      voicePill.className = "voice-pill activated";
      voiceLabel.textContent = "Listening…";
      speakFallback("Yes?");
    } else if (state === "thinking") {
      voicePill.className = "voice-pill activated";
      voiceLabel.textContent = "Processing…";
    } else if (state === "error") {
      voicePill.className = "voice-pill error";
      voiceLabel.textContent = "Mic error — tap to retry";
    } else {
      voicePill.className = "voice-pill";
      voiceLabel.textContent = "Voice off";
    }
  }, (transcript) => {
    // Show whether echo was detected so the user gets immediate visual feedback
    const hasEcho = transcript.includes("echo") || transcript.includes("eco") || transcript.includes("ecco");
    if (hasEcho) {
      setStatus(`Echo detected: "${transcript}"`);
    } else {
      setStatus(`Heard: "${transcript}" — say Echo first`);
    }
  });
  if (ok) {
    _voiceStarted = true;
    setStatus('Microphone active. Say "Echo" to give a command.');
    speakFallback('EchoGuide ready. Say Echo to activate.');
  } else {
    console.error("[Voice] Failed to start — mic may be blocked or unsupported.");
    voicePill.className = "voice-pill error";
    voiceLabel.textContent = "Mic error — tap to retry";
    setStatus("Microphone failed to start. Tap the mic icon to retry.");
  }
}

// Tap the voice pill to retry mic if it failed
document.getElementById("voicePill").addEventListener("click", () => {
  _voiceStarted = false;
  _startVoice();
});

window.addEventListener("load", () => {
  const overlay    = document.getElementById("startupOverlay");
  const startupBtn = document.getElementById("startupBtn");

  // Detect plain-HTTP on a non-localhost origin (Chrome blocks camera/mic here)
  const isInsecure = location.protocol === "http:" &&
                     location.hostname !== "localhost" &&
                     location.hostname !== "127.0.0.1";

  if (isInsecure) {
    // Update overlay to show a clear message instead of being stuck
    const card = overlay.querySelector(".startup-card p");
    if (card) card.textContent = "Camera & mic require a secure connection. Open this page on the server as http://localhost:8000 instead.";
    const btn = overlay.querySelector(".startup-btn");
    if (btn) btn.textContent = "OK";
    overlay.addEventListener("click", () => overlay.classList.add("hidden"));
    startupBtn.addEventListener("click", (e) => { e.stopPropagation(); overlay.classList.add("hidden"); });
    setStatus("Use http://localhost:8000 — camera requires HTTPS or localhost.", "error");
    startBtn.disabled = true;
    setActionState(true);
    return;
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus("Camera is not supported in this browser.");
    overlay.classList.add("hidden");
    startBtn.disabled = true;
    setActionState(true);
    return;
  }

  function _dismissOverlay() {
    overlay.classList.add("hidden");
    // Start camera first — then start mic after it's ready to avoid
    // Chrome silently failing when both media APIs are requested at once
    startCamera().then(() => {
      setTimeout(() => {
        _startVoice();
      }, 400);
    }).catch(() => {
      // Camera failed, but still try mic
      setTimeout(_startVoice, 400);
    });
    setStatus('Starting camera and microphone…');
  }

  // Both the button and clicking anywhere on the overlay work
  startupBtn.addEventListener("click", (e) => { e.stopPropagation(); _dismissOverlay(); });
  overlay.addEventListener("click", _dismissOverlay);

  if (!voiceCommander.supported) {
    voicePill.className = "voice-pill error";
    voiceLabel.textContent = "Voice unsupported";
  }
});

// Register service worker for offline support and installability (PWA).
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then(() => console.log("Service worker registered."))
      .catch((err) => console.warn("Service worker registration failed:", err));
  });
}

