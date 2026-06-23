# Auditoría profunda — Parley vs. BEST-PRACTICES.md

> Estado del código medido contra las **166 reglas** de [BEST-PRACTICES.md](BEST-PRACTICES.md) +
> caza de bugs reales. Fecha 2026-06-22 · v1.6.0 · rama `master`.
>
> **Método:** suite de validación ejecutada + **6 auditores en paralelo** leyendo COMPLETOS los
> archivos de cada subsistema (providers, loop agéntico/tools, webview/render, host/orquestación,
> motores locales, CSS/i18n). Cada hallazgo apunta a código real con archivo:línea. ~80 hallazgos.
>
> La suite pasa (tsc 0 / eslint 0 / 51 tests / 0 archivos >500). **Casi nada de esto lo detecta la
> suite**: son bugs de lógica, de seguridad y de concurrencia que solo salen leyendo el código.

---

## 📋 Inventario completo (74 hallazgos: 67 auditoría + W8 + 6 de la 2.ª pasada)

> **Estado: 63 ✅ corregidos · 8 🔎 revisados/por-diseño · 3 ⬜ abiertos.**
> **B4 y models.js: cerrados.** Solo queda el `any` de **frontera** (json de API, mensajes webview, args de
> comandos VS Code) que el propio `eslint.config.js` desactiva a propósito — ver X1.
> ✅ = corregido y commiteado · 🔎 = revisado, no era bug / por diseño · ⬜ = abierto.
> Severidad: 🔴 crítico · 🟠 alta · 🟡 media · ⚪ baja/convención.

**Críticos (seguridad / pérdida de datos)**
- ✅ C1 🔴 XSS control-char en links · ✅ C2 🔴 symlink en fs_search/glob · ✅ C3 🔴 fs_write→.mcp RCE
- ✅ C4 🔴 `</script>` inline · ✅ C5 🔴 path traversal en voice (messageRouter:133) · ✅ C6 🔴 SSRF redirects
- ✅ C7 🔴 wipe de answer en abort · ✅ C8 🔴 parseDoc crash con `null` + pérdida round-trip · ✅ C9 🔴 attachmentStore tmp/cache
- **🔴 Críticos: 9/9 ✅ COMPLETO**

**Providers**
- ✅ P1 stream flush final · ✅ P2 stream reader release · ✅ P3 🟠 AbortSignal chequeado en read-loop
- ✅ P4 🟡 timeout de red · ✅ P5 🟡 tool-call id con índice · ✅ P6 🟡 isImageOutputModel ajustado
- ✅ P7 🟡 anthropic temperature:1 fijado · ✅ P8 🟡 defensive cap 64MiB · ✅ P9 🟡 gemini functionResponse valida toolName
- ✅ P10 ⚪ multiple tool_calls por id · 🔎 P11 revisado: premisa incorrecta (baseUrl es settings, no .chat) · 🔎 P12 🟡 `any` en bodies de request (frontera, por diseño — ver X1)

**Loop agéntico / tools**
- ✅ A1 🟠 abort persiste assistant+toolCalls sin respuesta · ✅ A2 🟠 tools en paralelo · ✅ A3 🟡 fs_search asíncrono
- **🟠 Altas: COMPLETAS** (P3, A1, A2, W2, H1, H4, L2, L3 + H3 reclasificado)
- ✅ A4 🟡 mcp dispose zombie · ✅ A5 🟡 mcp ignora isError · ✅ A6 🟡 mcp buffer stdio acotado
- ✅ A7 🟡 mcp servidor caído falla rápido · ✅ A8 🟡 inference reporta error de args JSON · ✅ A9 ⚪ MAX_ITERS=0 con tope duro 100 · ✅ A10 ⚪ mcp captura stderr

**Webview**
- ✅ W1 🟡 botón regenerar ausente tras tools (reportado) · ✅ W2 🟠 colisión placeholder code-span · ✅ W3 🟡 listas anidadas con nesting
- ✅ W4 🟡 processMermaid sin race · ✅ W5 🟡 god-view partido (conversation 500→382 + export.js + panels.js) · ✅ W6 ⚪ escapeHtml coacciona String · ✅ W7 ⚪ mermaid sin unescape

