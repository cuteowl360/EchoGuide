"use strict";

// ── shared helpers ────────────────────────────────────────────────────────────

function showError(el, msg) {
  el.textContent = msg;
  el.classList.remove("hidden");
}

function hideError(el) {
  el.textContent = "";
  el.classList.add("hidden");
}

async function apiPost(path, body) {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: { detail: "Network error. Please try again." } };
  }
}

// ── login page ────────────────────────────────────────────────────────────────

const loginForm = document.getElementById("loginForm");
if (loginForm) {
  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("loginError");
    hideError(errEl);

    const btn = loginForm.querySelector("button[type=submit]");
    btn.disabled = true;
    btn.textContent = "Signing in…";

    const { ok, data } = await apiPost("/auth/login", {
      username: document.getElementById("username").value.trim(),
      password: document.getElementById("password").value,
    });

    if (ok) {
      window.location.replace("/");
    } else {
      showError(errEl, data.detail || "Login failed. Check your credentials.");
      btn.disabled = false;
      btn.textContent = "Sign In";
    }
  });
}

// ── register page ─────────────────────────────────────────────────────────────

const registerForm = document.getElementById("registerForm");
if (registerForm) {
  registerForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("registerError");
    hideError(errEl);

    const username = document.getElementById("username").value.trim();
    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;
    const confirm = document.getElementById("confirm").value;

    if (password !== confirm) {
      showError(errEl, "Passwords do not match.");
      return;
    }
    if (!/^[A-Za-z0-9_\-]{3,32}$/.test(username)) {
      showError(errEl, "Username must be 3–32 characters: letters, numbers, _ or -");
      return;
    }

    const btn = registerForm.querySelector("button[type=submit]");
    btn.disabled = true;
    btn.textContent = "Creating account…";

    const { ok, data } = await apiPost("/auth/register", { username, email, password });

    if (ok) {
      window.location.replace("/");
    } else {
      showError(errEl, data.detail || "Registration failed. Please try again.");
      btn.disabled = false;
      btn.textContent = "Create Account";
    }
  });
}
