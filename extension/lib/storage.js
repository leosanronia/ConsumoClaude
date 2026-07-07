// lib/storage.js
// -----------------------------------------------------------------------------
// Unica puerta de acceso a chrome.storage.local. Todo el estado vive local:
// cero servidor, cero telemetria (restriccion no negociable del brief).
// La cookie de sesion NUNCA se guarda aqui: se usa al vuelo en el fetch.
// -----------------------------------------------------------------------------

import {
  STORAGE_KEYS,
  DEFAULT_SETTINGS,
  HISTORY_LIMIT,
} from "./config.js";

function get(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}
function set(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

// ---- Ultimo valor ----------------------------------------------------------

export async function getLatest() {
  const data = await get(STORAGE_KEYS.latest);
  return data[STORAGE_KEYS.latest] || null;
}

/**
 * Guarda el ultimo snapshot (modelo normalizado + estado ok/error) y, si hay
 * porcentajes validos, empuja una entrada al historial.
 */
export async function saveLatest(snapshot) {
  await set({ [STORAGE_KEYS.latest]: snapshot });
  if (snapshot && snapshot.ok) {
    await pushHistory({
      session_pct: snapshot.session?.pct ?? null,
      weekly_pct: snapshot.weekly?.pct ?? null,
      fetched_at: snapshot.fetched_at,
    });
  }
}

// ---- Historial -------------------------------------------------------------

export async function getHistory() {
  const data = await get(STORAGE_KEYS.history);
  return data[STORAGE_KEYS.history] || [];
}

export async function pushHistory(entry) {
  const history = await getHistory();
  history.push(entry);
  // Recorta a las ultimas HISTORY_LIMIT lecturas.
  const trimmed = history.slice(-HISTORY_LIMIT);
  await set({ [STORAGE_KEYS.history]: trimmed });
  return trimmed;
}

export async function clearHistory() {
  await set({ [STORAGE_KEYS.history]: [] });
}

// ---- Settings --------------------------------------------------------------

export async function getSettings() {
  const data = await get(STORAGE_KEYS.settings);
  return { ...DEFAULT_SETTINGS, ...(data[STORAGE_KEYS.settings] || {}) };
}

export async function saveSettings(partial) {
  const current = await getSettings();
  const next = { ...current, ...partial };
  await set({ [STORAGE_KEYS.settings]: next });
  return next;
}

// ---- Estado de notificaciones (ultimo umbral cruzado por ventana) ----------

export async function getNotifyState() {
  const data = await get(STORAGE_KEYS.notifyState);
  return data[STORAGE_KEYS.notifyState] || { session: 0, weekly: 0 };
}

export async function saveNotifyState(state) {
  await set({ [STORAGE_KEYS.notifyState]: state });
}
