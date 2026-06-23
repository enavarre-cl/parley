# Auditoría profunda — Parley vs. BEST-PRACTICES.md

> Estado del código medido contra las **166 reglas** de [BEST-PRACTICES.md](BEST-PRACTICES.md) +
> caza de bugs reales. Fecha 2026-06-22 · v1.5.6 · rama `master`.
>
> **Método:** suite de validación ejecutada + **6 auditores en paralelo** leyendo COMPLETOS los
> archivos de cada subsistema (providers, loop agéntico/tools, webview/render, host/orquestación,
> motores locales, CSS/i18n). Cada hallazgo apunta a código real con archivo:línea. ~80 hallazgos.
>
> La suite pasa (tsc 0 / eslint 0 / 48 tests / 0 archivos >500). **Casi nada de esto lo detecta la
> suite**: son bugs de lógica, de seguridad y de concurrencia que solo salen leyendo el código.

---

## 📋 Inventario completo (67 hallazgos · 10 ✅ · 57 ⬜)

> ID estable por subsistema. ✅ = corregido y commiteado · ⬜ = pendiente. Detalle de cada uno en
> su sección. Severidad: 🔴 crítico · 🟠 alta · 🟡 media · ⚪ baja/convención.

**Críticos (seguridad / pérdida de datos)**
- ✅ C1 🔴 XSS control-char en links · ✅ C2 🔴 symlink en fs_search/glob · ✅ C3 🔴 fs_write→.mcp RCE
- ✅ C4 🔴 `</script>` inline · ✅ C5 🔴 path traversal en voice (messageRouter:133) · ✅ C6 🔴 SSRF redirects
- ✅ C7 🔴 wipe de answer en abort · ✅ C8 🔴 parseDoc crash con `null` + pérdida round-trip · ✅ C9 🔴 attachmentStore tmp/cache
- **🔴 Críticos: 9/9 ✅ COMPLETO**

**Providers**
- ✅ P1 stream flush final · ✅ P2 stream reader release · ✅ P3 🟠 AbortSignal chequeado en read-loop
- ✅ P4 🟡 timeout de red · ✅ P5 🟡 tool-call id con índice · ✅ P6 🟡 isImageOutputModel ajustado
- ✅ P7 🟡 anthropic temperature:1 fijado · ✅ P8 🟡 defensive cap 64MiB · ⬜ P9 🟡 gemini functionResponse sin validar toolName
- ✅ P10 ⚪ multiple tool_calls por id · ⬜ P11 ⚪ baseUrl sin validar (4 providers) · ⬜ P12 🟡 `any` en bodies de request

**Loop agéntico / tools**
- ✅ A1 🟠 abort persiste assistant+toolCalls sin respuesta · ✅ A2 🟠 tools en paralelo · ⬜ A3 🟡 fs_search síncrono bloquea event loop
- **🟠 Altas: COMPLETAS** (P3, A1, A2, W2, H1, H4, L2, L3 + H3 reclasificado)
- ✅ A4 🟡 mcp dispose zombie · ✅ A5 🟡 mcp ignora isError · ✅ A6 🟡 mcp buffer stdio acotado
- ✅ A7 🟡 mcp servidor caído falla rápido · ⬜ A8 🟡 inference traga error de args JSON · ⬜ A9 ⚪ MAX_ITERS=0 sin tope · ✅ A10 ⚪ mcp captura stderr

**Webview**
- ✅ W1 🟡 botón regenerar ausente tras tools (reportado) · ✅ W2 🟠 colisión placeholder code-span · ⬜ W3 🟡 listas anidadas se aplanan
- ⬜ W4 🟡 processMermaid flotante + race · ⬜ W5 🟡 conversation.js god-view (refactor) · ⬜ W6 ⚪ escapeHtml revienta con no-string · ⬜ W7 ⚪ mermaid unescape deprecado

