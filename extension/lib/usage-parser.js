// lib/usage-parser.js
// -----------------------------------------------------------------------------
// Normaliza la respuesta (de shape desconocido) del endpoint interno de uso a
// un modelo estable que consume el resto de la extension.
//
// Como NO conocemos el shape exacto de antemano (hay que inspeccionarlo con
// DevTools, ver config.js), el parser es HEURISTICO: recorre el JSON entero y
// reconoce, por nombre de campo y forma del valor:
//   - porcentajes de uso            (pct / percent / utilization / ratio ...)
//   - pares usado/limite            (used + limit  ->  pct calculado)
//   - timestamps de reinicio        (resets_at / renews_at / expires_at ...)
// y los clasifica en ventana de "sesion" (5h) o "semanal" segun el contexto.
//
// Si el endpoint real resulta tener nombres muy distintos, basta con ampliar
// las expresiones regulares de abajo; el resto de la extension no cambia.
// -----------------------------------------------------------------------------

const RX = {
  weekly: /week|weekly|7[\s_-]?day|7d|seven[\s_-]?day/i,
  session: /session|five[\s_-]?hour|5[\s_-]?hour|5h|rolling|hourly/i,
  percent: /(pct|percent|percentage|utiliz|usage_ratio|use_ratio|ratio|fraction)/i,
  // "count"/"current" se quitaron a proposito: son tan genericos que cruzaban
  // contadores no relacionados con el limite y producian un falso 100%.
  used: /(used|consumed|spent|utilized)/i,
  limit: /(limit|max|cap|quota|allowance|total|budget)/i,
  remaining: /(remaining|left|available)/i,
  reset: /(reset|renew|refresh|expire|next[\s_-]?reset|window[\s_-]?end|ends?[\s_-]?at|period[\s_-]?end)/i,
};

function classify(pathLower) {
  if (RX.weekly.test(pathLower)) return "weekly";
  if (RX.session.test(pathLower)) return "session";
  return "other";
}

// Recorre recursivamente el objeto llamando a visit(key, value, path, parent).
function walk(node, path, visit) {
  if (!node || typeof node !== "object") return;
  for (const [k, v] of Object.entries(node)) {
    const p = path ? `${path}.${k}` : k;
    visit(k, v, p, node);
    if (v && typeof v === "object") walk(v, p, visit);
  }
}

// Convierte un valor a porcentaje 0..100 (o null si no aplica).
function toPercent(value, keyLower) {
  if (typeof value !== "number" || !isFinite(value)) return null;
  const looksRatio =
    /ratio|fraction/.test(keyLower) || (value >= 0 && value <= 1);
  let pct = looksRatio ? value * 100 : value;
  if (pct < 0) return null;
  if (pct > 100) pct = 100; // acotar; a veces reportan >100 por redondeos
  return Math.round(pct * 10) / 10;
}

// Intenta interpretar un valor como timestamp de reinicio -> ISO string.
function toIso(value) {
  if (value == null) return null;
  if (typeof value === "number" && isFinite(value)) {
    // epoch en segundos vs milisegundos
    const ms = value > 1e12 ? value : value > 1e9 ? value * 1000 : null;
    if (ms == null) return null;
    const d = new Date(ms);
    return isNaN(d) ? null : d.toISOString();
  }
  if (typeof value === "string") {
    const d = new Date(value);
    return isNaN(d) ? null : d.toISOString();
  }
  return null;
}

