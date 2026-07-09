// lib/config.js
// -----------------------------------------------------------------------------
// Configuracion central de la extension.
//
// IMPORTANTE (leer el brief UsoClaude.md, seccion "Como se obtiene el dato"):
// Anthropic NO publica una API oficial de uso. La pagina Configuracion -> Uso
// se alimenta de un endpoint interno NO documentado. Esta extension intenta
// descubrirlo automaticamente probando varios candidatos, pero la forma
// robusta es:
//
//   1. Abrir claude.ai -> Configuracion -> Uso.
//   2. DevTools -> Network -> filtro Fetch/XHR -> recargar.
//   3. Localizar la llamada que trae los % de uso.
//   4. Copiar su URL exacta y pegarla en el popup (engranaje -> "Endpoint
//      manual"), o anadirla a USAGE_ENDPOINT_TEMPLATES de abajo.
//
// El parser (usage-parser.js) es heuristico: intenta reconocer los campos de
// sesion / semanal aunque cambien de nombre. Si Anthropic cambia el shape,
// la UI mostrara un estado de error claro en vez de datos viejos.
// -----------------------------------------------------------------------------

// Cada cuantos minutos sincroniza el service worker (chrome.alarms).
export const SYNC_PERIOD_MINUTES = 2;

// Cuantas lecturas guarda el historial (para el sparkline / tendencia).
export const HISTORY_LIMIT = 200;

// Umbrales (%) que disparan notificacion al cruzarse hacia arriba.
export const NOTIFY_THRESHOLDS = [50, 75, 90];

// Endpoint que lista las organizaciones del usuario. De aqui sacamos el
// org UUID que suele necesitar el endpoint de uso.
export const ORG_ENDPOINT = "https://claude.ai/api/organizations";

// Plantillas candidatas para el endpoint de uso. Se prueban EN ORDEN hasta que
// una devuelva JSON valido y parseable. `{org}` se reemplaza por el UUID de la
// organizacion. Son mejores-esfuerzos: confirmar el real con DevTools (arriba).
//
// Si tu inspeccion revela la URL exacta, ponla primera en esta lista o, mejor,
// guardala desde el popup (se persiste en settings.endpointOverride y tiene
// prioridad sobre esta lista sin tocar codigo).
export const USAGE_ENDPOINT_TEMPLATES = [
  "https://claude.ai/api/organizations/{org}/usage",
  "https://claude.ai/api/organizations/{org}/usage_limits",
  "https://claude.ai/api/organizations/{org}/rate_limit",
  "https://claude.ai/api/organizations/{org}/usage_summary",
  "https://claude.ai/api/bootstrap/{org}/usage",
  "https://claude.ai/api/usage",
];

// Claves de chrome.storage.local.
export const STORAGE_KEYS = {
  latest: "usage:latest",
  history: "usage:history",
  settings: "usage:settings",
  notifyState: "usage:notifyState", // ultimo umbral notificado por ventana
};

// Settings por defecto (editables desde el popup).
export const DEFAULT_SETTINGS = {
  endpointOverride: "", // URL exacta confirmada por el usuario (prioridad maxima)
  showOverlay: false, // badge flotante dentro de claude.ai (Fase 2)
  notificationsEnabled: true,
};

// Colores por nivel de uso (deben coincidir con popup.css).
export const LEVEL_COLORS = {
  safe: "#d97757", // naranja Claude
  warn: "#f0a03c", // ambar
  danger: "#e05a4d", // rojo
};

// Devuelve el "nivel" segun el porcentaje.
export function levelFor(pct) {
  if (pct == null || Number.isNaN(pct)) return "unknown";
  if (pct >= 90) return "danger";
  if (pct >= 65) return "warn";
  return "safe";
}
