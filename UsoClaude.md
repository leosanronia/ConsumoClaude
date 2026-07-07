# Brief: Extensión de Chrome — Medidor de Uso de Claude.ai

## Objetivo

Extensión de navegador (Manifest V3) que muestra automáticamente, en tiempo real, cuánto uso llevo consumido de mi suscripción de Claude.ai — sin tener que entrar manualmente a Configuración → Uso.

Debe mostrar:
- % de uso de la ventana de **sesión** (se reinicia cada ~5 horas, es rolling window).
- % de uso de la ventana **semanal**.
- Cuánto **falta** para el reinicio de cada ventana (tiempo, no solo %).
- Visual estilo **barra de batería** (barra horizontal que se vacía/llena, con color que cambia según nivel: verde/cian en zona segura, ámbar en advertencia, rojo cerca del límite).

> **Nota importante para Claude Code:** Anthropic actualmente expone dos ventanas de uso — **sesión (5h rolling)** y **semanal** — no existe un límite "diario" separado como tal en la documentación oficial. Antes de construir la UI, hay que inspeccionar la respuesta real del endpoint (ver sección siguiente) para confirmar qué campos trae exactamente. Si solo trae sesión + semanal, diseñar la UI con esas dos barras (no forzar una tercera de "diario" que no exista en la data).

## Cómo se obtiene el dato (sin API pública)

No existe una API pública de Anthropic para leer el uso de una cuenta claude.ai. La página de Configuración → Uso se alimenta de un **endpoint interno no documentado** de la propia app web. La estrategia (usada por extensiones ya existentes como ClaudeKit y Claude Usage Tracker) es leer ese mismo endpoint desde el navegador, aprovechando que la extensión corre en el contexto de claude.ai con la sesión ya autenticada.

**Primer paso de implementación (manual, antes de escribir código):**
1. Ir a claude.ai → perfil → Configuración → Uso.
2. Abrir DevTools → pestaña Network → filtrar por `Fetch/XHR`.
3. Recargar la página y localizar la llamada que trae los porcentajes de uso (buscar algo como `/api/.../usage` o similar).
4. Documentar: URL exacta, método, headers requeridos, shape del JSON de respuesta (nombres de campos para % sesión, % semanal, timestamps de reinicio).
5. Confirmar si esa llamada requiere solo la cookie de sesión del navegador (lo más probable) o algún header adicional (org id, etc.).

Todo el diseño de abajo asume que el paso 1-5 se hace primero, porque el shape exacto del JSON determina el modelo de datos.

## Arquitectura

```
extension/
├── manifest.json
├── background.js        (service worker)
├── content.js            (se inyecta en claude.ai)
├── popup/
│   ├── popup.html
│   ├── popup.js
│   └── popup.css
├── icons/
└── lib/
    └── storage.js
```

### `manifest.json`
- `manifest_version: 3`
- `permissions`: `["storage", "alarms", "notifications", "cookies"]`
- `host_permissions`: `["https://claude.ai/*"]` (nada más — sin permisos amplios a otros sitios)
- `background`: service worker (`background.js`)
- `action`: popup (`popup/popup.html`)
- `content_scripts`: `content.js` inyectado en `https://claude.ai/*` (opcional, solo si se quiere badge overlay dentro del chat, ver "Fase 2")

### `background.js` (service worker)
Responsable de:
- `chrome.alarms.create('sync-usage', { periodInMinutes: 2 })` — sincronizar cada 2 min (ajustable).
- En cada alarma: hacer `fetch()` al endpoint interno detectado en el paso de investigación, usando `credentials: 'include'` para que viajen las cookies de sesión automáticamente (correr esto desde el service worker de la extensión, con `host_permissions` sobre claude.ai, permite leer la respuesta sin exponer la cookie directamente en código).
- Parsear la respuesta → normalizar a un modelo de datos interno (ver abajo).
- Guardar en `chrome.storage.local` (historial + último valor).
- Calcular umbrales cruzados (50/75/90%) y disparar `chrome.notifications.create(...)` si corresponde.
- Actualizar el ícono/badge de la extensión (`chrome.action.setBadgeText`) con el % de sesión actual, por ejemplo.

