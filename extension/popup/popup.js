// popup/popup.js  (type: module)
// -----------------------------------------------------------------------------
// Renderiza las barras de bateria (sesion + semanal), el countdown al reinicio,
// el sparkline de tendencia y el estado de error. Lee todo de chrome.storage;
// el service worker es quien hace el fetch real.
// -----------------------------------------------------------------------------

import {
  getLatest,
  getHistory,
  getSettings,
  saveSettings,
  clearHistory,
} from "../lib/storage.js";
import { levelFor } from "../lib/config.js";

const LEVELS = {
  safe: { stroke: "#22d3ee", fill: "rgba(34,211,238,0.16)" },
  warn: { stroke: "#f59e0b", fill: "rgba(245,158,11,0.16)" },
  danger: { stroke: "#ef4444", fill: "rgba(239,68,68,0.18)" },
  unknown: { stroke: "#64748b", fill: "rgba(100,116,139,0.12)" },
};

const $ = (sel, root = document) => root.querySelector(sel);

const el = {
  error: $("#error"),
  refresh: $("#refresh"),
  gear: $("#gear"),
  settings: $("#settings"),
  endpoint: $("#endpoint"),
  overlay: $("#overlay"),
  notif: $("#notif"),
  save: $("#save"),
  clearHist: $("#clearHist"),
  updated: $("#updated"),
  via: $("#via"),
  meters: {
    session: $('.meter[data-win="session"]'),
    weekly: $('.meter[data-win="weekly"]'),
  },
};

// Estado en memoria para el tick del countdown.
let currentWins = { session: null, weekly: null };
let currentFetchedAt = null;
let currentStale = false;

// ---- Formateadores ---------------------------------------------------------

function fmtCountdown(iso) {
  if (!iso) return "sin dato de reinicio";
  const ms = new Date(iso).getTime() - Date.now();
  if (isNaN(ms)) return "sin dato de reinicio";
  if (ms <= 0) return "reinicia pronto";
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 24) {
    const d = Math.floor(h / 24);
    return `reinicia en ${d}d ${h % 24}h`;
  }
  if (h > 0) return `reinicia en ${h}h ${m}min`;
  if (totalMin > 0) return `reinicia en ${m}min`;
  return `reinicia en ${Math.floor(ms / 1000)}s`;
}

function fmtAgo(iso) {
  if (!iso) return "—";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (isNaN(s)) return "—";
  if (s < 5) return "hace un momento";
  if (s < 60) return `hace ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m}min`;
  const h = Math.floor(m / 60);
  return `hace ${h}h`;
}

// ---- Render ----------------------------------------------------------------

function setMeter(win, data) {
  const root = el.meters[win];
  const pct = data ? data.pct : null;
  const level = levelFor(pct);
  const fill = $('[data-role="fill"]', root);
  const pctEl = $('[data-role="pct"]', root);
  const resetEl = $('[data-role="reset"]', root);
  const spark = $('[data-role="spark"]', root);

  pctEl.textContent = pct == null ? "––%" : `${pct}%`;
  fill.className = `battery-fill ${level}`;
  fill.style.width = pct == null ? "0%" : `${Math.min(100, Math.max(0, pct))}%`;
  resetEl.textContent = fmtCountdown(data ? data.resets_at : null);

  currentWins[win] = data || null;
  drawSpark(spark, win, level);
}

let historyCache = [];

function drawSpark(canvas, win, level) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const key = win === "session" ? "session_pct" : "weekly_pct";
  const values = historyCache
    .map((h) => h[key])
    .filter((v) => typeof v === "number")
    .slice(-48);
  if (values.length < 2) return;

  const colors = LEVELS[level] || LEVELS.unknown;
  const pad = 3;
  const stepX = W / (values.length - 1);
  const y = (v) => H - pad - (Math.min(100, Math.max(0, v)) / 100) * (H - 2 * pad);

  ctx.beginPath();
  values.forEach((v, i) => {
    const px = i * stepX;
    const py = y(v);
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  });
  ctx.strokeStyle = colors.stroke;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.stroke();

  ctx.lineTo(W, H);
  ctx.lineTo(0, H);
  ctx.closePath();
  ctx.fillStyle = colors.fill;
  ctx.fill();
}

