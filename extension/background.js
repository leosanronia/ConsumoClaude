// background.js  (service worker, type: module)
// -----------------------------------------------------------------------------
// Nucleo de la extension:
//   - cada SYNC_PERIOD_MINUTES hace fetch al endpoint interno de uso de claude.ai
//   - normaliza la respuesta (usage-parser) y la guarda local (storage)
//   - pinta el badge del icono con el % de sesion
//   - dispara notificaciones al cruzar umbrales / al reiniciarse una ventana
//
// Estrategia de fetch (dos vias, por robustez):
//   1. Directo desde el service worker con credentials:'include' + host_permissions.
//   2. Si falla (p.ej. cookies SameSite), reenvia el fetch a un content script
//      dentro de una pestana de claude.ai (contexto first-party garantizado).
// La cookie NUNCA se lee ni se guarda; viaja sola gracias a credentials:'include'.
// -----------------------------------------------------------------------------

import {
  SYNC_PERIOD_MINUTES,
  NOTIFY_THRESHOLDS,
  ORG_ENDPOINT,
  USAGE_ENDPOINT_TEMPLATES,
  LEVEL_COLORS,
  levelFor,
} from "./lib/config.js";
import { normalizeUsage } from "./lib/usage-parser.js";
import {
  getLatest,
  saveLatest,
  getSettings,
  getNotifyState,
  saveNotifyState,
} from "./lib/storage.js";

const ALARM = "sync-usage";

// ---- Ciclo de vida ---------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  syncUsage();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  syncUsage();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) syncUsage();
});

function ensureAlarm() {
  chrome.alarms.create(ALARM, { periodInMinutes: SYNC_PERIOD_MINUTES });
}

// Refresh manual desde el popup.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "REFRESH_NOW") {
    syncUsage().then(async () => sendResponse(await getLatest()));
    return true; // respuesta asincrona
  }
});

// ---- Fetch con doble via ---------------------------------------------------

async function directJson(url) {
  try {
    const res = await fetch(url, {
      credentials: "include",
      headers: { accept: "application/json" },
    });
    if (!res.ok) return { ok: false, status: res.status };
    const text = await res.text();
    try {
      return { ok: true, json: JSON.parse(text) };
    } catch {
      // Respuesta no-JSON (probablemente HTML de login) => no autenticado.
      return { ok: false, status: res.status, notJson: true };
    }
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function relayJson(url) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: "https://claude.ai/*" });
  } catch {
    return { ok: false, noTab: true };
  }
  if (!tabs.length) return { ok: false, noTab: true };
  for (const tab of tabs) {
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, {
        type: "CLAUDE_USAGE_FETCH",
        url,
      });
      if (resp && resp.ok && resp.json !== undefined)
        return { ok: true, json: resp.json };
    } catch {
      // El content script aun no esta listo en esa pestana; probar la siguiente.
    }
  }
  return { ok: false, relayFailed: true };
}

// Devuelve { json } o info del fallo. Marca si obtuvimos algo de JSON.
async function getJson(url, diag) {
  const direct = await directJson(url);
  if (direct.ok) {
    diag.gotAnyJson = true;
    return { json: direct.json };
  }
  const relayed = await relayJson(url);
  if (relayed.ok) {
    diag.gotAnyJson = true;
    diag.usedRelay = true;
    return { json: relayed.json };
  }
  if (relayed.noTab) diag.noTab = true;
  return { json: undefined };
}

async function getOrgId(diag) {
  const { json } = await getJson(ORG_ENDPOINT, diag);
  if (Array.isArray(json) && json.length) {
    const org = json.find((o) => o && (o.uuid || o.id)) || json[0];
    return (org && (org.uuid || org.id)) || null;
  }
  // Algunos shapes envuelven en { organizations: [...] }.
  if (json && Array.isArray(json.organizations) && json.organizations.length) {
    const org = json.organizations[0];
    return org.uuid || org.id || null;
  }
  return null;
}

// ---- Sincronizacion --------------------------------------------------------

let syncing = false;