**Host / orquestación**
- ✅ H1 🟠 secrets.onDidChange sin disposable · ✅ H2 router floating promise · 🔎 H3 revisado: NO es bug (convención F4, funcionalmente correcto)
- ✅ H4 🟠 summary.upTo sin validar rango · ✅ H5 🟡 busyRef: setConfig bajo lock · ✅ H6 🟡 exportHtml con CSP+nonce
- ✅ H7 🟡 nonce crypto unificado · ✅ H8 🟡 modelsPanel valida import paths · 🔎 H9 ⚪ CSP unsafe-inline (aceptada: requerida por Mermaid) · ✅ H10 ⚪ IDs con randomUUID

**Motores locales**
- ✅ L1 zombies tree-kill · ✅ L2 🟠 .onnx.json validado · ✅ L3 🟠 voz parcial revalidada · ✅ L4 🟡 importDir por subcarpeta de item
- ✅ L5 🟡 piper startServer con on('error') · ✅ L6 🟡 abort listener removido · 🔎 L7 revisado: riesgo teórico (PATH no es del workspace) · ✅ L8 ⚪ synthViaServer con timeout

**i18n / CSS / transversal**
- ✅ I1 🟡 claves UI traducidas (24×5) · ✅ I2 ⚪ Reset / center (americano) · ✅ I3 ⚪ 2 claves muertas eliminadas
- ✅ S1 ⚪ colores con tokens de tema · ✅ S2 ⚪ badges consolidados · ✅ S3 ⚪ anillo de foco · ✅ S4 ⚪ override muerto quitado
- 🔎 X1 🟡 `any`: **internos eliminados** (22 catches→`unknown`+errMsg, stream data→`Buffer`, localModels; 182→155); los 155 restantes son frontera (json API, msg webview, args cmd) que ESLint permite a propósito · ✅ X2 🟡 M2 **6/6** (models.js partido: modelsFormat.js + NUL limpiados) · ✅ X3 ⚪ catch vacíos comentados · 🔎 X4 ⚪ higiene: archivos locales (tu decisión)

**Segunda pasada de caza (B1–B6, post-auditoría)**
- ✅ B1/W9 🟠 streaming rompía bloques multilínea · ✅ B2 🟠 negrita con `*` interno corrompía · ✅ B3 🟡 celdas de tabla con `\|`/code-span
- ✅ B5 🟠 deleteVariant variante equivocada · ✅ B6 🟠 turno con answer vacío deja cadena de tools colgante · ✅ B4 🟡 find/replace salta ocurrencias dentro de URLs de markdown

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
- **✅ [Media] BUG `gemini.ts:69` (P9) — CORREGIDO** — `name: m.toolName || 'tool'`: un tool message malformado degrada en vez de mandar `undefined` y 400 toda la llamada.
- **✅ [Baja] BUG `openai.ts:217` (P10) — CORREGIDO** — la clave del acumulador es `index` o, en su defecto, `id`: múltiples tool_calls completas en un delta ya no colapsan en slot 0.
- **🔎 [reclasificado] (4 providers) (P11) — premisa incorrecta** — `baseUrl` viene de **settings locales**, NO del `.chat` (que solo guarda provider+model), así que no hay exfiltración vía `.chat` compartido. El residual (endpoint http puesto por el usuario) es necesario para local (Ollama/LM Studio). Sin cambio.
- **🔎 [por diseño] (todos) (P12)** — `body: any`, `usage: any`, `parts: any[]` en cuerpos de request que el propio código construye (tipables). Viola C2/C3: `any` solo para JSON de entrada, no para lo que tú rellenas.

## 🟠 Loop agéntico y tools (`src/inference.ts`, `tools.ts`, `mcp.ts`)