function showError(msg) {
  el.error.textContent = msg;
  el.error.classList.remove("hidden");
}
function hideError() {
  el.error.classList.add("hidden");
}
function setStale(on) {
  currentStale = on;
  el.meters.session.classList.toggle("stale", on);
  el.meters.weekly.classList.toggle("stale", on);
}

async function render() {
  const [latest, history] = await Promise.all([getLatest(), getHistory()]);
  historyCache = history || [];

  if (!latest) {
    hideError();
    setStale(false);
    setMeter("session", null);
    setMeter("weekly", null);
    currentFetchedAt = null;
    el.updated.textContent = "Sin lecturas todavia";
    el.via.textContent = "";
    return;
  }

  if (latest.ok) {
    hideError();
    setStale(false);
    setMeter("session", latest.session);
    setMeter("weekly", latest.weekly);
    currentFetchedAt = latest.fetched_at;
    el.via.textContent = latest.usedRelay ? "via pestana" : "";
  } else {
    showError(latest.message || "No se pudo leer el uso de claude.ai.");
    if (latest.stale) {
      setStale(true);
      setMeter("session", latest.stale.session);
      setMeter("weekly", latest.stale.weekly);
      currentFetchedAt = latest.stale.fetched_at;
    } else {
      setStale(false);
      setMeter("session", null);
      setMeter("weekly", null);
      currentFetchedAt = null;
    }
    el.via.textContent = "";
  }
  updateFooter();
}

function updateFooter() {
  if (!currentFetchedAt) {
    el.updated.textContent = currentStale ? "Sin actualizar" : "—";
    return;
  }
  const prefix = currentStale ? "Ultimo dato" : "Actualizado";
  el.updated.textContent = `${prefix} ${fmtAgo(currentFetchedAt)}`;
}

// Tick: refresca countdown y "hace X" sin re-leer storage.
function tick() {
  for (const win of ["session", "weekly"]) {
    const data = currentWins[win];
    const resetEl = $('[data-role="reset"]', el.meters[win]);
    resetEl.textContent = fmtCountdown(data ? data.resets_at : null);
  }
  updateFooter();
}

// ---- Ajustes ---------------------------------------------------------------

async function openSettings() {
  const s = await getSettings();
  el.endpoint.value = s.endpointOverride || "";
  el.overlay.checked = !!s.showOverlay;
  el.notif.checked = !!s.notificationsEnabled;
  el.settings.classList.toggle("hidden");
}

async function saveSettingsFromUI() {
  await saveSettings({
    endpointOverride: el.endpoint.value.trim(),
    showOverlay: el.overlay.checked,
    notificationsEnabled: el.notif.checked,
  });
  el.settings.classList.add("hidden");
  triggerRefresh();
}

// ---- Refresh ---------------------------------------------------------------

async function triggerRefresh() {
  el.refresh.classList.add("spin");
  try {
    await chrome.runtime.sendMessage({ type: "REFRESH_NOW" });
  } catch {
    /* el service worker respondera via storage.onChanged igualmente */
  }
  setTimeout(() => el.refresh.classList.remove("spin"), 600);
  render();
}

// ---- Eventos ---------------------------------------------------------------

el.refresh.addEventListener("click", triggerRefresh);
el.gear.addEventListener("click", openSettings);
el.save.addEventListener("click", saveSettingsFromUI);
el.clearHist.addEventListener("click", async () => {
  await clearHistory();
  render();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes["usage:latest"] || changes["usage:history"]) render();
});

// ---- Arranque --------------------------------------------------------------

render();
triggerRefresh(); // pide un sync fresco al abrir el popup
setInterval(tick, 1000);