async function syncUsage() {
  if (syncing) return;
  syncing = true;
  const diag = { gotAnyJson: false, usedRelay: false, noTab: false };
  try {
    const settings = await getSettings();
    const orgId = await getOrgId(diag);

    // Construir lista de endpoints a probar (override del usuario primero).
    const templates = [];
    if (settings.endpointOverride) templates.push(settings.endpointOverride);
    templates.push(...USAGE_ENDPOINT_TEMPLATES);

    const endpoints = [];
    for (const tmpl of templates) {
      if (tmpl.includes("{org}")) {
        if (orgId) endpoints.push(tmpl.replace("{org}", orgId));
      } else {
        endpoints.push(tmpl);
      }
    }

    let success = null;
    const tried = [];
    for (const url of endpoints) {
      tried.push(url);
      const { json } = await getJson(url, diag);
      if (json === undefined) continue;
      const model = normalizeUsage(json, { endpoint: url });
      console.debug("[Claude Usage] intento", url, model.matched ? "OK" : "sin match", json);
      if (model.matched) {
        success = { model, raw: json, url };
        break;
      }
    }

    const prev = await getLatest();

    if (success) {
      const snapshot = {
        ok: true,
        session: success.model.session,
        weekly: success.model.weekly,
        others: success.model.others,
        endpoint: success.url,
        usedRelay: diag.usedRelay,
        fetched_at: success.model.fetched_at,
        raw: success.raw, // solo el ultimo, para depurar el shape
      };
      await saveLatest(snapshot);
      await updateBadge(snapshot);
      await handleNotifications(snapshot, settings, prev);
    } else {
      const error = classifyError(diag, endpoints.length, orgId);
      const snapshot = {
        ok: false,
        error: error.code,
        message: error.message,
        triedEndpoints: tried,
        fetched_at: new Date().toISOString(),
        // Conservamos el ultimo dato bueno para poder mostrarlo atenuado.
        stale: prev && prev.ok ? { session: prev.session, weekly: prev.weekly, fetched_at: prev.fetched_at } : null,
      };
      await saveLatest(snapshot);
      await updateBadge(snapshot);
      console.warn("[Claude Usage] sync fallo:", error, { tried, orgId });
    }
  } catch (e) {
    console.error("[Claude Usage] error inesperado en syncUsage", e);
  } finally {
    syncing = false;
  }
}

function classifyError(diag, endpointCount, orgId) {
  if (!diag.gotAnyJson) {
    if (diag.noTab && orgId == null) {
      return {
        code: "no_session",
        message:
          "No se pudo leer el uso. Inicia sesion en claude.ai (o abre una pestana) y reintenta.",
      };
    }
    return {
      code: "network",
      message:
        "No se obtuvo respuesta del servidor de claude.ai. Revisa tu sesion o conexion.",
    };
  }
  if (endpointCount === 0) {
    return {
      code: "no_org",
      message:
        "No se detecto la organizacion de la cuenta. Abre claude.ai e intenta de nuevo.",
    };
  }
  return {
    code: "endpoint_changed",
    message:
      "Se conecto a claude.ai pero ningun endpoint conocido devolvio el uso. Puede que Anthropic haya cambiado su API: confirma la URL con DevTools y pegala en Ajustes.",
  };
}

// ---- Badge del icono -------------------------------------------------------

async function updateBadge(snapshot) {
  if (snapshot && snapshot.ok) {
    const pct = snapshot.session?.pct ?? snapshot.weekly?.pct ?? null;
    if (pct == null) {
      await setBadge("", LEVEL_COLORS.safe);
      return;
    }
    const level = levelFor(pct);
    await setBadge(String(Math.round(pct)), LEVEL_COLORS[level] || LEVEL_COLORS.safe);
  } else {
    await setBadge("!", LEVEL_COLORS.danger);
  }
}

function setBadge(text, color) {
  return new Promise((resolve) => {
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color }, () => resolve());
  });
}

// ---- Notificaciones --------------------------------------------------------

const WIN_LABEL = { session: "de sesion", weekly: "semanal" };

async function handleNotifications(snapshot, settings) {
  if (!settings.notificationsEnabled) return;
  const state = await getNotifyState();
  const next = { ...state };

  for (const win of ["session", "weekly"]) {
    const pct = snapshot[win]?.pct;
    if (pct == null) continue;
    const last = state[win] || 0;

    // Reinicio: caida grande a un valor bajo entre lecturas.
    if (pct + 30 <= last && pct < 25) {
      notify(
        `Ventana ${WIN_LABEL[win]} reiniciada`,
        `Tu uso ${WIN_LABEL[win]} volvio a ${pct}%.`
      );
      next[win] = 0;
      continue;
    }

    // Umbral cruzado hacia arriba.
    let crossed = 0;
    for (const t of NOTIFY_THRESHOLDS) if (pct >= t) crossed = t;
    if (crossed > last) {
      notify(
        `Uso ${WIN_LABEL[win]} al ${crossed}%`,
        `Llevas ${pct}% de tu ventana ${WIN_LABEL[win]}.`
      );
      next[win] = crossed;
    } else if (crossed < last) {
      // Bajo de nivel sin reinicio completo: reajusta la linea base.
      next[win] = crossed;
    }
  }
  await saveNotifyState(next);
}

function notify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title,
    message,
    priority: 1,
  });
}