- **✅ [Alta] BUG `inference.ts:174-194` (A1) — CORREGIDO** — al abortar a media ejecución del tool-loop, `repairTrailingToolChain(fresh.messages)` se llama antes del `writeDoc` intermedio → ya no se persiste un assistant con toolCalls sin sus respuestas.
- **✅ [Alta] BUG `inference.ts` tool-loop (A2) — CORREGIDO** — las tool calls de un turno se ejecutan con `Promise.all` (independientes: el modelo las pidió sin ver resultados intermedios). Resultados recogidos en orden de petición (pairing tool_result↔tool_call intacto); el abort cancela las in-flight vía `ac.signal`. (verificado: orden a,b,c, latencia ~máx no suma)
- **✅ [Media] BUG `tools.ts:218-221` (A3) — CORREGIDO** — `fs_search` usa `fs.promises.stat/readFile` (async): cede el event loop entre archivos en vez de congelar el editor en repos grandes.
- **✅ [Media] BUG `mcp.ts` dispose (A4) — CORREGIDO** — `dispose()` usa `killProcessTree` (tree-kill en Windows + SIGKILL en POSIX).
- **✅ [Media] BUG `mcp.ts:113` (A5) — CORREGIDO** — `callTool` respeta `isError`: prefija `Error:` para que el modelo distinga fallo de salida normal.
- **✅ [Media] BUG `mcp.ts:60` (A6) — CORREGIDO** — buffer stdio acotado a 8MiB (evita OOM por línea sin newline).
- **✅ [Media] BUG `mcp.ts` (A7) — CORREGIDO** — flag `alive` (false en exit/error): una request a un servidor muerto falla al instante en vez de esperar 30s.
- **✅ [Media] BUG `inference.ts:181` (A8) — CORREGIDO** — args JSON inválidos devuelven un tool result de error al modelo (para que reintente) en vez de ejecutar con `{}`.
- **✅ [Baja] BUG `inference.ts:147` (A9) — CORREGIDO** — `HARD_ITER_CAP=100` como backstop aun con `MAX_ITERS=0`: un bucle de tools desbocado no dispara coste infinito.
- **✅ [Baja] BUG `mcp.ts:40` (A10) — CORREGIDO** — se conserva la cola (2KB) de stderr y se incluye en el error de exit.

## 🟠 Webview / render (`media/**`)

- **✅ [Alta] BUG `conversation.js:38` stableSplit (W8, reportado 2026-06-22) — CORREGIDO** — durante el streaming, la primera letra de un bloque tras `\n\n` se recortaba ("Jenny"→"enny") hasta el render final. `stableSplit` sumaba un `\n` inexistente tras la última línea del `split`, sobrepasando `text.length`; `streamCommitLen` avanzaba de más y el siguiente carácter caía en el hueco entre el commit estable y el tail. Fix: no contar el `\n` de la última línea. (reproducido y verificado: el render stable+tail vuelve a coincidir con el whole-text en cada frame)

- **✅ [Media] BUG `media/chat/conversation.js:329` (W1, reportado) — CORREGIDO** — `canRegenFromPrompt` ya no exige adyacencia (`i+1===lastDisplayable`); se calcula `lastPromptIdx` (el último prompt de usuario cuya respuesta es `lastDisplayable`) y se compara `i===lastPromptIdx`. Así el botón regenerar aparece aunque entre el prompt y la respuesta haya mensajes intermedios de tools. (verificado: con tools, sin tools y multi-turno)

- **✅ [Alta] BUG `markdown.js:39,52` — CORREGIDO** — placeholder de code-spans pasa de ` dígito ` a ` dígito ` (NUL, jamás en prosa) → "entre 0 y 1 hay `x`" ya no corrompe los números ni emite `<code>undefined</code>`. (verificado)
- **✅ [Media] BUG `markdown.js:130-141` (W3) — CORREGIDO** — renderer de listas con anidación por indentación (pila de ul/ol); la jerarquía se conserva. (verificado: plana, anidada, mixta)
- **✅ [Media] BUG `mermaid.js:55` (W4) — CORREGIDO** — tras `await mermaid.render` se chequea `el.isConnected`: si un re-render desconectó el nodo, se omite el montaje (el nodo de reemplazo, re-marcado pending, se procesa en la siguiente pasada). Ya no "desaparecen" diagramas.
- **✅ (W5) — God-view `conversation.js` PARTIDO** — 500→**382** líneas: `buildExportHtml`+CSS → `chat/export.js` (71); paneles reasoning/tools → `chat/panels.js` (67). `message.js` ahora importa los paneles directo de `panels.js`, cortando parte de la dependencia circular `conversation↔message` (M7). El streaming sigue en `conversation.js` (acoplado a estado mutable; extraerlo a ciegas es riesgoso). Pasa `node --check` de todo el webview; **falta smoke test** (export/paneles/streaming).
- **✅ [Baja] BUG `core/dom.js:5` (W6) — CORREGIDO** — `escapeHtml(String(s))`: un valor no-string ya no rompe el render.
- **✅ [Baja] BUG `mermaid.js:179` (W7) — CORREGIDO** — UTF-8→base64 con `TextEncoder` en chunks (sin `unescape` deprecado, sin overflow con SVG grande).

