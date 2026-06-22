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

> **Progreso de correcciones: 7 / 10 del Top 10 (faltan 3).** Marcados con ✅ los corregidos.

| Id | archivo:línea | Problema |
|----|---------------|----------|
| ✅ C1 | `media/render/markdown.js:41` | **CORREGIDO** — **XSS**: control-char inicial bypassa el allowlist de esquema → `javascript:` ejecutable desde un link del modelo. (verificado y testeado) |
| ✅ C2 | `src/tools.ts:206-221` | **CORREGIDO** — `fs_search`/`fs_glob` ahora filtran con `withinAnyFolder` (realpath dentro de algún folder); un symlink que escapa el workspace se omite. (verificado con symlink real) |
| ✅ C3 | `src/tools.ts:60-74` | **CORREGIDO** — `assertWritable` ahora bloquea `.mcp.json` y `.mcp/` (además de `.git`/`.vscode`), contra cada folder en multi-root → cierra el RCE diferido vía `loadServerConfigs`. |
| ✅ C4 | `src/webviewHtml.ts:214-217` | **CORREGIDO** — nuevo helper `jsonForScript()` escapa `<`/`>`/U+2028/U+2029 antes de interpolar en el `<script>` inline; un voice id con `</script>` ya no rompe el script. (verificado) |
| C5 | `src/messageRouter.ts:133` | **Path traversal**: el regex de validación de `voice` no está anclado al final → `en_US-../../../etc` pasa el `test` y llega a `removePiperVoice`. |
| C6 | `src/download.ts:41` | **Redirects sin validación SSRF**: `downloadFile` sigue 6 redirects sin comprobar host/IP (a diferencia de `safeWebFetch`). Un `Location:` a `169.254.169.254` o red interna se sigue. |
| ✅ C7 | `src/inference.ts:163-166` | **CORREGIDO** — `answer`/`thinking` solo se actualizan desde un `chat()` que completó (`!failed && !aborted`); un fallo/abort ya no pisa la respuesta acumulada con el `res` vacío por defecto. |
| C8 | `src/chatDocument.ts:147-176` | `parseDoc` **revienta con un `.chat` que sea JSON `null`** (`raw.summary` → TypeError) y **descarta campos desconocidos en el round-trip** → edición manual o versión futura pierde datos silenciosamente. |
| C9 | `src/attachmentStore.ts:43-92` | Escritura "atómica" usa **`.tmp` de nombre fijo** → dos ventanas con el mismo `.chat` se corrompen; y el **cache nunca se invalida** → sirve blobs obsoletos. |

---

## 🟠 Providers (`src/providers/**`)

- **✅ [Alta] BUG `stream.ts:32-44` — CORREGIDO** — `readLines` ahora hace flush del buffer final tras `done` (emite la última línea sin `\n`); el chunk `{"done":true}` de Ollama con el `usage` ya no se pierde. Test #41 (que asertaba el bug) reescrito + test guard de no-emisión-vacía. (49/49)
- **✅ [Alta] BUG `stream.ts:26-44` — CORREGIDO** — `readLines` envuelto en `try/finally` que llama `reader.cancel()` siempre (cierre normal, throw de `onLine`, abort) → libera la conexión y señala cancelación. 2 tests nuevos verifican que `cancel()` se llama en ambas rutas. (51/51)
- **[Alta] BUG `stream.ts` + `request.ts:15`** — El `AbortSignal` **no se comprueba dentro del bucle de lectura**; con el wrapper de proxy undici el abort puede no cortar el stream → sigue llamando `cb.onDelta` tras Stop.
- **[Media] BUG `request.ts:15` + `listModels` (todos)** — **Sin timeout en I/O de red** (K6): un backend que acepta conexión y no responde headers cuelga la UI indefinidamente.
- **[Media] BUG `openai.ts:229`** — IDs de tool-call sintéticos **sin índice** (`call_${name}`): dos llamadas a la misma tool sin `id` colisionan → tool results mal enrutados. Ollama/Gemini sí añaden índice; OpenAI no (inconsistencia).
- **[Media] BUG `multimodal.ts:23`** — `isImageOutputModel` con regex `/…|image/i` es demasiado amplio: cualquier modelo con "image" en el id (visión, embeddings) se trata como image-output → se le quitan tools silenciosamente.
- **[Media] BUG `anthropic.ts:110-119`** — Con thinking, la API exige `temperature:1` y el código **no lo fija** (el comentario dice que sí). El comentario miente respecto al código.
- **[Media] BUG `stream.ts:36`** — El "defensive cap" `slice(-MAX)` **trunca por el medio** una línea legítima >4MiB (imagen base64 inline) → `JSON.parse` falla → se descarta.
- **[Media] BUG `gemini.ts:69`** — `functionResponse` sin validar `toolName` ausente → Gemini 400. Sin validación de frontera (L4).
- **[Baja] BUG `openai.ts:217`** — Múltiples tool_calls sin `index` caen todas en `0` → name/arguments concatenados de tools distintas.
- **[Baja] BUG (4 providers)** — `baseUrl` de settings se concatena sin validar esquema/host y la API key viaja en headers → un `.chat` compartido con baseUrl malicioso podría exfiltrar la key.
- **[Media] CONVENCIÓN (todos)** — `body: any`, `usage: any`, `parts: any[]` en cuerpos de request que el propio código construye (tipables). Viola C2/C3: `any` solo para JSON de entrada, no para lo que tú rellenas.