**Host / orquestación**
- ✅ H1 🟠 secrets.onDidChange sin disposable · ✅ H2 router floating promise · 🔎 H3 revisado: NO es bug (convención F4, funcionalmente correcto)
- ✅ H4 🟠 summary.upTo sin validar rango · ⬜ H5 🟡 busyRef race (setConfig/delete/edit/replace) · ⬜ H6 🟡 exportHtml fuera de CSP
- ⬜ H7 🟡 nonce con Math.random · ⬜ H8 🟡 modelsPanel msg.path traversal · ⬜ H9 ⚪ CSP unsafe-inline · ⬜ H10 ⚪ IDs débiles colisionables

**Motores locales**
- ✅ L1 zombies tree-kill · ✅ L2 🟠 .onnx.json validado · ✅ L3 🟠 voz parcial revalidada · ⬜ L4 🟡 colisión nombres importDir
- ⬜ L5 🟡 piper startServer sin on('error') · ⬜ L6 🟡 abort listener + .part huérfano · ⬜ L7 ⚪ python del PATH untrusted · ⬜ L8 ⚪ synthViaServer sin timeout

**i18n / CSS / transversal**
- ⬜ I1 🟡 21 claves sin traducir · ⬜ I2 ⚪ inglés británico/americano · ⬜ I3 ⚪ 2 claves sin uso
- ⬜ S1 ⚪ verde/ámbar hardcodeados · ⬜ S2 ⚪ badges duplicados · ⬜ S3 ⚪ outline:none foco débil · ⬜ S4 ⚪ overrides que deshacen
- ⬜ X1 🟡 ~185 `any` internos · ⬜ X2 🟡 6 archivos 400–500 · ⬜ X3 ⚪ catch vacíos sin comentar · ⬜ X4 ⚪ higiene (.webview-backup, plan-*.md)

---

## ⚠️ Correcciones a lo que afirmé antes (honestidad)

Tres cosas que dije en auditorías previas de esta sesión estaban **mal**. Las corrijo de frente:

1. **Dije que la ruta XSS de markdown era "segura". Es FALSO — hay un hueco real.**
   `media/render/markdown.js:41-45`: el allowlist de esquema de links se bypassa con un **carácter
   de control inicial**. Verificado ejecutando el código: `[x](javascript:alert(1))` →
   `<a href="javascript:alert(1)">`. Los navegadores **eliminan los control-chars iniciales**
   del `href` antes de resolver el esquema → al hacer clic se ejecuta `javascript:`. El modelo
   controla el markdown, así que un mensaje del asistente puede inyectar un link ejecutable. Las
   comillas SÍ están escapadas (eso lo dije bien), pero el prefijo de control-char no. **Es el
   hallazgo más importante de toda la auditoría y yo lo había dado por bueno.**

2. **El "drift de 71 claves nls" estaba mal medido y mal interpretado.** La realidad (medida por el
   auditor leyendo `i18n.ts`): la estrategia es **"el inglés es la clave"**. `tr(s) = bundle[s] ?? s`
   y `t(s) = BUNDLE[s] || s`. Un usuario en inglés **ve el texto correcto siempre** (no hay `%key%`
   literal, no hay bug). El problema real es otro y menor: **21 claves de UI usadas en código no
   están traducidas** → un usuario en español/etc. ve esos tooltips en inglés (ver M-i18n).

3. **Exageré el CSS.** Los 25 `!important` de `composer.css` **no pelean especificidad**: casi todos
   están en `@media print` (overrides legítimos de impresión) → uso **proactivo**, que la propia
   regla P8 permite. No es deuda. Igual, los IDs y `px` son norma legítima del webview. El CSS está
   bastante sano; mis "125 IDs / 625 px" eran conteo sin contexto.

---

## 🔴 Críticos — seguridad y pérdida de datos

> **Progreso de correcciones: 10 / 10 del Top 10 ✅ COMPLETO.** Marcados con ✅ los corregidos.
> (Quedan hallazgos fuera del Top 10 en las secciones por subsistema + el bug reportado por el usuario.)