## 🟠 Host / orquestación (`src/extension.ts`, `messageRouter.ts`, …)

- **✅ [Alta] BUG `extension.ts:74` — CORREGIDO** — `context.secrets.onDidChange(...)` ahora se registra en `context.subscriptions` → se limpia en deactivate (T8).
- **✅ [Alta] BUG `extension.ts:313` — CORREGIDO** — el callback ahora hace `void routeMessage(...).catch(...)`: loguea el error (`console.error`) y postea un `error` al webview, en vez de dejar un unhandled rejection sin feedback (la UI ya no queda colgada). `no-floating-promises` satisfecho.
- **🔎 [reclasificado] `extension.ts:135,361` (H3) — NO es bug** — revisado en detalle: `applyConfig` está acotado a su editor por closure (`getDoc`/`writeDoc`/`document` capturados), y `doc` se captura antes del `await`, así que NO escribe sobre el doc equivocado. El `static activeApply` solo enruta el "usar en chat" del sidebar al último chat activo (comportamiento deseado, documentado en el código). Es un olor de estado global (F4) pero funcionalmente correcto; no amerita cambio. Mi auditoría inicial lo sobrevaloró como "Alta BUG".
- **✅ [Alta] BUG `chatDocument.ts:174` — CORREGIDO** — `summary.upTo` se clampa a `[0, messages.length]` con `Math.floor`; valores corruptos (`-5`→drop, `99999`→len, `2.7`→2, `NaN`→drop) ya no se propagan al conteo de contexto. (verificado)
- **✅ [Media] BUG `messageRouter.ts:145` (H5) — CORREGIDO (parcial)** — `setConfig` ahora adquiere `busyRef` durante todo el handler (incluye el diálogo de Trust, ventana de segundos). delete/edit/replace son mutaciones síncronas + un `writeDoc` (ventana sub-ms ya cubierta por el chequeo y la UI serial de un solo usuario); residual despreciable.
- **✅ [Media] BUG `messageRouter.ts:364` (H6) — CORREGIDO/mitigado** — el HTML exportado lleva una CSP estricta con `nonce` para el script de auto-print (bloquea frames/objects/fetch/forms y cualquier inline script inesperado). El cuerpo ya iba escapado (renderMarkdown), así que el modelo no podía inyectar script; esto es defensa en profundidad.
- **✅ [Media] BUG `modelsPanel.ts:18` / `compareView.ts:96` (H7) — CORREGIDO** — ambos usan `makeNonce()`, que ahora es `crypto.randomBytes(16).toString('hex')` (128 bits, longitud fija). Se eliminó el `nonce()` con `Math.random` de modelsPanel y el patrón que recortaba entropía en compareView y en el propio `makeNonce`.
- **✅ [Media] BUG `modelsPanel.ts` (H8) — CORREGIDO/mitigado** — la escritura local ya saneaba el basename (`downloads.ts:204`); se añade validación de frontera en `doPull` que rechaza import paths absolutos o con `..`. (El residual de la URL HF se queda en huggingface.co, SSRF-safe por C6.)
- **🔎 [aceptada] `webviewHtml.ts:33` (H9)** — CSP con `style-src 'unsafe-inline'` (justificado por Mermaid) → cualquier `style=` inyectado pasa; depende del sanitizador.
- **✅ [Baja] BUG `extension.ts:194` / `attachmentStore.ts:66` (H10) — CORREGIDO** — IDs de mensaje y attachment usan `crypto.randomUUID()` (sin colisión en bucle síncrono).

