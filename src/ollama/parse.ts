/** Helpers puros del subsistema de modelos (sin VS Code ni red, testeables). */
import type { ModelCapabilities } from './registry';

/** Formatea bytes a una unidad legible (GB/MB). */
export function formatBytes(n: number): string {
  if (!n || n < 0) return '—';
  const gb = n / 1073741824;
  if (gb >= 1) return gb.toFixed(2) + ' GB';
  return (n / 1048576).toFixed(0) + ' MB';
}

/**
 * Capacidades estimadas a partir de tags/pipeline/nombre + conocimiento de familias de modelos.
 * Los tags de HF son escasos (las orgs oficiales no etiquetan reasoning/tools), así que añadimos
 * conocimiento de familias (gemma-4, qwen3, llama-4…). La verdad exacta llega de /api/show tras bajar.
 */
export function heuristicCapabilities(id: string, tags: string[], pipeline = ''): ModelCapabilities {
  const hay = (id + ' ' + tags.join(' ') + ' ' + pipeline).toLowerCase();
  const has = (...needles: string[]) => needles.some((n) => hay.includes(n));
  const re = (r: RegExp) => r.test(hay);
  return {
    vision: has('vision', 'multimodal', 'image-text', 'any-to-any', '-vl-', 'llava', 'moondream',
      'pixtral', 'internvl', 'minicpm-v', 'smolvlm', 'idefics', 'image-to-text')
      || re(/\bgemma-?[34]\b/) || re(/\bllama-?4\b/) || re(/qwen2?\.?5?-?vl/) || re(/qwen3-?vl/),
    tools: has('tool', 'function-cal', 'function cal', 'agent', 'hermes', 'functionary',
      'command-r', 'firefunction', 'watt-tool')
      || re(/\bgemma-?4\b/) || re(/\bqwen-?[23]/) || re(/\bllama-?[34]\b/) || re(/\bministral\b/)
      || re(/\bmistral\b/) || re(/granite-?3/),
    reasoning: has('reason', 'thinking', 'think', 'qwq', 'magistral', 'cogito', 'openthinker',
      'marco-o1', 'skywork-o1', 'exaone-deep', 'cot')
      || re(/\br1\b/) || re(/deepseek-?r1/) || re(/\bgemma-?4\b/) || re(/\bqwen3\b/) || re(/\bphi-?4\b/),
  };
}

/**
 * Detecta ficheros .gguf auxiliares (NO son el modelo principal descargable):
 * proyectores de visión (mmproj) y modelos draft de speculative decoding (MTP/draft).
 */
export function isAuxiliaryGguf(filePath: string): boolean {
  const full = filePath.toLowerCase();
  const base = (filePath.split('/').pop() || filePath).toLowerCase();
  // Proyector de visión.
  if (/(?:^|[._-])(mmproj|mproj|projector|clip|vision[._-]?adapter)(?:[._-]|\.gguf$)/.test(base)) return true;
  // MTP / draft / speculative (modelos auxiliares pequeños, p. ej. carpeta MTP/ de unsloth).
  if (/(?:^|[/._-])mtp(?:[/._-]|\.gguf$)/.test(full)) return true;
  if (/(?:^|[._-])(draft|speculative)(?:[._-]|\.gguf$)/.test(base)) return true;
  return false;
}

/** ¿La cadena es EXACTAMENTE un token de cuantización? (Q4_K_M, IQ3_XS, F16…). */
function isQuantToken(s: string): boolean {
  return /^(?:IQ\d+(?:_[A-Z0-9]+)*|Q\d+(?:_[A-Z0-9]+)*|BF16|FP16|F16|F32)$/i.test(s);
}

/**
 * Nº de tokens de cuantización LIMPIOS en el nombre. Ollama separa por `-`/`.` (NO por `_`, que va
 * dentro de los quants tipo Q4_K_M), así que un quant "pegado" (`..._q4_0-it.gguf`) no cuenta.
 */
export function quantTokenCount(filePath: string): number {
  const base = (filePath.split('/').pop() || filePath).replace(/\.gguf$/i, '');
  return base.split(/[-.]/).filter(isQuantToken).length;
}