### `content.js` (Fase 2 — opcional)
- Inyecta un pequeño overlay/badge flotante sobre la interfaz de chat de claude.ai, para no depender de abrir el popup.
- Fase 1 puede omitir esto y depender solo del popup + badge del ícono de la extensión.

### `popup/` — la UI principal

**Diseño "barra de batería":**
- Dos barras horizontales (una para sesión, una para semanal), con esquinas redondeadas y una muesca tipo "terminal de batería" al lado derecho, imitando un ícono de batería real.
- Relleno con gradiente que cambia de color según el %: 0–65% cian/verde, 65–90% ámbar, 90–100% rojo con pulso/parpadeo sutil.
- Debajo de cada barra: texto con el % exacto y el tiempo estimado para el reinicio (ej. "62% usado · reinicia en 1h 40min").
- Un timestamp pequeño de "última actualización" (para que quede claro que no es instantáneo, sino el último sync).
- Historial opcional: un sparkline pequeño debajo de cada barra mostrando la tendencia de las últimas N lecturas (se puede reusar el mismo concepto visual que ya diseñamos: fondo oscuro, tipografía monoespaciada para los datos, acentos cian/ámbar).

### Modelo de datos (`storage.js`)

```js
// Estructura sugerida en chrome.storage.local
{
  "usage:latest": {
    session_pct: number,
    session_resets_at: ISOString,
    weekly_pct: number,
    weekly_resets_at: ISOString,
    fetched_at: ISOString
  },
  "usage:history": [
    { session_pct, weekly_pct, fetched_at },
    // ... últimas N lecturas, ej. últimas 200
  ]
}
```

### Notificaciones
- `chrome.notifications` al cruzar 50/75/90% en cualquiera de las dos ventanas.
- Notificación cuando una ventana se reinicia (pasa de un valor alto a uno bajo entre dos lecturas consecutivas).

## Restricciones de diseño (no negociables)

- **Cero servidor propio, cero telemetría externa.** Todo el procesamiento y almacenamiento es local (`chrome.storage.local`). Nada se envía a servidores de terceros.
- **Permisos mínimos.** Solo `claude.ai` en `host_permissions`. Nada de acceso a "todos los sitios".
- **Sin guardar la cookie de sesión en storage.** Se usa al vuelo (`credentials: 'include'` en el fetch) y no se persiste en ningún lado.
- **Fallback visible si el endpoint falla o cambia.** Como depende de un endpoint interno no documentado, la UI debe mostrar claramente un estado de "no se pudo leer el uso — puede que Anthropic haya cambiado el endpoint" en vez de fallar en silencio o mostrar datos viejos sin avisar.

## Riesgo conocido (documentar en el README del proyecto)

Esta extensión depende de un endpoint interno no documentado de claude.ai, no de una API pública soportada por Anthropic. Puede dejar de funcionar sin previo aviso si Anthropic cambia su frontend. Es de solo lectura sobre datos de la propia cuenta del usuario — no automatiza acciones ni afecta a terceros.

## Plan de construcción sugerido (orden para Claude Code)

1. Investigar y documentar el endpoint real (pasos manuales de la sección "Cómo se obtiene el dato").
2. `manifest.json` mínimo + `background.js` que haga el fetch y loguee la respuesta en consola (validar que funciona antes de construir UI).
3. Capa de storage (`storage.js`) con el modelo de datos.
4. Popup básico sin estilo — solo números crudos, para validar el flujo completo end-to-end.
5. Aplicar diseño "barra de batería" (colores, animación, sparkline).
6. Alarmas + notificaciones de umbral.
7. (Fase 2, opcional) Overlay inyectado vía `content.js` dentro de claude.ai.
8. Manejo de errores / estado "endpoint no disponible".

## Preguntas abiertas para resolver durante la construcción

- ¿El endpoint requiere algún header además de la cookie de sesión (ej. `anthropic-organization-id`)?
- ¿Qué shape exacto tiene la respuesta — nombres de campos reales para sesión/semanal/timestamps de reinicio?
- ¿Confirmar si existe alguna ventana adicional a sesión+semanal antes de diseñar una tercera barra "diaria"?