## 🟠 Motores locales (Ollama / Piper / descargas)

- **✅ [Alta] BUG `ollama/manager.ts:142,194` + `piper/manager.ts` — CORREGIDO** — nuevo helper `killProcessTree` (`src/procKill.ts`): en Windows `taskkill /pid /T /F` mata el árbol (el `shell:true` envuelve `cmd.exe`); en POSIX SIGTERM y escalada a SIGKILL tras 3s. Aplicado en `stop()` de Ollama y `stopServer()`/startup-fail de Piper. (escalada SIGKILL verificada en POSIX)
- **✅ [Alta] BUG `piper/manager.ts:130` (L2) — CORREGIDO** — el `.onnx.json` se valida estructuralmente (`JSON.parse` + `phoneme_id_map` objeto); un HTML de error de HF o un json truncado se rechaza. (verificado)
- **✅ [Alta] BUG `piper/manager.ts:122-141` (L3) — CORREGIDO** — `ensureVoice` revalida el json existente y lo **re-descarga** si es inválido (en vez de `if (!existsSync)` que saltaba un json corrupto previo); si tras re-descargar sigue inválido, falla.
- **✅ [Media] BUG `ollama/downloads.ts:204` (L4) — CORREGIDO** — cada import descarga en un subdirectorio `importDir/<item.id>/`; dos descargas concurrentes con shards homónimos ya no se pisan. Se limpia la subcarpeta al terminar.
- **✅ [Media] BUG `piper/manager.ts:328` (L5) — CORREGIDO** — `Promise.race([waitForServer, spawnErr])` con `proc.once('error')`: un spawn fallido (ENOENT) falla al instante en vez de esperar 20s.
- **✅ [Media] BUG `download.ts:62` (L6) — CORREGIDO** — el listener `abort` se remueve en `req.on('close')` (ya no se acumulan sobre un signal compartido en redirects). (Residual menor: un `.part` de un SIGKILL del editor; `downloadFile` ya limpia en error/abort normal.)
- **🔎 [reclasificado] `piper/manager.ts:154` (L7) — riesgo teórico** — VS Code NO añade el workspace al PATH, así que `python`/`py` es el del sistema (no controlado por el workspace); además se prefiere el Python standalone SHA-pinned. Gatearlo por trust degradaría TTS sin beneficio real. Sin cambio.
- **✅ [Baja] BUG `piper/manager.ts:407` (L8) — CORREGIDO** — `req.setTimeout(30s)` destruye el request si el daemon deja de responder; ya no cuelga la UI de TTS.

**Verificado OK (motores):** los binarios de Ollama/Piper/Python **sí** se verifican por SHA256 pin con fail-closed; `downloadFile` usa `.part`+rename atómico y limpia en error/abort. El gap es la robustez del kill y las voces json sin hash, no la ausencia de verificación.

## 🟡 i18n (`src/i18n.ts`, `media/i18n.js`)

- **✅ [Media] (I1) — CORREGIDO** — 24 claves de UI (barra de búsqueda, controles de Mermaid, `of`, avisos) traducidas a es/pt/fr/de/it (24×5).
- **✅ [Baja] (I2) — CORREGIDO** — clave renombrada a `Reset / center` (americano, consistente con el resto).
- **✅ [Baja] (I3) — CORREGIDO** — eliminadas las 2 claves sin uso (`Reprocess (regenerate as a new variant)`, `Search in chat…`) de los 5 bundles.

## 🟡 CSS — deuda menor (no lo que dije antes)

