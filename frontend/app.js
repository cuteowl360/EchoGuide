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

// ── Voice commands ────────────────────────────────────────────────────────────
const voicePill  = document.getElementById("voicePill");
const voiceLabel = document.getElementById("voiceLabel");

function handleVoiceCommand(type, params) {
  switch (type) {
    case "start_camera":
      speakFallback("Starting camera.");
      if (!stream) startCamera();
      break;

    case "stop_camera":
      speakFallback("Stopping camera.");
      stopCamera();
      break;

    case "scan_scene":
      if (!stream) { speakFallback("Please start the camera first."); return; }
      speakFallback("Scanning.");
      resetResultPanels();
      handleScanScene();
      break;

    case "read_text":
      if (!stream) { speakFallback("Please start the camera first."); return; }
      speakFallback("Reading text.");
      resetResultPanels();
      handleReadText();
      break;

    case "identify_person":
      if (!stream) { speakFallback("Please start the camera first."); return; }
      speakFallback("Identifying person.");
      resetResultPanels();
      handleIdentifyPerson();
      break;

    case "remember_person": {
      if (!stream) { speakFallback("Please start the camera first."); return; }
      speakFallback(`Saving ${params.name}.`);
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
      break;
    }

    case "ask_for_name":
      speakFallback("Please say the person's name.");
      setStatus("Listening for name…");
      break;

    case "navigate": {
      speakFallback(`Searching for ${params.destination}.`);
      navPanel.classList.remove("hidden");
      navDestInput.value = params.destination;
      nav.init(video, canvas,
        (msg)   => { navStatusEl.textContent = msg; },
        (instr) => { navInstructionEl.textContent = instr || "—"; }
      );
      const candidatesEl = document.getElementById("navCandidates");
      nav.search(params.destination, candidatesEl);
      break;
    }

    case "stop_navigation": {
      speakFallback("Navigation stopped.");
      nav.stop();
      navInstructionEl.textContent = "—";
      const stopCandidatesEl = document.getElementById("navCandidates");
      if (stopCandidatesEl) { stopCandidatesEl.innerHTML = ""; stopCandidatesEl.classList.add("hidden"); }
      break;
    }

    case "help":
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
    } else if (state === "error") {
      voicePill.className = "voice-pill error";
      voiceLabel.textContent = "Mic blocked";
    } else {
      voicePill.className = "voice-pill";
      voiceLabel.textContent = "Voice off";
    }
  });
  if (ok) _voiceStarted = true;
}

window.addEventListener("load", () => {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus("Camera is not supported in this browser.");
    startBtn.disabled = true;
    setActionState(true);
    return;
  }
  setStatus("Press Start Camera to begin.");

  if (voiceCommander.supported) {
    // Try immediately — works if mic permission was already granted
    _startVoice();
  } else {
    voicePill.className = "voice-pill error";
    voiceLabel.textContent = "Voice unsupported";
  }
});
