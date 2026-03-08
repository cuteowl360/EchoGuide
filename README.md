# EchoGuide (AI Vision Assistant)

EchoGuide is a browser-based AI vision assistant that can scan scenes, read text, identify/remember people, and provide navigation guidance.

---

## 1) Install dependencies

```bash
pip install -r requirements.txt
```

## 2) Configure environment variables

Copy the example env file and fill in your API keys:

```bash
cp .env.example .env
```

Required:
- `ELEVENLABS_API_KEY` (TTS)
- `ORS_API_KEY` (OpenRouteService navigation)

Optional:
- `GEMINI_API_KEY` (Google Gemini / Gemini API)

## 3) Run the backend

```bash
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```

Then open in your browser:

- Desktop: `http://localhost:8000/`

---

## Running on an Android phone

### Option A (local network)
1. Run the backend as above.
2. Find your machine's local IP (e.g., `192.168.1.42`).
3. Open on your phone: `http://<your_ip>:8000/`

> Note: Some browsers require HTTPS to access the camera. If camera access fails, use **Option B** below.

### Option B (secure tunnel, recommended)
Use a tool like [ngrok](https://ngrok.com/) or [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/) to get an `https://` URL.

Example with ngrok:

```bash
ngrok http 8000
```

Then open the generated `https://...` URL on your phone.

---

## YOLO model files

Place your YOLOv8 weights here.

- Default path used by the app: `models/yolov8.pt`
- If missing, the backend attempts to load `yolov8n.pt` from Ultralytics cache.

Do not commit large model binaries unless your repo has dedicated storage handling.

**EchoGuide**

AI Navigation Assistant for the Visually Impaired

EchoGuide is an AI-powered assistive navigation system that helps visually impaired users safely understand and move through their surroundings using real-time environmental recognition and voice feedback.

Using computer vision and speech technology, EchoGuide detects objects, hazards, and pathways, then communicates guidance through natural speech.

**The Problem**

Navigation is one of the biggest challenges faced by people with visual impairments.

Globally, over 217 million people live with significant vision impairment, and millions struggle with independent mobility. Obstacles like stairs, curbs, doors, and unexpected hazards can make everyday navigation difficult and dangerous.

Traditional tools like canes and guide dogs are helpful but cannot describe the environment in detail or anticipate hazards ahead.

EchoGuide aims to bridge that gap.

**Our Solution**

EchoGuide acts as a real-time AI guide that observes the environment through the user's camera and provides spoken guidance.

The system detects objects, obstacles, and environmental features and communicates clear instructions to the user.

Examples of guidance:

“Obstacle ahead. Move slightly left.”

“Stairs detected. Approach with caution.”

“Door detected three meters ahead.”

This allows users to navigate more confidently and independently.

**Key Features**
Real-Time Object Detection

EchoGuide uses YOLOv8 computer vision to detect obstacles and important environmental features such as:

stairs

doors

sidewalks

people

obstacles

**Intelligent Voice Guidance**

The system converts environmental understanding into natural spoken instructions, helping users understand what lies ahead.

**Guide Mode**

Guide Mode continuously analyzes the environment and provides navigation feedback as the user moves.

**Voice Commands**

Users can control EchoGuide through voice commands such as:

“Echo stop”

“Echo shut down”

“Echo help”

**Hazard Awareness**

EchoGuide identifies potential hazards and warns the user early.

**Technology Stack**
**Frontend**

Progressive Web App (PWA)

JavaScript

Web Speech API (Speech Recognition + Text-to-Speech)

Camera API

**Backend**

FastAPI (Python) for low-latency processing

**REST API communication**

AI / Computer Vision

ElevenLabs

Gemini

YOLOv8 for real-time object detection

**Security**

PBKDF2 password hashing

Token-based session authentication

**How It Works**

The user opens EchoGuide on their device.

The camera captures the surrounding environment.

YOLOv8 detects objects and hazards in real time.

The backend processes the data.

The system generates guidance instructions.

Voice output communicates navigation instructions to the user.

**Example Use Case**

A user walking down a sidewalk:

Camera detects:

a set of stairs

a person

a door

**EchoGuide responds:**

“Stairs detected ahead. Approach with caution. Person passing on your left.”

Why EchoGuide Matters

**EchoGuide provides:**

Greater independence for visually impaired users

Safer navigation

Real-time environmental awareness

By combining AI vision with speech technology, EchoGuide turns a smartphone into a digital mobility assistant.

**Future Improvements**

GPS navigation integration

Indoor mapping

Object distance estimation

Smart route guidance

Wearable device integration (smart glasses)

**Team**

Built during a hackathon by a team passionate about AI accessibility and assistive technology.

**Developers**:

Yifan Liu
Lohitha Varma Sagi