/**
 * ¿Ollama resolverá el tag `:{quant}` de este fichero? Ollama extrae el quant de los tokens
 * delimitados por `-`/`.`; falla si va pegado (`..._q4_0-it.gguf`) o si hay varios/ninguno
 * → "tag not available" (400). En esos casos hay que descargar el .gguf e importar a mano.
 */
export function isOllamaPullable(filePath: string): boolean {
  return quantTokenCount(filePath) === 1;
}

/** Extrae el nivel de cuantización del nombre de un fichero .gguf (Q4_K_M, IQ3_XS, F16, BF16…). */
export function parseQuant(filename: string): string {
  const base = filename.split('/').pop() || filename;
  const m = base.match(/(?:^|[._-])(IQ\d+(?:_[A-Z0-9]+)*|Q\d+(?:_[A-Z0-9]+)*|BF16|F16|F32|FP16)(?=[._-]|\.gguf$)/i);
  return m ? m[1].toUpperCase() : 'GGUF';
}

/** Referencia para `ollama pull` desde HF: hf.co/{id}:{quant}. */
export function hfPullRef(id: string, quant: string): string {
  return `hf.co/${id}:${quant}`;
}

/** Nº de parámetros deducido del nombre del repo (12B, 4B, 8x7B, 700M…), o '' si no se ve. */
export function parseParamCount(id: string): string {
  const s = (id.split('/').pop() || id);
  const moe = s.match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*b\b/i);
  if (moe) return `${moe[1]}x${moe[2]}B`;
  const b = s.match(/(\d+(?:\.\d+)?)\s*b\b/i);
  if (b) return `${b[1].replace(/\.0$/, '')}B`;
  const m = s.match(/(\d+(?:\.\d+)?)\s*m\b/i);
  if (m) return `${m[1].replace(/\.0$/, '')}M`;
  return '';
}

/** Formatea un total de parámetros (de safetensors.total) a 4B / 12.2B / 700M. */
export function formatParams(total: number): string {
  if (!total || total <= 0) return '';
  const b = total / 1e9;
  if (b >= 10) return Math.round(b) + 'B';
  if (b >= 1) return (Math.round(b * 10) / 10).toString().replace(/\.0$/, '') + 'B';
  return Math.round(total / 1e6) + 'M';
}

/** Dominio del modelo a partir del pipeline_tag/capacidades (LLM / VLM / Embeddings / ASR / TTS). */
export function domainFromPipeline(pipeline: string, caps?: { vision?: boolean }): string {
  const p = (pipeline || '').toLowerCase();
  if (caps?.vision || p === 'image-text-to-text' || p === 'any-to-any' || p === 'image-to-text') return 'VLM';
  if (p === 'feature-extraction' || p === 'sentence-similarity') return 'Embeddings';
  if (p === 'automatic-speech-recognition') return 'ASR';
  if (p === 'text-to-speech') return 'TTS';
  return 'LLM';
}

// Organizaciones "oficiales" (publishers verificados), con su id real de HF (case-sensitive).
// HF no expone el check por API; lista curada. Sirve para el badge ✓ y para el filtro de proveedor.
export const OFFICIAL_ORG_NAMES = [
  '01-ai', 'ai21labs', 'allenai', 'apple', 'bigcode', 'CohereLabs', 'databricks', 'deepseek-ai',
  'facebook', 'google', 'HuggingFaceH4', 'ibm-granite', 'internlm', 'LiquidAI', 'meta-llama',
  'microsoft', 'mistralai', 'moonshotai', 'nvidia', 'openai', 'openbmb', 'Qwen', 'Snowflake',
  'stabilityai', 'THUDM', 'tiiuae', 'upstage', 'xai-org', 'zai-org',
];
const OFFICIAL_ORGS = new Set(OFFICIAL_ORG_NAMES.map((n) => n.toLowerCase()));

/** ¿El autor es una organización oficial conocida? (case-insensitive). */
export function isOfficialOrg(author: string): boolean {
  return OFFICIAL_ORGS.has((author || '').toLowerCase());
}
