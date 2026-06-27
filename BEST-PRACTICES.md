# Best Practices — TypeScript / JavaScript / CSS & VS Code Extensions

> Estándar de desarrollo para **Jotflow**. Catálogo exhaustivo de reglas con ejemplos
> correcto (✓) / incorrecto (✗). Cada regla es accionable y verificable en review.
>
> **Fuentes sintetizadas:** TypeScript Handbook (*Do's & Don'ts*), MDN (*JS Code Style*,
> *Organizing CSS*), andredesousa (*typescript-best-practices*, *css-best-practices*),
> stevekwan (*JS best-practices*), Snyk (*Modern VS Code Extension Development*), W3Schools.
> Adaptadas a este proyecto: extensión VS Code, host Node + webview sin build, TS `strict`, i18n.
>
> Convención: el inglés es el idioma fuente del **código**; los ejemplos van en inglés.
> Relacionados: [ARCHITECTURE.md](ARCHITECTURE.md), [CONTRIBUTING.md](CONTRIBUTING.md),
> [SECURITY.md](SECURITY.md).

**Índice** — A.[Nombres](#a-nombres) · B.[Variables](#b-variables-y-declaración) ·
C.[TS tipos](#c-typescript--sistema-de-tipos) · D.[TS declaraciones](#d-typescript--declaraciones-handbook) ·
E.[Funciones](#e-funciones) · F.[Funcional/inmutabilidad](#f-programación-funcional-e-inmutabilidad) ·
G.[Control de flujo](#g-control-de-flujo) · H.[Sintaxis moderna](#h-sintaxis-y-operadores) ·
I.[Objetos y arrays](#i-objetos-y-arrays) · J.[Comentarios](#j-comentarios) ·
K.[Async](#k-async--promesas) · L.[Errores](#l-errores) · M.[Módulos/tamaño](#m-módulos-organización-y-tamaño) ·
N.[Vistas/webview](#n-vistas--webview) · O.[CSS nombres](#o-css--metodología-y-nombres) ·
P.[CSS selectores](#p-css--selectores-y-especificidad) · Q.[CSS valores](#q-css--valores-y-unidades) ·
R.[CSS organización](#r-css--organización-y-build) · S.[Rendimiento](#s-rendimiento) ·
T.[Extensiones VS Code](#t-extensiones-vs-code) · U.[Seguridad](#u-seguridad) ·
V.[Testing](#v-testing) · W.[Tooling/repo](#w-tooling-build-e-higiene-de-repo) ·
X.[Checklist](#x-checklist-pre-commit).

---

## A. Nombres

**A1.** Nombres **descriptivos y pronunciables**; mídelos por lo que explican, no por lo que
ahorran. `elapsedDays`, no `d`/`x1`/`fe2`.
**A2.** **`camelCase`** variables/funciones · **`PascalCase`** tipos/clases/interfaces ·
**`UPPER_SNAKE`** constantes de módulo.
**A3.** **Booleanos con prefijo** `is`/`has`/`should`/`can`: `isLoading`, `hasApiKey`, `canRetry`.
**A4.** **Sin notación húngara** ni sufijos de tipo: `name`, no `nameStr`; `users`, no `userArray`.
**A5.** **Colecciones en plural**: `cars`, no `carList`.
**A6.** **Nombres de 3–10 chars**, semánticos y del dominio real; evita posesivos (`myCar`).
**A7.** **Sin magic numbers/strings**: dales nombre. `const MAX_RETRIES = 3`.
**A8.** **Inglés siempre** (idioma fuente del código).

## B. Variables y declaración

**B1.** **`const` por defecto**, `let` solo si reasignas, **nunca `var`** (scope de función, mutable).
**B2.** **Una variable por línea**; no encadenes `let a, b, c`.
**B3.** **Inicializa al declarar**; evita estados `undefined`.
**B4.** **Defaults de parámetro** para opcionales: `function log(msg = '') {}`.
**B5.** **Declara cerca del primer uso** (no obligatorio "todo arriba", pero agrupa lo relacionado).

## C. TypeScript — sistema de tipos

**C1.** **`strict` activado** y sin aflojar por archivo: incluye `noImplicitAny`, `strictNullChecks`,
`noImplicitReturns`, `forceConsistentCasingInFileNames`.
**C2.** **`any` es deuda → usa `unknown` + narrowing.** `any` apaga el chequeo completo.
```ts
function h(x: any) { x.foo(); }                       // ✗
function h(x: unknown) { if (typeof x === 'string') x.toLowerCase(); }  // ✓
```
**C3.** Único `any` tolerado: **JSON dinámico de APIs externas**, aislado en la capa de parse/adaptador.
**C4.** **Tipa fronteras, infiere lo interno**: anota parámetros, retornos públicos e interfaces; no
locales que TS deduce.
**C5.** **Uniones de literales** para conjuntos cerrados: `type Status = 'pending' | 'approved'`.
Una fuente de verdad que además genera el type-guard.
**C6.** **Uniones discriminadas** con campo literal (`kind`/`type`): `{ kind:'text'; text } | { kind:'image'; url }`.
**C7.** **`readonly` por defecto** en lo inmutable; `readonly T[]` en parámetros no modificados.
**C8.** **Utility types** en vez de duplicar: `Partial`, `Readonly`, `Pick`, `Omit`, `Record`.
**C9.** **`interface` para formas/contratos**, **`type` para uniones/tuplas/alias**.
**C10.** No fragmentes interfaces agresivamente si oscurece la estructura.

## D. TypeScript — declaraciones (Handbook)

**D1.** **Primitivos en minúscula**, nunca boxed: `string`/`number`/`boolean`, no `String`/`Number`.
Usa `object`, no `Object`.
**D2.** **Genéricos que usan su parámetro**; un `<T>` que no aparece en la firma no infiere nada.
**D3.** **Callbacks ignorados → retorno `void`** (no `any`): impide usar el valor por accidente.
**D4.** **No hagas opcionales los parámetros de un callback** que siempre recibirán valor.
**D5.** **No multipliques sobrecargas por aridad de callback**: declara la aridad máxima una vez.
**D6.** **Parámetros opcionales en vez de sobrecargas que solo añaden cola**:
`diff(a: string, b?: string)`, no tres firmas.
**D7.** **Uniones en vez de sobrecargas que difieren en un tipo**: `utcOffset(b: number | string)`.
**D8.** **Ordena sobrecargas de específica → general** (TS toma la primera que encaja).

## E. Funciones

**E1.** **Pequeñas y de una sola responsabilidad** (~5–15 líneas); si el nombre pide un "y", son dos.
**E2.** **≤3 parámetros**; más → objeto de opciones: `createUser(opts)`.
**E3.** **Sin flag booleano** que bifurca el cuerpo → parte en `getUser` / `getUserWithProfile`.
**E4.** **Poca anidación**: *early return*, extrae sub-funciones; no pirámides de `if`.
**E5.** **Declaración de función** sobre expresión asignada a `const` para funciones nombradas.
**E6.** **Arrow para callbacks** (sin `this` propio); **retorno implícito** si es expresión:
`list.map(x => x.id)`.

## F. Programación funcional e inmutabilidad

**F1.** **Prefiere funciones puras**: salida determinada solo por la entrada, sin efectos.
**F2.** **Inmutabilidad sobre estado compartido**: crea nuevo, no mutes.
```ts
arr.push(x);                 // ✗ si arr es compartido
const next = [...arr, x];    // ✓     const upd = { ...user, age: 41 };
```
(Mutar un array local que tú creaste es correcto y más rápido — la regla es para estado compartido.)
**F3.** **Centraliza los efectos** (I/O, red, DOM, estado global); el resto puro.
**F4.** **Evita estado global**; inyecta dependencias por argumento, sin singletons ocultos.
**F5.** **Métodos de array** (`map`/`filter`/`reduce`) sobre bucles cuando gana legibilidad.
**F6.** **Reemplaza condicionales complejos** por polimorfismo / estrategia cuando se repiten.
**F7.** **Iteradores/generadores** para datos en streaming o evaluación perezosa.

## G. Control de flujo

**G1.** **`switch`: `return` por caso** (sin `break`), **`default` al final**, **llaves `{}`** si
declaras variables en un caso.
**G2.** **Siempre incluye `default`** en `switch` para atrapar valores inesperados.
**G3.** **No `else` tras `return`**: aplana el camino feliz.
**G4.** **Ternario para asignación simple**: `const x = cond ? 1 : 2`.
**G5.** **Llaves siempre** en control de flujo, aun con una sola sentencia.

## H. Sintaxis y operadores

**H1.** **`===`/`!==` siempre** (excepción documentada: `== null` con comentario).
**H2.** **Atajo booleano** `if (x)` / `if (!x)`, no `if (x === true)`.
**H3.** **Template literals**, no concatenación: `` `Hi ${name}` ``.
**H4.** **Destructuring y spread**: `const { id } = user`, `const [a, ...rest] = list`.
**H5.** **Conversión explícita**: `String(v)` / `Number(v)`, no `'' + v` ni `+v`.
**H6.** **Sin `eval`, `with`, `void` como operador** ni modificar prototipos nativos
(`Array.prototype`, `Object`, `Date`…).

## I. Objetos y arrays

**I1.** **Literales, no constructores**: `[]` / `{}`, no `new Array()` / `new Object()`.
**I2.** **`push()` para añadir**, no `arr[arr.length] = x`.
**I3.** **Object shorthand**: `return { name, age }`; **método corto**: `{ foo() {} }`.
**I4.** **`class` ES** para tipos de objeto con comportamiento.
**I5.** **`Object.hasOwn(o, k)`**, no `o.hasOwnProperty(k)` (deprecado).
**I6.** **`for...of` / `forEach`** sobre `for (;;)` salvo hot-path medido; **nunca `for...in`** sobre
arrays/strings. `const` en `for...of`, `let` en bucles con índice.

## J. Comentarios

**J1.** **Comenta la intención y el "por qué"**, no lo obvio que ya dice el código.
**J2.** **Nada de código comentado**: para eso está git; bórralo.
**J3.** **Comentarios solo los necesarios** ("as much as needed, not more").
**J4.** **JSDoc en la API pública** (parámetros, retorno, throws) cuando aporta.

## K. Async / Promesas

**K1.** **`async`/`await`** sobre callbacks y `.then()` encadenado.
**K2.** **Ninguna promesa flotando** (`@typescript-eslint/no-floating-promises` en `error`): `await`
o `void` explícito.
**K3.** **Paraleliza lo independiente** con `Promise.all`; secuencial solo si hay dependencia.
**K4.** **Toda operación larga acepta y respeta `AbortSignal`** (fetch, streaming, loops). Contrato
de `LLMProvider.chat` (`cb.signal`).
**K5.** **Streams por chunks** (`for await`), sin acumular todo en memoria.
**K6.** **Timeout en toda I/O de red**: sin él, una llamada cuelga la UI indefinidamente.

## L. Errores

**L1.** **Lanza `Error` (o subclase), nunca strings ni objetos planos**: sin stack no hay
diagnóstico. `throw new Error('parse failed: ' + path)`.
**L2.** **No tragues excepciones**: `catch {}` vacío solo con comentario que lo justifique; mínimo,
loguear. **Omite el binding** si no lo usas: `catch { … }`.
**L3.** **Esperado vs bug**: red/clave inválida → mensaje accionable; `TypeError` → bug tuyo, no lo
disfraces de toast amable.
**L4.** **Valida en la frontera** (usuario, disco, red, mensajes del webview) antes de propagar al
núcleo tipado.
**L5.** **Centraliza el formateo** (un helper de error HTTP), no `try/catch` ad-hoc copiados.

## M. Módulos, organización y tamaño

> Origen del invariante: **3 god-files de ~2000 líneas** costaron horas de desmodularización.

**M1.** **Techo duro: ningún archivo >500 líneas** (TS, JS **y CSS**).
**M2.** **Objetivo real ~200–300**; a 400+ planifica el corte.
**M3.** **Un archivo = un motivo de cambio** (alta cohesión, bajo acoplamiento).
**M4.** Señales de corte: nombre con "y"; imports temáticamente distintos; funciones relacionadas
separadas por scroll; merge conflicts recurrentes; cuesta testear por mezclar I/O y lógica.
**M5.** **Divide al escribir, no al final** (el corte tardío es refactor caro).
**M6.** **Exporta lo mínimo**; lo que no se importa fuera, no se exporta; lo que no se importa, se borra.
**M7.** **Sin dependencias circulares**: si A↔B, falta una capa.
**M8.** **Agrupa y limpia imports** (orden estable, sin imports muertos — lo marca el linter).
**M9.** **No mezcles tecnologías**: HTML/CSS/JS separados, sin estilos ni markup incrustados en JS.
**M10.** **Saca a configuración** lo que cambie a menudo (objetos de config, traducciones).

## N. Vistas / webview

Toda vista o panel es un **módulo cerrado**, no un script monolítico. Piezas, cada una en su archivo:

| Pieza        | Responsabilidad                       | No hace                          |
|--------------|---------------------------------------|----------------------------------|
| **render**   | DOM ← estado (`estado → nodos`, puro) | No hace fetch ni muta estado     |
| **store**    | Datos de la vista y transiciones      | No toca el DOM                   |
| **eventos**  | Listeners → acciones sobre el store   | No renderiza directo             |
| **protocolo**| Mensajes host↔webview de la vista     | No tiene lógica de presentación  |
| **estilos**  | CSS de la vista, aislado              | No define estilos globales       |

**N1.** **Una vista = una carpeta/prefijo**; no mezclada con otra vista.
**N2.** **El controlador solo orquesta** (cablea render+eventos+protocolo); cero lógica de negocio.
**N3.** **Sin estado global compartido entre vistas**: cada una con su store; lo común se inyecta.
**N4.** **Extrae el componente reutilizable** (botón, lista, spinner) en cuanto aparece la 2.ª copia.
**N5.** **El webview no tiene FS ni red propios**: pide al host por `postMessage` (diseño de seguridad).
**N6.** **Contrato de mensajes explícito**: `type` + payload conocido; dispatch en un router, no
`switch` gigantes duplicados a ambos lados.
**N7.** **ES modules reales** (`import`/`export`), nunca globals colgando de `window`; namespacea lo
inevitable (`const App = App || {}`).
**N8.** **`node --check media/*.js`** tras cada cambio (única red de sintaxis del webview).
**N9.** **Distingue entry-point de módulo por convención** (`*.entry.js` o carpeta `app/`), no por
dejar dos archivos del mismo nombre en carpetas distintas.

## O. CSS — metodología y nombres

**O1.** **Adopta una metodología** y sé consistente: BEM (recomendada), o ITCSS/OOCSS/SMACSS.
**O2.** **BEM**: `block`, `block__element`, `block--modifier`. Ej. `.card`, `.card__title`, `.card--featured`.
**O3.** **OOCSS**: separa estructura de piel; **múltiples clases** por elemento (`class="box warning"`).
**O4.** **Nombres descriptivos por propósito**, no genéricos (`.board`, `.user` → reutilización
accidental).
**O5.** **No concatenes nombres** con `&-foo` del preprocesador (oculta el selector real a la búsqueda).
**O6.** **Agrupa estilos por sujeto** (el elemento), no por contexto: todos los botones juntos, no
dispersos por componente.

## P. CSS — selectores y especificidad

**P1.** **Cero IDs en selectores** para elementos **reutilizables o estilados por contexto**
(especificidad alta que provoca guerras de cascada). **Excepción acotada:** un **singleton** del
documento (un único `#messages`, `#sendBtn`, `#notices`) puede estilarse por su `id` — el motivo de
la regla (evitar guerras de especificidad y reutilización accidental) no aplica a un elemento único.
Toda **vista/componente nuevo** usa **clases** (los paneles `engines`/`voices` ya lo hacen).
**P2.** **Cero estilos inline** (`style="…"`): mezclan contenido y presentación.
**P3.** **Sin selectores cualificados**: `.nav`, no `ul.nav`.
**P4.** **Sin cadenas largas/innecesarias**: `.someclass li`, no `body #wrap .someclass ul li`.
**P5.** **Evita selectores peligrosos/genéricos** (`div {}` con propiedades específicas) que filtran
estilos.
**P6.** **Cada selector clave una sola vez** (single source of truth); no repartas `.btn` por varias
reglas.
**P7.** **Anidación ≤3 niveles** en preprocesador.
**P8.** **`!important` solo proactivo** (una regla deliberadamente global, p. ej. errores en rojo),
**nunca reactivo** para ganar especificidad.

## Q. CSS — valores y unidades

**Q1.** **Unidades relativas** (`rem`, `em`, `%`, `vw/vh`, `fr`) sobre `px`/`pt` fijos.
**Q2.** **Sin valores hard-coded**: `line-height: 1.333`, no `32px`.
**Q3.** **Sin magic numbers ni brute-forcing** (`margin-left: -3px` a ojo = box-model mal entendido).
**Q4.** **Variables CSS** (`--color-accent`) para temas/reutilización; en un editor hereda los
*theme tokens* de VS Code (`var(--vscode-…)`).
**Q5.** **Hex sobre nombres de color**; nombra las variables de color por legibilidad.
**Q6.** **Longhand sobre shorthand** cuando el shorthand resetearía propiedades que no querías tocar.
**Q7.** **El contenido define el tamaño** (`padding`/`max-width`), no dimensiones fijas.
**Q8.** **El padre controla la posición del hijo** (margins/posicionamiento fuera del componente) →
reutilizable.
**Q9.** **Distingue block vs inline** al estilar; **mantén la semántica HTML** (no alteres markup solo
por estilo).
**Q10.** **No deshagas estilos**: añade progresivamente; si hay que quitar, reestructura el selector.

## R. CSS — organización y build

**R1.** **Una propiedad por línea**; **agrupa selectores** que comparten reglas con coma
(`h1, h2, h3 { … }`).
**R2.** **Orden de propiedades consistente** (alfabético u otro, vía linter).
**R3.** **Secciones lógicas comentadas**, orden general → utilidades → layout/sitewide →
componentes; marcadores buscables (`/* || Header */`).
**R4.** **Comenta decisiones no obvias** (fallbacks, hacks temporales).
**R5.** **Modulariza por vista/feature** (varios archivos pequeños), carga solo lo necesario.
**R6.** **Separa global vs local**; **componentes con estilo encapsulado**.
**R7.** **Elimina CSS muerto** (PurgeCSS/UnCSS); **minifica** en build (cssnano).
**R8.** **Autoprefixer + Browserslist** para compatibilidad; **stylelint** para consistencia.
**R9.** **Pocas fuentes**: cada WebFont retrasa el render; optimiza su carga.
**R10.** **Media queries con variables** descriptivas (`$medium: 768px`).

## S. Rendimiento

**S1.** **Enfócate en lo grande**: reflows del DOM, eventos frecuentes, peticiones HTTP — no
micro-optimizar lo invisible.
**S2.** **Minimiza el acceso al DOM**: cachea queries, agrupa actualizaciones (DOM es caro).
**S3.** **Lazy-loading / code-splitting** en puntos lógicos; reduce el bundle inicial.
**S4.** **Comprime (gzip/brotli) y minifica** en producción.
**S5.** **Web Workers** para tareas pesadas que bloquearían la UI.
**S6.** **Feature detection sobre browser detection**; sin código browser-specific.

## T. Extensiones VS Code

**T1.** Layout estándar: `src/extension.ts` (entry), `package.json` (manifiesto), `tsconfig.json`,
`.vscode/{launch,tasks}.json`.
**T2.** **`@types/vscode`** para tipos (el paquete `vscode` está deprecado).
**T3.** `activate(context)` al disparo; `deactivate()` para limpieza.
**T4.** **Activación perezosa**: dispara por contribución concreta (comando, lenguaje, view), **no**
en el arranque del editor; `activationEvents` mínimo.
**T5.** **Contribution points** declaran cómo se invocan las capacidades (commands, menus, views,
settings).
**T6.** **`package.json` ↔ código ↔ nls en sync**: todo comando declarado en `contributes.commands`
y registrado; toda clave `%key%` en **todos** los bundles `package.nls.<lang>` (huérfana = literal).
**T7.** Tras tocar `package.json` (commands/menus/views), **recarga el dev host (⌘R)**.
**T8.** **Todo disposable a `context.subscriptions`** (comandos, paneles, watchers, procesos): una
fuga es una fuga en el editor del usuario.
**T9.** **Procesos hijo con lifecycle explícito** (Ollama, Piper, MCP en `*/manager.ts`): mueren con
la extensión.
**T10.** **i18n desde el día 1**: inglés como clave; cero texto visible hardcodeado.
**T11.** **Extiende por el punto de extensión existente** (factory/interface, p. ej. `LLMProvider`),
no parcheando el núcleo.
**T12.** **Empaqueta con esbuild** (recomendado por MS; minify solo con `--minify`); declara deps
dinámicas como estáticas o `external`.
**T13.** **Prueba en el Extension Development Host** (F5) + tests unitarios antes de publicar.
**T14.** Revisa el `.vsix` con `vsce ls` antes de `vsce package` (respeta `.vscodeignore`).

## U. Seguridad

**U1.** **Secretos en `SecretStorage`**, jamás en settings ni disco (API keys vía `KEY_PROVIDERS`).
**U2.** **Respeta `untrustedWorkspaces`**: features con FS/exec degradan con gracia.
**U3.** **Webview con CSP estricta**: `nonce` por script, sin inline scripts, sin `eval`.
**U4.** **Nunca `innerHTML` con datos de usuario/modelo** (XSS): usa `textContent`, construye DOM o
sanitiza el markdown; escapa nombres (`escapeHtml`) antes de interpolar.
**U5.** **Valida toda entrada externa**; cuidado con **SSRF** y **path traversal** en herramientas
que tocan URLs/rutas.
**U6.** **Dependencias auditadas** (`npm audit`/Snyk); fija binarios externos por hash/pin.

> Las reglas U7–U11 nacen de hallazgos reales de **CodeQL** (ver §W7); cada una cita su query.

**U7.** **Sanea HTML con *allowlist* de DOM, no *denylist* con regex.** Para insertar HTML
potencialmente no confiable (READMEs, contenido scrapeado), parséalo en un `<template>` **inerte**
(su contenido no se renderiza y los `<script>` no se ejecutan) y conserva **solo** tags/atributos de
una lista blanca (ver `sanitizeHtml` en `models.js`). Un `.replace()` que borra `<script>`/`on*` es
**incompleto**: un payload partido o anidado (`<scr<script>ipt>`) se reensambla en una sola pasada
(CodeQL `js/incomplete-multi-character-sanitization`). Si *de verdad* no hay alternativa a regex,
hazlo en **bucle hasta punto fijo** (`do { p=s; s=s.replace(re,'') } while (s!==p)`).
**U8.** **Filtros de tags tolerantes** (no single-shot ingenuo). Un cierre como `</script>` debe
matchear también `</script >` / `</script\tbar>`: usa `</script[^>]*>` (CodeQL `js/bad-tag-filter`).
**U9.** **Bytes no confiables → media por `Blob` + `URL.createObjectURL`**, nunca por `data:` +
concatenación. Meter `mime`/base64 de un adjunto en `img.src = 'data:'+mime+';base64,'+data` lleva
datos no confiables a un *sink* de URL (CodeQL `js/xss-through-dom`, `js/client-side-unvalidated-url-redirection`).
Decodifica a `Blob`, usa el `blob:` que **genera el navegador**, valida el `mime` (`image/…`) y
**revoca** la object URL en `load`/`error` (ver `setImageSrc` en `core/dom.js`).
**U10.** **Orden de decodificación de entidades: `&amp;` al final.** Decodificar `&amp;`→`&` antes que
`&lt;`/`&gt;` produce doble-unescape (`&amp;lt;` → `<` en vez de `&lt;`) (CodeQL `js/double-escaping`).
**U11.** **Sin reemplazos identidad / no-op.** `.replace(/X/g, 'X')` reemplaza algo por sí mismo
(CodeQL `js/identity-replacement`); para **escapar** un carácter a un literal usa la secuencia escapada
(p. ej. U+2028/U+2029 → `'\\u2028'`/`'\\u2029'` para embeber JSON en un `<script>` inline), no el carácter.
**U12.** **`innerHTML` solo con HTML que tú generas; escapa toda interpolación** — incluso etiquetas
"de confianza" (traducciones `t()`, nombres): `escapeHtml()` antes de concatenar (CodeQL `js/xss`).
Mejor aún, construye nodos DOM (`textContent`).

## V. Testing

**V1.** **`node:test`** sobre la **lógica pura** (parsing, transforms, helpers): máximo retorno.
**V2.** **Diseña para testear**: lo difícil de testear mezcla I/O y lógica → extrae la lógica.
**V3.** **Un test de regresión por cada bug** arreglado.
**V4.** **Corre en CI** y bloquea el merge si falla.
**V5.** **"Testing > shipping"**: cubre toda feature nueva; sube la confianza, baja regresiones.

## W. Tooling, build e higiene de repo

**W1.** **ESLint** (flat config) en `error` para lo que rompe (`no-floating-promises`, `no-var`,
`no-unused-vars`); pragmático con `any` solo en la capa de JSON externo.
**W2.** **Prettier** para formato (cero debates de estilo); **stylelint** para CSS; **lint-staged**
en commits.
**W3.** **Sin generados ni backups versionados** (`out/`, `*-backup/`, `*.old`) salvo intención
explícita en `.gitignore`/`.vscodeignore`. Git es el backup; nada de código comentado en bloque.
**W4.** **Docs de planificación efímeros** (`plan-*.md`, `*-todo.md`) no se quedan en `main`: se
convierten en issues o se borran.
**W5.** **`CHANGELOG.md` por release**, `version` bumpeada antes de publicar.
**W6.** **README/ARCHITECTURE reflejan la realidad**, no aspiraciones.
**W7.** **GitHub CodeQL (code scanning)** corre en cada push a `master`; mantén sus *security
queries* de JS/TS en **0 alertas** (`js/xss`, `js/xss-through-dom`, `js/client-side-unvalidated-url-redirection`,
`js/bad-tag-filter`, `js/double-escaping`, `js/incomplete-multi-character-sanitization`,
`js/identity-replacement`…). Ante un falso positivo legítimo, **refactoriza al patrón que CodeQL
reconoce** (allowlist DOM, `Blob` URL, guard con `RegExp.test`) antes de recurrir a un *dismiss*
justificado. Las reglas U7–U12 codifican los hallazgos ya vistos.

## X. Checklist pre-commit

```bash
npm run compile           # tsc → out/   (0 errores)
npm run lint              # eslint src   (0 errores / 0 warnings)
node --check media/*.js   # sintaxis del webview JS
npm test                  # compile + node:test
```

A ojo:
- [ ] ¿Algún archivo >500 líneas (TS, JS o CSS)? → divídelo ahora.
- [ ] ¿Vista nueva modularizada (render / store / eventos / protocolo / estilos)?
- [ ] ¿`any` nuevo fuera de la capa de JSON externo? → `unknown` + narrowing.
- [ ] ¿Promesa nueva `await`eada o `void`? ¿I/O con timeout y `AbortSignal`?
- [ ] ¿`innerHTML` con datos del modelo? → `textContent`/sanitiza (allowlist DOM, no regex; U7/U12).
- [ ] ¿HTML/URL no confiable? → sin denylist regex, sin `data:`+concat (usa `Blob`/`createObjectURL`),
  `&amp;` se decodifica al final, sin `.replace` identidad (U7–U11). ¿CodeQL en 0 (W7)?
- [ ] ¿Selector CSS con ID o `!important` reactivo? → refactor.
- [ ] ¿Nuevo `%nls%` en todos los bundles? ¿Comando declarado + en disposables?
- [ ] ¿Secreto nuevo en `SecretStorage`?
- [ ] ¿Quedó código muerto, backup o doc de plan suelto? → bórralo.

> **~140 reglas** en 24 secciones (A–X). Si una situación no encaja en ninguna, es candidata a regla
> nueva: abre PR sobre este documento.
