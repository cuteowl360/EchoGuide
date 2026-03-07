/**
 * API client for EchoGuide mobile.
 * - Stores the JWT token in AsyncStorage after login.
 * - Sends it as  Authorization: Bearer <token>  on every request.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { BACKEND_URL, REQUEST_TIMEOUT_MS } from "./config";

const TOKEN_KEY = "@echoguide_token";

// ── Token helpers ─────────────────────────────────────────────────────────────

export async function getToken() {
  return AsyncStorage.getItem(TOKEN_KEY);
}

export async function saveToken(token) {
  await AsyncStorage.setItem(TOKEN_KEY, token);
}

export async function clearToken() {
  await AsyncStorage.removeItem(TOKEN_KEY);
}

// ── Base request ──────────────────────────────────────────────────────────────

async function request(path, options = {}) {
  const token = await getToken();
  const headers = { ...(options.headers || {}) };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${BACKEND_URL}${path}`, {
      ...options,
      headers,
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") throw new Error("Request timed out.");
    throw err;
  }
}

// ── Auth endpoints ────────────────────────────────────────────────────────────

export async function login(username, password) {
  const res = await request("/auth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Login failed (${res.status})`);
  }
  const data = await res.json();
  await saveToken(data.token);
  return data;
}

export async function register(username, email, password) {
  const res = await request("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, email, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Registration failed (${res.status})`);
  }
  // Register uses cookie-based session — get a token via /auth/token
  const data = await res.json();
  const tokenRes = await login(username, password);
  return { ...data, ...tokenRes };
}

export async function getMe() {
  const res = await request("/auth/me");
  if (!res.ok) return null;
  return res.json();
}

export async function logout() {
  await clearToken();
}

// ── Multipart helpers ─────────────────────────────────────────────────────────

function makeForm(imageUri, extraFields = {}) {
  const form = new FormData();
  form.append("image", {
    uri: imageUri,
    type: "image/jpeg",
    name: "photo.jpg",
  });
  for (const [key, value] of Object.entries(extraFields)) {
    form.append(key, String(value));
  }
  return form;
}

// ── Feature endpoints ─────────────────────────────────────────────────────────

export async function scanScene(imageUri) {
  const res = await request("/scan_scene", {
    method: "POST",
    body: makeForm(imageUri, {
      question: "Describe this image clearly for a visually impaired user.",
    }),
  });
  if (!res.ok) throw new Error(`Scan failed (${res.status})`);
  return res.json();
}

export async function readText(imageUri) {
  const res = await request("/read_text", {
    method: "POST",
    body: makeForm(imageUri),
  });
  if (!res.ok) throw new Error(`Read text failed (${res.status})`);
  return res.json();
}

export async function identifyAllPersons(imageUri) {
  const res = await request("/identify_all_persons", {
    method: "POST",
    body: makeForm(imageUri),
  });
  if (!res.ok) throw new Error(`Identify failed (${res.status})`);
  return res.json();
}

export async function rememberPerson(imageUri, name) {
  const res = await request("/remember_person", {
    method: "POST",
    body: makeForm(imageUri, { name }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Save failed (${res.status})`);
  }
  return res.json();
}

export async function guideScan(imageUri) {
  const res = await request("/guide/scan", {
    method: "POST",
    body: makeForm(imageUri),
  });
  if (!res.ok) throw new Error(`Guide scan failed (${res.status})`);
  return res.json();
}

export async function speakText(text) {
  const form = new FormData();
  form.append("text", text);
  const res = await request("/voice_response", { method: "POST", body: form });
  if (!res.ok) return null;
  // Returns audio/mpeg — caller can play it via expo-av
  return res.blob();
}
