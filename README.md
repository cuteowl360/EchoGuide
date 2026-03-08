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
- `ORS_API_KEY` (OpenRouteService navigation)

Optional:
- `GEMINI_API_KEY` (Google Gemini / Gemini API)
- `TTS_PROVIDER` (`elevenlabs` or `polly`, default: `elevenlabs`)
- Polly settings when using `polly`: `POLLY_REGION`, `POLLY_VOICE_ID`, `POLLY_ENGINE`
- ElevenLabs settings when using `elevenlabs`: `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`

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
