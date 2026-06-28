/** Pure helpers for the model subsystem (no VS Code or network, testable). */
import type { ModelCapabilities } from './registry';

/** Formats bytes into a human-readable unit (GB/MB). */
export function formatBytes(n: number): string {
  if (!n || n < 0) return '—';
  const gb = n / 1073741824;
  if (gb >= 1) return gb.toFixed(2) + ' GB';
  return (n / 1048576).toFixed(0) + ' MB';
}

/**
 * Capabilities estimated from tags/pipeline/name + model family knowledge.
 * HF tags are sparse (official orgs don't label reasoning/tools), so we add
 * family knowledge (gemma-4, qwen3, llama-4…). Exact truth arrives from /api/show after download.
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
 * Detects auxiliary .gguf files (NOT the main downloadable model):
 * vision projectors (mmproj) and speculative decoding draft models (MTP/draft).
 */
export function isAuxiliaryGguf(filePath: string): boolean {
  const full = filePath.toLowerCase();
  const base = (filePath.split('/').pop() || filePath).toLowerCase();
  // Vision projector.
  if (/(?:^|[._-])(mmproj|mproj|projector|clip|vision[._-]?adapter)(?:[._-]|\.gguf$)/.test(base)) return true;
  // MTP / draft / speculative (small auxiliary models, e.g. unsloth's MTP/ folder).
  if (/(?:^|[/._-])mtp(?:[/._-]|\.gguf$)/.test(full)) return true;
  if (/(?:^|[._-])(draft|speculative)(?:[._-]|\.gguf$)/.test(base)) return true;
  return false;
}

/** Is the string EXACTLY a quantisation token? (Q4_K_M, IQ3_XS, F16…). */
function isQuantToken(s: string): boolean {
  return /^(?:IQ\d+(?:_[A-Z0-9]+)*|Q\d+(?:_[A-Z0-9]+)*|BF16|FP16|F16|F32)$/i.test(s);
}

/**
 * Number of CLEAN quantisation tokens in the name. Ollama splits on `-`/`.` (NOT on `_`, which is
 * used inside quants like Q4_K_M), so a "glued" quant (`..._q4_0-it.gguf`) does not count.
 */
export function quantTokenCount(filePath: string): number {
  const base = (filePath.split('/').pop() || filePath).replace(/\.gguf$/i, '');
  return base.split(/[-.]/).filter(isQuantToken).length;
}

/**
 * Will Ollama resolve the `:{quant}` tag for this file? Ollama extracts the quant from tokens
 * delimited by `-`/`.`; it fails if glued (`..._q4_0-it.gguf`) or if there are several/none
 * → "tag not available" (400). In those cases the .gguf must be downloaded and imported manually.
 */
export function isOllamaPullable(filePath: string): boolean {
  return quantTokenCount(filePath) === 1;
}

/**
 * Parses a split/sharded GGUF path into its group base + position, or null if it is not a shard.
 * Big models are published in parts named `…-00001-of-00003.gguf`; all parts share one base and
 * must be downloaded together and all referenced when importing. The base keeps the directory so
 * shards in a subfolder group correctly.
 *   "Qwen3-235B-Q4_K_M-00001-of-00003.gguf" → { base: "Qwen3-235B-Q4_K_M", index: 1, total: 3 }
 */
export function shardInfo(filePath: string): { base: string; index: number; total: number } | null {
  const m = filePath.match(/^(.*)-(\d{4,5})-of-(\d{4,5})\.gguf$/i);
  if (!m) return null;
  const index = parseInt(m[2], 10);
  const total = parseInt(m[3], 10);
  if (total < 2 || index < 1 || index > total) return null; // malformed → treat as standalone
  return { base: m[1], index, total };
}

/** Extracts the quantisation level from a .gguf filename (Q4_K_M, IQ3_XS, F16, BF16…). */
export function parseQuant(filename: string): string {
  const base = filename.split('/').pop() || filename;
  const m = base.match(/(?:^|[._-])(IQ\d+(?:_[A-Z0-9]+)*|Q\d+(?:_[A-Z0-9]+)*|BF16|F16|F32|FP16)(?=[._-]|\.gguf$)/i);
  return m ? m[1].toUpperCase() : 'GGUF';
}

/** Reference for `ollama pull` from HF: hf.co/{id}:{quant}. */
export function hfPullRef(id: string, quant: string): string {
  return `hf.co/${id}:${quant}`;
}

/** Parameter count inferred from the repo name (12B, 4B, 8x7B, 700M…), or '' if not found. */
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

/** Formats a total parameter count (from safetensors.total) as 4B / 12.2B / 700M. */
export function formatParams(total: number): string {
  if (!total || total <= 0) return '';
  const b = total / 1e9;
  if (b >= 10) return Math.round(b) + 'B';
  if (b >= 1) return (Math.round(b * 10) / 10).toString().replace(/\.0$/, '') + 'B';
  return Math.round(total / 1e6) + 'M';
}

/** Model domain from pipeline_tag/capabilities (LLM / VLM / Embeddings / ASR / TTS). */
export function domainFromPipeline(pipeline: string, caps?: { vision?: boolean }): string {
  const p = (pipeline || '').toLowerCase();
  if (caps?.vision || p === 'image-text-to-text' || p === 'any-to-any' || p === 'image-to-text') return 'VLM';
  if (p === 'feature-extraction' || p === 'sentence-similarity') return 'Embeddings';
  if (p === 'automatic-speech-recognition') return 'ASR';
  if (p === 'text-to-speech') return 'TTS';
  return 'LLM';
}

// "Official" organisations (verified publishers), with their real HF id (case-sensitive).
// HF does not expose this check via API; curated list. Used for the ✓ badge and provider filter.
export const OFFICIAL_ORG_NAMES = [
  '01-ai', 'ai21labs', 'allenai', 'apple', 'bigcode', 'CohereLabs', 'databricks', 'deepseek-ai',
  'facebook', 'google', 'HuggingFaceH4', 'ibm-granite', 'internlm', 'LiquidAI', 'meta-llama',
  'microsoft', 'mistralai', 'moonshotai', 'nvidia', 'openai', 'openbmb', 'Qwen', 'Snowflake',
  'stabilityai', 'THUDM', 'tiiuae', 'upstage', 'xai-org', 'zai-org',
];
const OFFICIAL_ORGS = new Set(OFFICIAL_ORG_NAMES.map((n) => n.toLowerCase()));

/** Is the author a known official organisation? (case-insensitive). */
export function isOfficialOrg(author: string): boolean {
  return OFFICIAL_ORGS.has((author || '').toLowerCase());
}