| Id | archivo:línea | Problema |
|----|---------------|----------|
| ✅ C1 | `media/render/markdown.js:41` | **CORREGIDO** — **XSS**: control-char inicial bypassa el allowlist de esquema → `javascript:` ejecutable desde un link del modelo. (verificado y testeado) |
| ✅ C2 | `src/tools.ts:206-221` | **CORREGIDO** — `fs_search`/`fs_glob` ahora filtran con `withinAnyFolder` (realpath dentro de algún folder); un symlink que escapa el workspace se omite. (verificado con symlink real) |
| ✅ C3 | `src/tools.ts:60-74` | **CORREGIDO** — `assertWritable` ahora bloquea `.mcp.json` y `.mcp/` (además de `.git`/`.vscode`), contra cada folder en multi-root → cierra el RCE diferido vía `loadServerConfigs`. |
| ✅ C4 | `src/webviewHtml.ts:214-217` | **CORREGIDO** — nuevo helper `jsonForScript()` escapa `<`/`>`/U+2028/U+2029 antes de interpolar en el `<script>` inline; un voice id con `</script>` ya no rompe el script. (verificado) |
| ✅ C5 | `src/messageRouter.ts:134` | **CORREGIDO** — regex de `voice` anclado y con charset restringido (`^[a-z]{2}_[A-Z]{2}-[a-zA-Z0-9_-]+$`): sin `.`/`/`/`\` → `en_US-../../../etc` rechazado antes de `removePiperVoice`/`ensureVoice`. (verificado) |
| ✅ C6 | `src/download.ts:20-64` | **CORREGIDO** — `downloadFile` valida IP en cada petición y redirect: chequeo explícito de IP literal privada + `lookup` custom (`safeLookup`) que rechaza IPs privadas en connect-time. (5/5 verificado: metadata 169.254, localhost, LAN, IPv6 `::1`/`fc00::1`) |
| ✅ C7 | `src/inference.ts:163-166` | **CORREGIDO** — `answer`/`thinking` solo se actualizan desde un `chat()` que completó (`!failed && !aborted`); un fallo/abort ya no pisa la respuesta acumulada con el `res` vacío por defecto. |
| ✅ C8 | `src/chatDocument.ts:147-176` | **CORREGIDO** — guard `!raw || typeof!=='object' || isArray` → un `.chat` `null`/primitivo/array devuelve doc vacío sin crash; y campos top-level desconocidos se preservan en `doc._extra` y se re-emiten en `serializeDoc` (no para params sueltos de v1). (verificado) |
| ✅ C9 | `src/attachmentStore.ts:43-92` | **CORREGIDO** — temp file con nombre único por proceso (`.<pid>.<seq>.tmp`) → sin colisión entre ventanas; y cache invalidado por `mtime` (relee si el sidecar cambió en disco, adopta su propio mtime tras escribir). |

---

## 🟠 Providers (`src/providers/**`)

- **✅ [Alta] BUG `stream.ts:32-44` — CORREGIDO** — `readLines` ahora hace flush del buffer final tras `done` (emite la última línea sin `\n`); el chunk `{"done":true}` de Ollama con el `usage` ya no se pierde. Test #41 (que asertaba el bug) reescrito + test guard de no-emisión-vacía. (49/49)
- **✅ [Alta] BUG `stream.ts:26-44` — CORREGIDO** — `readLines` envuelto en `try/finally` que llama `reader.cancel()` siempre (cierre normal, throw de `onLine`, abort) → libera la conexión y señala cancelación. 2 tests nuevos verifican que `cancel()` se llama en ambas rutas. (51/51)
- **✅ [Alta] BUG `stream.ts` (P3) — CORREGIDO** — `readLines` acepta `signal`: un listener `abort` cancela el reader (desbloquea un `read()` pendiente) y se chequea `signal.aborted` antes/después de cada `read()`, lanzando para que el provider lo trate como abort. Los 4 providers pasan `cb.signal`. (verificado: aborta y libera incluso con reader que nunca termina)
- **✅ [Media] BUG `request.ts:15` + `listModels` (P4) — CORREGIDO** — `postStream` usa `fetchWithHeadersTimeout` (60s para headers; el body streamed sigue ilimitado y respeta Stop). Los 4 `listModels` usan `AbortSignal.timeout(15s)`. Un backend que acepta y se queda mudo ya no cuelga la UI.
- **✅ [Media] BUG `openai.ts:229` (P5) — CORREGIDO** — el id sintético incluye la clave del acumulador (`call_<name>_<key>`): dos tools homónimas sin id ya no colisionan.
- **✅ [Media] BUG `multimodal.ts:23` (P6) — CORREGIDO** — regex ajustado a patrones de generación (`nano-banana`, `flash-image`, `image-generation/preview`, `-image$`); ya no captura `image-input`/visión.
- **✅ [Media] BUG `anthropic.ts:110-119` (P7) — CORREGIDO** — `body.temperature = 1` se fija explícitamente con thinking (antes solo estaba en el comentario).
- **✅ [Media] BUG `stream.ts:36` (P8) — CORREGIDO** — cap subido de 4MiB a 64MiB: una imagen base64 inline ya no se trunca; solo se recorta un stream realmente desbocado.
- **[Media] BUG `gemini.ts:69`** — `functionResponse` sin validar `toolName` ausente → Gemini 400. Sin validación de frontera (L4).
- **✅ [Baja] BUG `openai.ts:217` (P10) — CORREGIDO** — la clave del acumulador es `index` o, en su defecto, `id`: múltiples tool_calls completas en un delta ya no colapsan en slot 0.
- **[Baja] BUG (4 providers)** — `baseUrl` de settings se concatena sin validar esquema/host y la API key viaja en headers → un `.chat` compartido con baseUrl malicioso podría exfiltrar la key.
- **[Media] CONVENCIÓN (todos)** — `body: any`, `usage: any`, `parts: any[]` en cuerpos de request que el propio código construye (tipables). Viola C2/C3: `any` solo para JSON de entrada, no para lo que tú rellenas.

## 🟠 Loop agéntico y tools (`src/inference.ts`, `tools.ts`, `mcp.ts`)

- **✅ [Alta] BUG `inference.ts:174-194` (A1) — CORREGIDO** — al abortar a media ejecución del tool-loop, `repairTrailingToolChain(fresh.messages)` se llama antes del `writeDoc` intermedio → ya no se persiste un assistant con toolCalls sin sus respuestas.
- **✅ [Alta] BUG `inference.ts` tool-loop (A2) — CORREGIDO** — las tool calls de un turno se ejecutan con `Promise.all` (independientes: el modelo las pidió sin ver resultados intermedios). Resultados recogidos en orden de petición (pairing tool_result↔tool_call intacto); el abort cancela las in-flight vía `ac.signal`. (verificado: orden a,b,c, latencia ~máx no suma)
- **[Media] BUG `tools.ts:218-221`** — `fs_search` hace `readFileSync` **síncrono** sobre hasta 3000 archivos × 2MB → **bloquea el event loop / congela VS Code** en repos grandes (S1/S5).
- **✅ [Media] BUG `mcp.ts` dispose (A4) — CORREGIDO** — `dispose()` usa `killProcessTree` (tree-kill en Windows + SIGKILL en POSIX).
- **✅ [Media] BUG `mcp.ts:113` (A5) — CORREGIDO** — `callTool` respeta `isError`: prefija `Error:` para que el modelo distinga fallo de salida normal.
- **✅ [Media] BUG `mcp.ts:60` (A6) — CORREGIDO** — buffer stdio acotado a 8MiB (evita OOM por línea sin newline).
- **✅ [Media] BUG `mcp.ts` (A7) — CORREGIDO** — flag `alive` (false en exit/error): una request a un servidor muerto falla al instante en vez de esperar 30s.
- **[Media] BUG `inference.ts:181`** — Args JSON malformados → **se traga el error y ejecuta con `args={}`** en vez de devolver un error al modelo para que se autocorrija.
- **[Baja] BUG `inference.ts:147`** — `MAX_ITERS===0` (ilimitado) **sin tope de seguridad**: modelo en bucle de tools solo se corta por Stop manual → coste descontrolado.
- **✅ [Baja] BUG `mcp.ts:40` (A10) — CORREGIDO** — se conserva la cola (2KB) de stderr y se incluye en el error de exit.

## 🟠 Webview / render (`media/**`)

- **✅ [Media] BUG `media/chat/conversation.js:329` (W1, reportado) — CORREGIDO** — `canRegenFromPrompt` ya no exige adyacencia (`i+1===lastDisplayable`); se calcula `lastPromptIdx` (el último prompt de usuario cuya respuesta es `lastDisplayable`) y se compara `i===lastPromptIdx`. Así el botón regenerar aparece aunque entre el prompt y la respuesta haya mensajes intermedios de tools. (verificado: con tools, sin tools y multi-turno)

- **✅ [Alta] BUG `markdown.js:39,52` — CORREGIDO** — placeholder de code-spans pasa de ` dígito ` a ` dígito ` (NUL, jamás en prosa) → "entre 0 y 1 hay `x`" ya no corrompe los números ni emite `<code>undefined</code>`. (verificado)
- **[Media] BUG `markdown.js:130-141`** — **Listas anidadas se aplanan** (se descarta la indentación) → toda jerarquía se pierde en el render.
- **[Media] BUG `conversation.js:448,458` + `message.js`** — `processMermaid` es promesa flotante (K2) y hay **race**: `renderConversation` hace `innerHTML=''`; si `mermaid.render` resuelve tras el re-render, opera sobre un nodo desconectado → diagramas que "desaparecen".
- **[Media] CONVENCIÓN `conversation.js` (477 líneas)** — **God-view**: render + estado de streaming + `stableSplit` + panels + editor de summary (≈30 líneas duplicadas de `message.js`) + export con **CSS embebido en JS** (M9). Debe partirse (N1/N2). Hay además **dependencia circular** `conversation.js ↔ message.js` (M7).
- **[Baja] BUG `core/dom.js:5`** — `escapeHtml(x)` **revienta si `x` no es string** (no coacciona). Un `.attach` con `name`/`mime` no-string rompe el render.
- **[Baja] BUG `mermaid.js:179`** — `btoa(unescape(...))` usa `unescape` deprecado; falla con SVG fuera de Latin-1.

## 🟠 Host / orquestación (`src/extension.ts`, `messageRouter.ts`, …)

- **✅ [Alta] BUG `extension.ts:74` — CORREGIDO** — `context.secrets.onDidChange(...)` ahora se registra en `context.subscriptions` → se limpia en deactivate (T8).
- **✅ [Alta] BUG `extension.ts:313` — CORREGIDO** — el callback ahora hace `void routeMessage(...).catch(...)`: loguea el error (`console.error`) y postea un `error` al webview, en vez de dejar un unhandled rejection sin feedback (la UI ya no queda colgada). `no-floating-promises` satisfecho.
- **🔎 [reclasificado] `extension.ts:135,361` (H3) — NO es bug** — revisado en detalle: `applyConfig` está acotado a su editor por closure (`getDoc`/`writeDoc`/`document` capturados), y `doc` se captura antes del `await`, así que NO escribe sobre el doc equivocado. El `static activeApply` solo enruta el "usar en chat" del sidebar al último chat activo (comportamiento deseado, documentado en el código). Es un olor de estado global (F4) pero funcionalmente correcto; no amerita cambio. Mi auditoría inicial lo sobrevaloró como "Alta BUG".
- **✅ [Alta] BUG `chatDocument.ts:174` — CORREGIDO** — `summary.upTo` se clampa a `[0, messages.length]` con `Math.floor`; valores corruptos (`-5`→drop, `99999`→len, `2.7`→2, `NaN`→drop) ya no se propagan al conteo de contexto. (verificado)
- **[Media] BUG `messageRouter.ts:142-250`** — `setConfig`/`deleteMessage`/`editMessage`/`replaceAll` **chequean `busyRef` pero no lo adquieren** → entre su `getDoc` y `writeDoc` async puede colarse un `send` → escritura concurrente del doc (race).
- **[Media] BUG `messageRouter.ts:364`** — `exportHtml` escribe HTML del modelo a tmp y lo abre en el navegador **fuera de CSP** → `<img src=attacker>`/scripts se ejecutan (exfiltración, U5).
- **[Media] BUG `modelsPanel.ts:18` / `compareView.ts:96`** — **Nonce CSP con `Math.random()`** (predecible) y `randomBytes(...).replace(/[^A-Za-z0-9]/,'')` que **recorta entropía a longitud variable**. Debe ser `crypto.randomBytes` de longitud fija (U3).
- **[Media] BUG `modelsPanel.ts:107-144`** — `msg.path`/`msg.id` del webview → nombres y rutas de import sin validar (path traversal hacia `ollama.create`, L4/U5).
- **[Media] CONVENCIÓN `webviewHtml.ts:33`** — CSP con `style-src 'unsafe-inline'` (justificado por Mermaid) → cualquier `style=` inyectado pasa; depende del sanitizador.
- **[Baja] BUG `extension.ts:194` / `attachmentStore.ts:66`** — IDs con `Date.now()+Math.random()*1e6` en bucle síncrono (`Date.now()` constante) → **colisión plausible** → un mensaje/attachment pierde su blob.

## 🟠 Motores locales (Ollama / Piper / descargas)

- **✅ [Alta] BUG `ollama/manager.ts:142,194` + `piper/manager.ts` — CORREGIDO** — nuevo helper `killProcessTree` (`src/procKill.ts`): en Windows `taskkill /pid /T /F` mata el árbol (el `shell:true` envuelve `cmd.exe`); en POSIX SIGTERM y escalada a SIGKILL tras 3s. Aplicado en `stop()` de Ollama y `stopServer()`/startup-fail de Piper. (escalada SIGKILL verificada en POSIX)
- **✅ [Alta] BUG `piper/manager.ts:130` (L2) — CORREGIDO** — el `.onnx.json` se valida estructuralmente (`JSON.parse` + `phoneme_id_map` objeto); un HTML de error de HF o un json truncado se rechaza. (verificado)
- **✅ [Alta] BUG `piper/manager.ts:122-141` (L3) — CORREGIDO** — `ensureVoice` revalida el json existente y lo **re-descarga** si es inválido (en vez de `if (!existsSync)` que saltaba un json corrupto previo); si tras re-descargar sigue inválido, falla.
- **[Media] BUG `ollama/downloads.ts:204`** — **Colisión de nombres en `importDir`** entre descargas concurrentes (mismo basename de shard) → se corrompen mutuamente. Falta subcarpeta por id.
- **[Media] BUG `piper/manager.ts:328`** — `startServer` **no captura `proc.on('error')`** → spawn fallido (ENOENT) cuelga 20s hasta timeout.
- **[Media] BUG `download.ts:62`** — Listener `abort` **nunca se remueve**; `.part` huérfano de un crash (kill del editor) **nunca se barre** al arrancar.
- **[Baja] BUG `piper/manager.ts:154`** — `findCompatiblePython` ejecuta `python`/`py` del PATH sin respetar `untrustedWorkspaces` (U2).
- **[Baja] BUG `piper/manager.ts:407`** — `synthViaServer` sin `AbortSignal` ni timeout (K6) → daemon colgado cuelga la UI de TTS.

**Verificado OK (motores):** los binarios de Ollama/Piper/Python **sí** se verifican por SHA256 pin con fail-closed; `downloadFile` usa `.part`+rename atómico y limpia en error/abort. El gap es la robustez del kill y las voces json sin hash, no la ausencia de verificación.

## 🟡 i18n (`src/i18n.ts`, `media/i18n.js`)

- **[Media] BUG (21 claves)** — Claves de UI usadas en código **sin traducir** → en es/pt/fr/de/it se ven en inglés: toda la barra de búsqueda (`Find`, `Replace`, `Match Case`, `Use Regular Expression`…), controles de Mermaid (`Zoom in/out`, `Pan…`, `Fullscreen`, `Could not render this Mermaid diagram`) y `of`.
- **[Baja] CONVENCIÓN** — `Reset / centre` y `centre` usan inglés británico; el resto americano. Inconsistencia.
- **[Baja]** — 2 claves definidas sin uso aparente (`Reprocess (regenerate as a new variant)`, `Search in chat…`).

## 🟡 CSS — deuda menor (no lo que dije antes)

- **[Baja] composer.css:181 / style.css:65** — Verde/ámbar de estado hardcodeados (`#3fb950`, `#d29922`) sin `var(--vscode-charts-*)` → bajo contraste en temas claros. Los hermanos `.high`/`.error` sí usan tokens (inconsistencia).
- **[Baja] messages.css:154-182** — `.think-badge` y `.tool-badge` **casi idénticas duplicadas** → mantener dos veces (P6).
- **[Baja] find.css:48 / dictionary.css:22** — `outline:none` con reemplazo solo de `border-color` → indicador de foco débil (accesibilidad por teclado).
- **[Baja] messages.css:223 / messages.css:30** — Overrides que **deshacen estilos** (un `max-height:none` sobre algo que ya no existe; full-width que anula el per-role recién definido) → residuo de refactor (Q10).

---

## Transversales

- **`any` en lógica interna** (no en la capa de JSON externo): ~185 ocurrencias, con focos en `localModels.ts`, `mcp.ts`, `chatDocument.ts`, `inference.ts`, `attachmentStore.ts`, `ttsBackend.ts`. Viola C2/C3. ESLint lo permite a propósito, pero el estándar pide `unknown`+narrowing fuera de la frontera.
- **6 archivos en 400–500 líneas** (M2): `conversation.js` (god-view), `piper/manager.ts`, `extension.ts`, `messageRouter.ts`, `models.js`, `panels/config.js`.
- **`catch` vacíos sin comentar** (L2): `tts.js:12,13,102,180`, `mermaid.js:230,240`.
- **Higiene** (W3/W4): `.webview-backup/` (gitignored, borrar) y `plan-*.md` (no trackeados, a issues o borrar).

---

## Top 10 a arreglar primero

1. ✅ **C1** XSS de control-char en links (markdown.js:41) — **HECHO**.
2. ✅ **C3** `fs_write` puede sobrescribir `.mcp.json` → RCE diferido — **HECHO**.
3. ✅ **C2** `fs_search`/`fs_glob` sin `assertRealWithin` (symlink traversal) — **HECHO**.
4. ✅ **C7** `inference.ts:165` descarta la respuesta parcial en error — **HECHO**.
5. ✅ **C4** `</script>` sin escapar en script inline (webviewHtml.ts) — **HECHO**.
6. ✅ **stream.ts:32** sin flush final → se pierde el chunk de usage/done — **HECHO**.
7. ✅ **stream.ts:26** reader nunca liberado + abort no corta el stream — **HECHO**.
8. ✅ **extension.ts:313** floating promise del router sin try/catch — **HECHO**.
9. ✅ **Zombies** Ollama/Piper en Windows (`shell:true` + sin SIGKILL) — **HECHO**.
10. ✅ **C6** redirects de `downloadFile` sin validación SSRF — **HECHO**.

> Esto es una lista de trabajo, no un boletín. ~80 hallazgos; los marcados [verificado] se
> confirmaron ejecutando el código. Si quieres, ataco cualquiera en orden de severidad.
