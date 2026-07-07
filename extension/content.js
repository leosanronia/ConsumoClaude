// content.js  (inyectado en https://claude.ai/*)
// -----------------------------------------------------------------------------
// Dos funciones, ambas ligeras:
//   1. Relay de fetch: cuando el service worker no puede leer el endpoint
//      directamente (p.ej. cookies SameSite), le reenvia la peticion a este
//      script, que corre en el origen first-party de claude.ai y por tanto
//      siempre tiene la cookie de sesion.
//   2. Overlay opcional (Fase 2): un pequeno badge flotante con las dos barras,
//      para no depender de abrir el popup. Desactivado por defecto.
// -----------------------------------------------------------------------------

// ---- 1. Relay de fetch -----------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "CLAUDE_USAGE_FETCH") {
    fetch(msg.url, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    })
      .then(async (res) => {
        const text = await res.text();
        try {
          sendResponse({ ok: res.ok, json: JSON.parse(text) });
        } catch {
          sendResponse({ ok: false, notJson: true, status: res.status });
        }
      })
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // respuesta asincrona
  }
});

// ---- 2. Overlay opcional ---------------------------------------------------

const OVERLAY_ID = "claude-usage-overlay";

function colorFor(pct) {
  if (pct == null) return "#64748b";
  if (pct >= 90) return "#ef4444";
  if (pct >= 65) return "#f59e0b";
  return "#22d3ee";
}

function ensureOverlay() {
  let el = document.getElementById(OVERLAY_ID);
  if (el) return el;
  el = document.createElement("div");
  el.id = OVERLAY_ID;
  Object.assign(el.style, {
    position: "fixed",
    bottom: "16px",
    right: "16px",
    zIndex: "2147483647",
    background: "rgba(15,23,42,0.92)",
    color: "#e2e8f0",
    font: "11px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace",
    padding: "8px 10px",
    borderRadius: "10px",
    border: "1px solid rgba(148,163,184,0.25)",
    boxShadow: "0 6px 20px rgba(0,0,0,0.35)",
    width: "150px",
    pointerEvents: "none",
    backdropFilter: "blur(4px)",
  });
  document.documentElement.appendChild(el);
  return el;
}

function removeOverlay() {
  const el = document.getElementById(OVERLAY_ID);
  if (el) el.remove();
}

function miniBar(label, pct) {
  const color = colorFor(pct);
  const width = pct == null ? 0 : Math.min(100, Math.max(0, pct));
  const txt = pct == null ? "--" : `${pct}%`;
  return `
    <div style="margin:2px 0">
      <div style="display:flex;justify-content:space-between;opacity:.8">
        <span>${label}</span><span>${txt}</span>
      </div>
      <div style="height:6px;background:rgba(148,163,184,0.2);border-radius:4px;overflow:hidden;margin-top:2px">
        <div style="height:100%;width:${width}%;background:${color};border-radius:4px"></div>
      </div>
    </div>`;
}

function renderOverlay(latest) {
  const el = ensureOverlay();
  if (!latest) {
    el.innerHTML = `<div style="opacity:.7">Uso de Claude: sin datos</div>`;
    return;
  }
  if (!latest.ok) {
    el.innerHTML = `<div style="color:#f59e0b">Uso: no disponible</div>`;
    return;
  }
  el.innerHTML =
    miniBar("Sesion", latest.session?.pct ?? null) +
    miniBar("Semanal", latest.weekly?.pct ?? null);
}

async function refreshOverlay() {
  const data = await chrome.storage.local.get(["usage:settings", "usage:latest"]);
  const settings = data["usage:settings"] || {};
  if (settings.showOverlay) {
    renderOverlay(data["usage:latest"] || null);
  } else {
    removeOverlay();
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes["usage:latest"] || changes["usage:settings"]) refreshOverlay();
});

refreshOverlay();