// Recolecta pares usado/limite dentro de cada objeto para calcular % cuando no
// viene un porcentaje explicito.
function pairPercentForObject(obj) {
  let used = null,
    limit = null,
    remaining = null;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v !== "number" || !isFinite(v)) continue;
    const kl = k.toLowerCase();
    if (limit == null && RX.limit.test(kl)) limit = v;
    else if (remaining == null && RX.remaining.test(kl)) remaining = v;
    else if (used == null && RX.used.test(kl)) used = v;
  }
  if (limit != null && limit > 0) {
    // Sanidad: un par valido cumple 0 <= usado <= limite (con un pelin de
    // tolerancia por redondeo). Si "usado" supera al limite es que cruzamos
    // campos no relacionados -> lo descartamos en vez de recortarlo a 100%,
    // que es justo lo que causaba el falso 100% semanal.
    const tol = limit * 1.02;
    if (used != null && used >= 0 && used <= tol)
      return { pct: clampPct((used / limit) * 100), used, limit };
    if (remaining != null && remaining >= 0 && remaining <= tol)
      return { pct: clampPct(((limit - remaining) / limit) * 100), used: limit - remaining, limit };
  }
  return null;
}

function clampPct(p) {
  if (p == null || !isFinite(p)) return null;
  return Math.round(Math.min(100, Math.max(0, p)) * 10) / 10;
}

/**
 * @param {any} raw  JSON crudo del endpoint.
 * @param {object} meta  { endpoint }
 * @returns modelo normalizado
 */
export function normalizeUsage(raw, meta = {}) {
  const now = new Date().toISOString();
  const percents = []; // { cls, pct, path }
  const resets = []; // { cls, iso, path }
  const pairs = []; // { cls, pct, used, limit, path }
  const seenObjects = new Set();

  walk(raw, "", (key, value, path, parent) => {
    const pathLower = path.toLowerCase();
    const keyLower = key.toLowerCase();
    const cls = classify(pathLower);

    // Porcentaje explicito
    if (RX.percent.test(keyLower)) {
      const pct = toPercent(value, keyLower);
      if (pct != null) percents.push({ cls, pct, path });
    }

    // Timestamp de reinicio
    if (RX.reset.test(keyLower)) {
      const iso = toIso(value);
      if (iso) resets.push({ cls, iso, path });
    }

    // Pares usado/limite (una vez por objeto contenedor)
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (!seenObjects.has(value)) {
        seenObjects.add(value);
        const pair = pairPercentForObject(value);
        if (pair && pair.pct != null)
          pairs.push({ cls: classify(pathLower), ...pair, path });
      }
    }
  });

  // Tambien evaluar el objeto raiz por si los pares estan al primer nivel.
  if (raw && typeof raw === "object" && !seenObjects.has(raw)) {
    const rootPair = pairPercentForObject(raw);
    if (rootPair && rootPair.pct != null)
      pairs.push({ cls: "other", ...rootPair, path: "(root)" });
  }

  const pick = (cls) => {
    const pctExplicit = percents.find((x) => x.cls === cls);
    const pctPair = pairs.find((x) => x.cls === cls);
    const reset = resets.find((x) => x.cls === cls);
    const chosen = pctExplicit || pctPair;
    if (!chosen && !reset) return null;
    return {
      pct: chosen ? chosen.pct : null,
      resets_at: reset ? reset.iso : null,
      used: pctPair ? pctPair.used : null,
      limit: pctPair ? pctPair.limit : null,
      source_path: chosen ? chosen.path : reset ? reset.path : null,
    };
  };

  const session = pick("session");
  const weekly = pick("weekly");

  // Ventanas "other" no clasificadas (para depurar shapes inesperados / extras)
  const others = [
    ...percents.filter((x) => x.cls === "other").map((x) => ({ ...x, kind: "pct" })),
    ...pairs.filter((x) => x.cls === "other").map((x) => ({ ...x, kind: "pair" })),
  ];

  const matched = !!(session?.pct != null || weekly?.pct != null);

  return {
    ok: matched,
    matched,
    session: session || { pct: null, resets_at: null },
    weekly: weekly || { pct: null, resets_at: null },
    others,
    endpoint: meta.endpoint || null,
    fetched_at: now,
    // raw se guarda aparte solo para debug; no lo persistimos entero por defecto.
  };
}
