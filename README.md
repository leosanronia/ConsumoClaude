# Medidor de Uso de Claude.ai

Extensión de Chrome (Manifest V3) que muestra, en tiempo real y con estilo de
**barra de batería**, cuánto llevas consumido de tu suscripción de Claude.ai:

- **% de la ventana de sesión** (rolling window de ~5 h).
- **% de la ventana semanal**.
- **Tiempo que falta** para el reinicio de cada ventana.
- Badge en el icono con el % de sesión, y notificaciones al cruzar 50 / 75 / 90 %.

Todo el procesamiento es **100 % local**. No hay servidor propio ni telemetría.

![Icono batería](extension/icons/icon128.png)

---

## Instalación (modo desarrollador)

1. Abre `chrome://extensions` (o `edge://extensions`).
2. Activa **Modo de desarrollador** (arriba a la derecha).
3. **Cargar descomprimida** → selecciona la carpeta [`extension/`](extension/).
4. Inicia sesión en <https://claude.ai> en una pestaña normal.
5. Abre el popup de la extensión. En pocos segundos debería mostrar tus dos barras.

> Requiere tener la sesión de claude.ai iniciada en el navegador. La extensión
> reutiliza esa sesión; **nunca lee ni guarda tu cookie** (viaja sola en el
> `fetch` gracias a `credentials: 'include'`).

---

## Cómo funciona

Anthropic **no** publica una API oficial de uso. La página *Configuración → Uso*
se alimenta de un **endpoint interno no documentado** de la propia web. Esta
extensión lee ese mismo endpoint desde el navegador, aprovechando que corre en
el contexto de claude.ai con la sesión ya autenticada.

- `background.js` (service worker) sincroniza cada 2 min vía `chrome.alarms`.
- Intenta el fetch de **dos formas** por robustez:
  1. Directo desde el service worker (`credentials: 'include'` + `host_permissions`).
  2. Si falla (p. ej. cookies `SameSite`), reenvía la petición a `content.js`
     dentro de una pestaña abierta de claude.ai (contexto first-party).
- `usage-parser.js` **normaliza** la respuesta de forma heurística: reconoce los
  campos de sesión / semanal / reinicio aunque cambien de nombre.
- El resultado se guarda en `chrome.storage.local` (último valor + historial).

### Arquitectura

```
extension/
├── manifest.json
├── background.js        # service worker: fetch, alarmas, badge, notificaciones
├── content.js           # relay de fetch first-party + overlay opcional (Fase 2)
├── popup/               # UI principal (barras de batería, countdown, sparkline)
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── lib/
│   ├── config.js        # endpoints candidatos, umbrales, intervalos
│   ├── usage-parser.js  # normalización heurística del JSON
│   └── storage.js       # modelo de datos, historial, settings
└── icons/               # 16 / 32 / 48 / 128 px
```

---

## Confirmar el endpoint real (paso recomendado)

La extensión trae una lista de endpoints candidatos y un parser flexible, así que
**puede funcionar out-of-the-box**. Pero como depende de una API interna, lo más
fiable es confirmar la URL exacta:

1. claude.ai → perfil → **Configuración → Uso**.
2. Abre **DevTools → pestaña Network → filtro `Fetch/XHR`**.
3. **Recarga** la página y localiza la llamada que trae los porcentajes de uso
   (busca algo como `/api/.../usage`).
4. Copia su **URL exacta**.
5. Pégala en el popup: engranaje ⚙ → **Endpoint manual** → *Guardar*.
   Usa `{org}` donde vaya el ID de organización si la URL lo incluye.

Con eso, la extensión deja de adivinar y usa tu endpoint confirmado (tiene
prioridad máxima y se guarda en `chrome.storage`, sin tocar código).

Mientras investigas, abre la consola del service worker
(`chrome://extensions` → *Inspeccionar vistas: service worker*) para ver los
intentos y las respuestas crudas que logea `background.js`.

---

## Privacidad y permisos (restricciones no negociables)

- **Cero servidor propio, cero telemetría externa.** Todo vive en
  `chrome.storage.local`.
- **Permisos mínimos.** Solo `https://claude.ai/*` en `host_permissions`; nada de
  acceso a otros sitios.
- **La cookie de sesión no se guarda** en ningún lado; se usa al vuelo.
- **Fallback visible.** Si el endpoint falla o cambia, la UI muestra un estado de
  error claro ("puede que Anthropic haya cambiado el endpoint") en vez de fallar
  en silencio o mostrar datos viejos sin avisar (los datos viejos, si existen, se
  muestran atenuados y marcados como "sin actualizar").

`permissions`: `storage`, `alarms`, `notifications`.
No se solicita `cookies` (innecesario: `credentials: 'include'` + `host_permissions`
basta), en línea con el criterio de permisos mínimos.

---

## Estado / niveles de color

| Uso        | Color            |
|------------|------------------|
| 0 – 64 %   | cian / verde     |
| 65 – 89 %  | ámbar            |
| 90 – 100 % | rojo (con pulso) |

---

## Solución de problemas

- **"No se pudo leer el uso…"** → asegúrate de tener la sesión de claude.ai
  iniciada y una pestaña abierta; luego pulsa ⟳.
- **"…ningún endpoint conocido devolvió el uso"** → Anthropic probablemente cambió
  la API. Sigue los pasos de *Confirmar el endpoint real* y pega la URL en Ajustes.
- **Las barras aparecen pero los números parecen raros** → abre la consola del
  service worker y revisa el JSON crudo logeado; ajusta las regex de
  `lib/usage-parser.js` o el endpoint.

---

## Riesgo conocido

Esta extensión depende de un **endpoint interno no documentado** de claude.ai, no
de una API pública soportada por Anthropic. **Puede dejar de funcionar sin previo
aviso** si Anthropic cambia su frontend. Es de **solo lectura** sobre los datos de
tu propia cuenta: no automatiza acciones ni afecta a terceros.

---

## Roadmap

- [x] Fase 1: popup + badge + alarmas + notificaciones + estado de error.
- [x] Fase 2 (opcional): overlay flotante dentro de claude.ai (activable en Ajustes).
- [ ] Auto-detección más fina de ventanas extra si Anthropic añade nuevos límites.
