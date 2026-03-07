"""Authentication: user accounts, password hashing (PBKDF2), JWT sessions (HMAC-SHA256).

Zero extra dependencies — uses only Python stdlib + FastAPI/Pydantic which are
already required by the project.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import sqlite3
import time
from pathlib import Path
from threading import Lock
from typing import Any, Dict, Optional

from fastapi import APIRouter, Cookie, Depends, Header, HTTPException, Request, Response
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# ── config ────────────────────────────────────────────────────────────────────

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DB_PATH = Path(os.getenv("USERS_DB_PATH", str(PROJECT_ROOT / "users.db")))
TOKEN_EXPIRY_SECONDS = int(os.getenv("TOKEN_EXPIRY_SECONDS", str(60 * 60 * 24 * 7)))  # 7 days
COOKIE_NAME = "eg_session"

_DB_LOCK = Lock()
router = APIRouter(prefix="/auth", tags=["auth"])


# ── secret key (persisted to .secret_key if JWT_SECRET env var absent) ────────

def _load_secret() -> str:
    env_val = os.getenv("JWT_SECRET", "").strip()
    if env_val:
        return env_val
    key_file = PROJECT_ROOT / ".secret_key"
    if key_file.exists():
        return key_file.read_text().strip()
    new_key = secrets.token_hex(32)
    try:
        key_file.write_text(new_key)
    except OSError:
        pass  # read-only filesystem — key is ephemeral for this process only
    logger.warning(
        "No JWT_SECRET env var set. A secret was auto-generated and saved to %s. "
        "Add JWT_SECRET=<value> to your .env for a stable secret.",
        key_file,
    )
    return new_key


_SECRET: str = _load_secret()


# ── password hashing (PBKDF2-SHA256, 260 000 iterations) ─────────────────────

_PBKDF2_ITERS = 260_000


def _hash_password(password: str) -> str:
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, _PBKDF2_ITERS)
    return base64.b64encode(salt + dk).decode()


def _verify_password(password: str, stored: str) -> bool:
    try:
        raw = base64.b64decode(stored.encode())
    except Exception:
        return False
    salt, dk = raw[:16], raw[16:]
    check = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, _PBKDF2_ITERS)
    return hmac.compare_digest(dk, check)


# ── JWT (HS256 via stdlib hmac + hashlib) ─────────────────────────────────────

def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _b64url_decode(s: str) -> bytes:
    pad = (4 - len(s) % 4) % 4
    return base64.urlsafe_b64decode(s + "=" * pad)


def _create_token(user_id: int, username: str) -> str:
    header = _b64url_encode(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    now = int(time.time())
    payload = _b64url_encode(
        json.dumps({
            "sub": user_id,
            "username": username,
            "exp": now + TOKEN_EXPIRY_SECONDS,
            "iat": now,
        }).encode()
    )
    sig = _b64url_encode(
        hmac.new(_SECRET.encode(), f"{header}.{payload}".encode(), hashlib.sha256).digest()
    )
    return f"{header}.{payload}.{sig}"


def _verify_token(token: str) -> Dict[str, Any]:
    try:
        header, payload, sig = token.split(".")
    except ValueError:
        raise HTTPException(status_code=401, detail="Not authenticated.")
    expected = _b64url_encode(
        hmac.new(_SECRET.encode(), f"{header}.{payload}".encode(), hashlib.sha256).digest()
    )
    if not hmac.compare_digest(sig, expected):
        raise HTTPException(status_code=401, detail="Not authenticated.")
    try:
        data = json.loads(_b64url_decode(payload))
    except Exception:
        raise HTTPException(status_code=401, detail="Not authenticated.")
    if data.get("exp", 0) < time.time():
        raise HTTPException(status_code=401, detail="Session expired. Please log in again.")
    return data


# ── database (SQLite) ─────────────────────────────────────────────────────────

def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db() -> None:
    """Create the users table if it does not exist. Called at app startup."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _DB_LOCK, _get_conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                username   TEXT    NOT NULL UNIQUE COLLATE NOCASE,
                email      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
                pw_hash    TEXT    NOT NULL,
                created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
            )
        """)
        conn.commit()
    logger.info("Auth DB ready at %s", DB_PATH)


# ── Pydantic models ───────────────────────────────────────────────────────────

class RegisterIn(BaseModel):
    username: str = Field(..., min_length=3, max_length=32, pattern=r"^[A-Za-z0-9_\-]+$")
    email: str = Field(..., max_length=254)
    password: str = Field(..., min_length=8, max_length=128)


class LoginIn(BaseModel):
    username: str = Field(..., min_length=1, max_length=32)
    password: str = Field(..., min_length=1, max_length=128)


# ── FastAPI dependency ────────────────────────────────────────────────────────

def get_current_user(
    eg_session: Optional[str] = Cookie(None),
    authorization: Optional[str] = Header(None),
) -> Dict[str, Any]:
    """Validate the session cookie OR a Bearer token from the Authorization header.

    Mobile clients (React Native) pass their JWT as:
        Authorization: Bearer <token>
    Web clients use the HttpOnly cookie set at login.
    """
    # Prefer explicit Bearer token (mobile / API clients)
    if authorization:
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() == "bearer" and token:
            return _verify_token(token)
    # Fall back to cookie session (web)
    if eg_session:
        return _verify_token(eg_session)
    raise HTTPException(status_code=401, detail="Not authenticated.")


# ── cookie helper ─────────────────────────────────────────────────────────────

def _is_secure_context() -> bool:
    """Returns True when running behind HTTPS (set HTTPS_ONLY=1 in prod)."""
    return os.getenv("HTTPS_ONLY", "0") == "1"


def _set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        max_age=TOKEN_EXPIRY_SECONDS,
        path="/",
        httponly=True,
        samesite="lax",
        secure=_is_secure_context(),
    )


# ── routes ────────────────────────────────────────────────────────────────────

@router.post("/register", status_code=201)
def register(body: RegisterIn, response: Response) -> Dict[str, Any]:
    """Create a new account and set a session cookie."""
    # Minimal email format validation (no extra library)
    parts = body.email.split("@")
    if len(parts) != 2 or "." not in parts[1]:
        raise HTTPException(status_code=422, detail="Invalid email address.")

    pw_hash = _hash_password(body.password)
    try:
        with _DB_LOCK, _get_conn() as conn:
            conn.execute(
                "INSERT INTO users (username, email, pw_hash) VALUES (?, ?, ?)",
                (body.username, body.email.lower(), pw_hash),
            )
            conn.commit()
            row = conn.execute(
                "SELECT id, username FROM users WHERE username = ?", (body.username,)
            ).fetchone()
    except sqlite3.IntegrityError as exc:
        detail = str(exc).lower()
        if "username" in detail:
            raise HTTPException(status_code=409, detail="Username is already taken.")
        raise HTTPException(status_code=409, detail="Email is already registered.")

    token = _create_token(row["id"], row["username"])
    _set_session_cookie(response, token)
    return {"message": "Account created.", "username": row["username"]}


@router.post("/login")
def login(body: LoginIn, response: Response) -> Dict[str, Any]:
    """Validate credentials, set a session cookie, and return the username."""
    with _DB_LOCK, _get_conn() as conn:
        row = conn.execute(
            "SELECT id, username, pw_hash FROM users WHERE username = ?", (body.username,)
        ).fetchone()
    # Constant-time comparison regardless of whether user exists
    stored_hash = row["pw_hash"] if row else _hash_password("__dummy__")
    password_ok = _verify_password(body.password, stored_hash)
    if row is None or not password_ok:
        raise HTTPException(status_code=401, detail="Invalid username or password.")

    token = _create_token(row["id"], row["username"])
    _set_session_cookie(response, token)
    return {"message": "Logged in.", "username": row["username"]}


@router.post("/logout")
def logout(response: Response) -> Dict[str, str]:
    """Clear the session cookie."""
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"message": "Logged out."}


@router.get("/me")
def me(current_user: Dict[str, Any] = Depends(get_current_user)) -> Dict[str, Any]:
    """Return the currently authenticated user's info."""
    return {"user_id": current_user["sub"], "username": current_user["username"]}


@router.post("/token")
def get_token(body: LoginIn) -> Dict[str, Any]:
    """Return a raw JWT for mobile / API clients that cannot use cookies.

    POST /auth/token  {"username": "...", "password": "..."}
    Response:          {"token": "<jwt>", "username": "...", "expires_in": 604800}
    """
    with _DB_LOCK, _get_conn() as conn:
        row = conn.execute(
            "SELECT id, username, pw_hash FROM users WHERE username = ?", (body.username,)
        ).fetchone()
    stored_hash = row["pw_hash"] if row else _hash_password("__dummy__")
    password_ok = _verify_password(body.password, stored_hash)
    if row is None or not password_ok:
        raise HTTPException(status_code=401, detail="Invalid username or password.")
    token = _create_token(row["id"], row["username"])
    return {"token": token, "username": row["username"], "expires_in": TOKEN_EXPIRY_SECONDS}
