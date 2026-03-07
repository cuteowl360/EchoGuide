#!/bin/bash
# EchoGuide server setup — runs as EC2 user-data on Ubuntu 24.04 LTS
# Logs to /var/log/echoguide_setup.log
set -euo pipefail
exec > /var/log/echoguide_setup.log 2>&1

echo "=== EchoGuide setup started $(date) ==="

# ── System packages ───────────────────────────────────────────────────────────
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y \
    python3 python3-pip python3-venv python3-dev \
    git curl wget build-essential cmake \
    libopenblas-dev liblapack-dev libx11-dev libgtk-3-dev \
    libboost-python-dev tesseract-ocr

# ── Clone repo ────────────────────────────────────────────────────────────────
cd /opt
git clone https://github.com/cuteowl360/EchoGuide.git echoguide
chown -R ubuntu:ubuntu /opt/echoguide

# ── Python venv + dependencies ────────────────────────────────────────────────
cd /opt/echoguide
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip wheel setuptools

# Install dlib (builds from source — takes ~5 min on t3.small)
pip install dlib

# Remaining requirements
pip install \
    fastapi==0.115.0 \
    uvicorn==0.34.0 \
    python-multipart==0.0.18 \
    "opencv-python-headless>=4.8" \
    numpy==1.26.4 \
    "pillow>=10.4.0" \
    "python-dotenv>=1.0.1" \
    "requests>=2.32.0" \
    "ultralytics>=8.3.0" \
    "easyocr>=1.7.2" \
    "google-generativeai>=0.8.4" \
    "elevenlabs>=1.9.0" \
    "pytesseract>=0.3.13" \
    face-recognition

# ── YOLOv8 model (copy already in repo, else download) ────────────────────────
if [ ! -f /opt/echoguide/models/yolov8n.pt ]; then
    mkdir -p /opt/echoguide/models
    wget -q -O /opt/echoguide/models/yolov8n.pt \
        "https://github.com/ultralytics/assets/releases/download/v0.0.0/yolov8n.pt"
fi

# ── Environment variables ─────────────────────────────────────────────────────
cat > /opt/echoguide/.env << 'ENVEOF'
GEMINI_API_KEY=%%GEMINI_API_KEY%%
ELEVENLABS_API_KEY=%%ELEVENLABS_API_KEY%%
MAPBOX_ACCESS_TOKEN=%%MAPBOX_ACCESS_TOKEN%%
ALLOWED_ORIGINS=*
HTTPS_ONLY=1
ENVEOF
chown ubuntu:ubuntu /opt/echoguide/.env
chmod 600 /opt/echoguide/.env

# ── Get public IP from EC2 metadata ──────────────────────────────────────────
TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" \
        -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
PUBLIC_IP=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \
            http://169.254.169.254/latest/meta-data/public-ipv4)
DOMAIN="${PUBLIC_IP}.nip.io"
echo "Public IP: $PUBLIC_IP  Domain: $DOMAIN"

# ── Install Caddy ─────────────────────────────────────────────────────────────
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update -y
apt-get install -y caddy

# ── Caddyfile — HTTPS reverse proxy via Let's Encrypt ────────────────────────
cat > /etc/caddy/Caddyfile << CADDYEOF
{
    email %%LETSENCRYPT_EMAIL%%
}

${DOMAIN} {
    reverse_proxy localhost:8000
    header {
        # Security headers
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
    }
}
CADDYEOF

# ── systemd service for uvicorn ───────────────────────────────────────────────
cat > /etc/systemd/system/echoguide.service << 'SVCEOF'
[Unit]
Description=EchoGuide FastAPI Backend
After=network.target

[Service]
User=ubuntu
Group=ubuntu
WorkingDirectory=/opt/echoguide
EnvironmentFile=/opt/echoguide/.env
ExecStart=/opt/echoguide/venv/bin/uvicorn backend.main:app \
    --host 127.0.0.1 \
    --port 8000 \
    --workers 2
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SVCEOF

# ── Start everything ──────────────────────────────────────────────────────────
systemctl daemon-reload
systemctl enable echoguide caddy
systemctl start echoguide
systemctl start caddy

echo "=== EchoGuide deployed at https://${DOMAIN} ==="
echo "=== Setup complete $(date) ==="
