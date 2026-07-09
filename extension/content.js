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

// Sunburst de Claude (mismo mark que el popup / los iconos), en naranja marca.
const LOGO_SVG =
  '<svg viewBox="0 0 100 100" width="13" height="13" style="flex:none;color:#d97757" aria-hidden="true"><g fill="currentColor">' +
  '<circle cx="50" cy="50" r="6"/>' +
  [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330]
    .map(
      (a) =>
        `<path d="M50 47 Q45.8 25 50 7 Q54.2 25 50 47 Z" transform="rotate(${a} 50 50)"/>`
    )
    .join("") +
  "</g></svg>";

function overlayHeader() {
  return (
    '<div style="display:flex;align-items:center;gap:5px;margin-bottom:5px;font-weight:600;color:#f4f2ec">' +
    LOGO_SVG +
    "<span>Uso de Claude</span></div>"
  );
}

function colorFor(pct) {
  if (pct == null) return "#a8a29a";
  if (pct >= 90) return "#e05a4d";
  if (pct >= 65) return "#f0a03c";
  return "#d97757";
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
    background: "rgba(38,38,36,0.94)",
    color: "#f4f2ec",
    font: "11px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace",
    padding: "8px 10px",
    borderRadius: "10px",
    border: "1px solid rgba(240,238,230,0.14)",
    boxShadow: "0 6px 20px rgba(0,0,0,0.45)",
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
      <div style="height:6px;background:rgba(240,238,230,0.14);border-radius:4px;overflow:hidden;margin-top:2px">
        <div style="height:100%;width:${width}%;background:${color};border-radius:4px"></div>
      </div>
    </div>`;
}

function renderOverlay(latest) {
  const el = ensureOverlay();
  if (!latest) {
    el.innerHTML = overlayHeader() + `<div style="opacity:.7">sin datos</div>`;
    return;
  }
  if (!latest.ok) {
    el.innerHTML =
      overlayHeader() + `<div style="color:#f0a03c">no disponible</div>`;
    return;
  }
  el.innerHTML =
    overlayHeader() +
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
