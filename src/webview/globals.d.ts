// Ambient declarations for the webview ES modules: the VS Code webview API, the classic scripts that
// set window.* globals (i18n / spell), the lazy-loaded Mermaid lib, and the HTML-injected vars.

/** Per-webview state persisted via the VS Code webview API (NOT the .chat): chat zoom + TTS prefs. */
interface WebviewState {
  zoom?: number;
  tts?: Record<string, unknown>;
}
interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): WebviewState | undefined;
  setState(state: WebviewState): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

/** The classic i18n bridge (window.LangI18n), set by src/webview/i18n before the module bundle runs. */
interface LangI18nApi {
  t(s: string): string;
  get(): string;
  set(l: string): void;
  setBundle(b: Record<string, string>): void;
  applyStatic(d: Document): void;
}

/** The classic spell bridge (window.LangSpell), backed by the vendored nspell engine. */
interface LangSpellApi {
  setLang(l: string): void;
  lang(): string | null;
  ready(): boolean;
  onReady(cb: () => void): void;
  setWords(words: string[]): void;
  add(word: string): void;
  correct(word: string): boolean;
  suggest(word: string): string[];
}

/** The vendored Mermaid lib (window.mermaid), lazy-loaded as a <script> on the first diagram. */
interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

interface Window {
  LangI18n: LangI18nApi;
  LangSpell?: LangSpellApi;
  mermaid?: MermaidApi;
  MERMAID_SRC?: string;
  JOTFLOW_NONCE?: string;
  DOWNLOADED_VOICES?: string[];
  PIPER_CUSTOM_SET?: boolean;
  CHATTERBOX_EXAGGERATION?: number;
  SPELL_DICTS?: Record<string, { aff: string; dic: string }>;
  // Non-standard Safari/WebKit fallback for AudioContext (not in lib.dom).
  webkitAudioContext?: typeof AudioContext;
}