## 🟠 Loop agéntico y tools (`src/inference.ts`, `tools.ts`, `mcp.ts`)

- **[Alta] BUG `inference.ts:174-194`** — Abort entre el push del `assistant`+toolCalls y los `tool` results **persiste a disco un assistant con toolCalls sin respuesta** (estado roto escrito por `writeDoc`).
- **[Alta] BUG `tools.ts` loop** — Las tool calls se ejecutan **en secuencia** (`for…await`), no en paralelo (K3). 5 tools lentas = latencia sumada; Stop no cancela lo ya lanzado.
- **[Media] BUG `tools.ts:218-221`** — `fs_search` hace `readFileSync` **síncrono** sobre hasta 3000 archivos × 2MB → **bloquea el event loop / congela VS Code** en repos grandes (S1/S5).
- **[Media] BUG `mcp.ts:122-129`** — `dispose()` hace `kill()` (SIGTERM); con `shell:true` mata el shell, **no el hijo MCP** → zombie. Sin SIGKILL de respaldo (T9).
- **[Media] BUG `mcp.ts:113`** — `callTool` **ignora `isError`** del resultado MCP → el modelo no distingue éxito de fallo de la herramienta.
- **[Media] BUG `mcp.ts:60`** — Buffer de stdio **crece sin límite** → un servidor que emite una línea enorme = OOM (K5).
- **[Media] BUG `mcp.ts:194-215`** — Servidor MCP caído tras arrancar no se detecta → cada tool call cuelga **30s hasta timeout**.
- **[Media] BUG `inference.ts:181`** — Args JSON malformados → **se traga el error y ejecuta con `args={}`** en vez de devolver un error al modelo para que se autocorrija.
- **[Baja] BUG `inference.ts:147`** — `MAX_ITERS===0` (ilimitado) **sin tope de seguridad**: modelo en bucle de tools solo se corta por Stop manual → coste descontrolado.
- **[Baja] BUG `mcp.ts:40`** — `stderr.on('data', () => {})` **descarta todo el stderr** → diagnóstico de servidores caídos perdido (L2).

## 🟠 Webview / render (`media/**`)

- **[Media] BUG `media/chat/conversation.js:329` (reportado por el usuario, 2026-06-22)** — Al abrir un `.chat` cuyo último intercambio **usó tools**, el botón de **regenerar la respuesta** no aparece en el bubble del usuario. `canRegenFromPrompt` asume que la respuesta está en `i+1` y es `lastDisplayable`: `m.role==='user' && visible[i+1].role==='assistant' && (i+1)===lastDisplayable`. Con tools, el doc es `[user, assistant(toolCalls), tool, assistant(final)]`, así que `visible[i+1]` es el assistant intermedio con `toolCalls` (no displayable) y `(i+1)!==lastDisplayable` → la condición falla. Debe comprobar que **no hay un user posterior** y que `lastDisplayable` es un assistant tras `i`, en vez de exigir adyacencia. (Verificado contra la foto: solo aparece ⏩ "Continue" en el assistant final.)