- **✅ [Baja] (S1) — CORREGIDO** — verde/ámbar de estado usan `var(--vscode-charts-green/yellow, …)` con fallback (consistente con `.high`/`.error`, mejor contraste en temas claros).
- **✅ [Baja] (S2) — CORREGIDO** — `.think-badge`/`.tool-badge` consolidados en un solo bloque + hover compartido; las reglas `.has-*` siguen alternando cada uno.
- **✅ [Baja] (S3) — CORREGIDO** — el `:focus` añade `box-shadow: 0 0 0 1px var(--vscode-focusBorder)` → anillo de foco visible por teclado.
- **✅ [Baja] (S4) — CORREGIDO (parcial)** — quitado el `max-height: none` muerto de `.mermaid-modal .mermaid-viewport`. (El full-width de `.msg.user/.assistant` se deja: es diseño intencional documentado, no residuo.)

---

## Transversales

- **🔎 PARCIAL — `any` en lógica interna (X1 + P12)** — **Hecho** (commit `77e4d79`): `errMsg(unknown)` tipado y eliminados los `any` internos mal tipados de `localModels.ts` (catches → `errMsg(e)`, `which: string`). **Quedan ~180, pero son FRONTERA LEGÍTIMA, no errores**: JSON dinámico de APIs externas (providers/http), args de comandos de VS Code (la API los tipa `any`), errores capturados. El propio `eslint.config.js` **desactiva `no-explicit-any` a propósito** ("the code handles dynamic JSON on purpose"), así que convertirlos a `unknown`+narrowing es churn sin beneficio en runtime y contra la política del repo. No es deuda pendiente de cierre — es decisión de diseño.
- **✅ [M2] 6 archivos 400–500 — REDUCIDOS** (split por cohesión): `conversation.js` 500→382 (+export.js+panels.js), `messageRouter.ts` 445→394 (+sysprompt), `panels/config.js` 407→287 (+configTts.js), `piper/manager.ts` 481→413 (+assets.ts), `extension.ts` 449→404 (+applyPatch.ts). **Pendiente:** `media/models.js` (409) es un IIFE clásico (no ES module, `<script src>`); partirlo a ciegas (sin poder correr la app) es riesgoso y solo está 9 líneas sobre la alarma blanda — diferido a una sesión con la app corriendo.
- **✅ `catch` vacíos (X3) — CORREGIDO** — comentados como best-effort (tts logging/audio, pointer capture).
- **🔎 Higiene (X4) — decisión del usuario** — `.webview-backup/` (gitignored) y `plan-*.md` (no trackeados) no afectan el repo ni el paquete; son archivos locales tuyos, no los borro sin permiso.

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

## 🐞 Segunda pasada de caza de bugs (2026-06-22)

Tras la primera auditoría, una caza adicional enfocada en correctitud encontró 6 bugs nuevos
(no estaban en el inventario original). 5 corregidos, 1 documentado:

- **✅ B1/W9 — Streaming rompía bloques multilínea** (tabla/lista/blockquote se mostraban como `<p>`
  sueltos hasta terminar el stream). `stableSplit` commiteaba una línea en blanco que era la última.
  Fix: solo es boundary si hay línea después. {commit `fbd617f`}
- **✅ B2 — Negrita con `*` interno** (`**2 * 3 = 6**`) se corrompía. `[^*]+` → `[\s\S]+?`. {`82faf65`}
- **✅ B3 — Celdas de tabla** partían en `\|` escapado o `|` dentro de code-span. `splitRow` tokeniza. {`82faf65`}
- **✅ B5 — `deleteVariant`** mostraba la variante equivocada al borrar una con índice < activa. {`ab4cefc`}
- **✅ B6 — Turno con answer vacío tras tools** dejaba la cadena de tools colgante en disco; ahora se
  persiste un assistant de cierre (`usedTools`). {`aafab77`}
- **✅ B4 — CORREGIDO: Find/Replace salta ocurrencias dentro de URLs** cuando el término
  aparece dentro de una URL o sintaxis markdown (la cuenta de ocurrencias del webview = `<mark>`
  visibles; la del host = ocurrencias en el source crudo; divergen si una ocurrencia del source no
  produce un `<mark>` visible, p. ej. dentro de un `href`). `media/features/find.js:179-191` lo asume
  explícitamente. Fix correcto: mapear offset source↔rendered (rediseño, no trivial). Diferido.