- **[Alta] BUG `markdown.js:39,52`** — **Corrupción de datos**: el placeholder de code-spans usa ` dígito ` y colisiona con números del texto. Verificado: `"entre 0 y 1 … \`x\`"` → emite `<code>undefined</code>`. Frases cotidianas se rompen.
- **[Media] BUG `markdown.js:130-141`** — **Listas anidadas se aplanan** (se descarta la indentación) → toda jerarquía se pierde en el render.
- **[Media] BUG `conversation.js:448,458` + `message.js`** — `processMermaid` es promesa flotante (K2) y hay **race**: `renderConversation` hace `innerHTML=''`; si `mermaid.render` resuelve tras el re-render, opera sobre un nodo desconectado → diagramas que "desaparecen".
- **[Media] CONVENCIÓN `conversation.js` (477 líneas)** — **God-view**: render + estado de streaming + `stableSplit` + panels + editor de summary (≈30 líneas duplicadas de `message.js`) + export con **CSS embebido en JS** (M9). Debe partirse (N1/N2). Hay además **dependencia circular** `conversation.js ↔ message.js` (M7).
- **[Baja] BUG `core/dom.js:5`** — `escapeHtml(x)` **revienta si `x` no es string** (no coacciona). Un `.attach` con `name`/`mime` no-string rompe el render.
- **[Baja] BUG `mermaid.js:179`** — `btoa(unescape(...))` usa `unescape` deprecado; falla con SVG fuera de Latin-1.

## 🟠 Host / orquestación (`src/extension.ts`, `messageRouter.ts`, …)

- **[Alta] BUG `extension.ts:74`** — `context.secrets.onDidChange(...)` **no se registra en `context.subscriptions`** → listener colgado en reload (T8). El de configuración sí está; delata el olvido.
- **[Alta] BUG `extension.ts:313` + `messageRouter.ts:51`** — `onDidReceiveMessage(msg => routeMessage(...))` **descarta la promesa** (`routeMessage` es async) y **no hay try/catch** en el router → cualquier handler que lance = unhandled rejection sin feedback (K2/L2).
- **[Alta] BUG `extension.ts:135,361`** — `static activeApply` es **estado global compartido entre todos los chats abiertos** → con varios editores, `applyConfig` puede escribir sobre el doc equivocado tras un `await` (N3/F4).
- **[Alta] BUG `chatDocument.ts:174`** — `summary.upTo` se acepta sin validar rango (`-5`, `99999`, `2.7`) → se propaga al conteo de contexto (L4).
- **[Media] BUG `messageRouter.ts:142-250`** — `setConfig`/`deleteMessage`/`editMessage`/`replaceAll` **chequean `busyRef` pero no lo adquieren** → entre su `getDoc` y `writeDoc` async puede colarse un `send` → escritura concurrente del doc (race).
- **[Media] BUG `messageRouter.ts:364`** — `exportHtml` escribe HTML del modelo a tmp y lo abre en el navegador **fuera de CSP** → `<img src=attacker>`/scripts se ejecutan (exfiltración, U5).
- **[Media] BUG `modelsPanel.ts:18` / `compareView.ts:96`** — **Nonce CSP con `Math.random()`** (predecible) y `randomBytes(...).replace(/[^A-Za-z0-9]/,'')` que **recorta entropía a longitud variable**. Debe ser `crypto.randomBytes` de longitud fija (U3).
- **[Media] BUG `modelsPanel.ts:107-144`** — `msg.path`/`msg.id` del webview → nombres y rutas de import sin validar (path traversal hacia `ollama.create`, L4/U5).
- **[Media] CONVENCIÓN `webviewHtml.ts:33`** — CSP con `style-src 'unsafe-inline'` (justificado por Mermaid) → cualquier `style=` inyectado pasa; depende del sanitizador.
- **[Baja] BUG `extension.ts:194` / `attachmentStore.ts:66`** — IDs con `Date.now()+Math.random()*1e6` en bucle síncrono (`Date.now()` constante) → **colisión plausible** → un mensaje/attachment pierde su blob.

## 🟠 Motores locales (Ollama / Piper / descargas)

- **[Alta] BUG `ollama/manager.ts:142,194`** — **Zombies**: con `shell:true` en Windows, `kill()` mata `cmd.exe`, no `ollama serve`. Sin SIGKILL escalado ni `taskkill /T` (T9).
- **[Alta] BUG `piper/manager.ts:130`** — El **`.onnx.json` de las voces se descarga sin verificar hash** (solo el `.onnx` se compara contra SHA pin). Config de fonemas sin pin (U6).
- **[Alta] BUG `piper/manager.ts:122-141`** — Descarga de voz parcial: un `.onnx.json` corrupto previo (p. ej. HTML de error de HF) **nunca se revalida** en el reintento (`if (!existsSync(json))` lo salta).
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
8. **extension.ts:313** floating promise del router sin try/catch.
9. **Zombies** Ollama/Piper en Windows (`shell:true` + sin SIGKILL).
10. **C6** redirects de `downloadFile` sin validación SSRF.

> Esto es una lista de trabajo, no un boletín. ~80 hallazgos; los marcados [verificado] se
> confirmaron ejecutando el código. Si quieres, ataco cualquiera en orden de severidad.
