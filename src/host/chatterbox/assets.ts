/** Chatterbox engine (Resemble AI): pinned pip versions, model ids, and pure validators (timecode
 *  parsing, range validation, voice-id sanitization). No I/O and no vscode dependency, so the
 *  validators are unit-testable and reusable on both sides. */

// Pinned PyPI versions (fail-closed posture matches piper-tts: pip verifies hashes vs the index).
// Bump deliberately when reviewing releases.
export const CHATTERBOX_TTS_VERSION = '0.1.7';
export const IMAGEIO_FFMPEG_VERSION = '0.6.0';
// Apple Silicon fast path: a 4-bit multilingual Chatterbox running on Apple's MLX via `mlx-audio`
// (~4x faster than the torch path, no PyTorch). Used automatically on darwin/arm64.
export const MLX_AUDIO_VERSION = '0.4.4';
export const CHATTERBOX_MLX_MODEL = 'litmudoc/Chatterbox-Multilingual-MLX-v2-Q4';

// 'multilingual' = the 23-language model (default, so each voice's language works automatically);
// 'english' = the lighter English-only ChatterboxTTS. The server only branches on 'multilingual'.
export type ChatterboxModel = 'english' | 'multilingual';
export const CHATTERBOX_DEFAULT_MODEL: ChatterboxModel = 'multilingual';
export function isChatterboxModel(s: string): s is ChatterboxModel {
  return s === 'english' || s === 'multilingual';
}

// Languages the multilingual model speaks (Chatterbox `SUPPORTED_LANGUAGES`). Each cloned voice
// carries one, and synthesis uses it as `language_id` — no chat-level language config.
export const CHATTERBOX_LANGUAGES: Record<string, string> = {
  ar: 'Arabic', da: 'Danish', de: 'German', el: 'Greek', en: 'English', es: 'Spanish', fi: 'Finnish',
  fr: 'French', he: 'Hebrew', hi: 'Hindi', it: 'Italian', ja: 'Japanese', ko: 'Korean', ms: 'Malay',
  nl: 'Dutch', no: 'Norwegian', pl: 'Polish', pt: 'Portuguese', ru: 'Russian', sv: 'Swedish',
  sw: 'Swahili', tr: 'Turkish', zh: 'Chinese',
};
export function isChatterboxLanguage(s: string): boolean {
  return Object.prototype.hasOwnProperty.call(CHATTERBOX_LANGUAGES, s);
}

// Languages offered in the voice-creation dropdown: Jotflow's own UI languages (the model speaks
// all of CHATTERBOX_LANGUAGES, but the app only uses these six).
export const CHATTERBOX_UI_LANGS = ['en', 'es', 'pt', 'fr', 'de', 'it'] as const;

export type ChatterboxDevice = 'auto' | 'mps' | 'cuda' | 'cpu';
export const CHATTERBOX_DEFAULT_DEVICE: ChatterboxDevice = 'auto';

// Max length of a reference clip. Chatterbox clones well from ~5–15 s; longer adds no quality and
// bloats the stored clip.
export const REF_CLIP_MAX_SECONDS = 30;

/** Parses a timecode `ss`, `mm:ss` or `hh:mm:ss` into total seconds. Returns null if malformed. */
export function parseTimecode(s: string): number | null {
  const t = s.trim();
  if (!/^\d{1,3}(:\d{1,2}){0,2}$/.test(t)) return null;
  const parts = t.split(':').map((p) => parseInt(p, 10));
  if (parts.some((n) => Number.isNaN(n))) return null;
  // In mm:ss / hh:mm:ss forms a field above 59 is a typo (e.g. 1:70), not a carry.
  if (parts.length >= 2 && parts[parts.length - 1] > 59) return null;
  if (parts.length === 3 && parts[1] > 59) return null;
  return parts.reduce((sec, p) => sec * 60 + p, 0);
}

export interface RangeCheck { ok: boolean; start?: number; end?: number; error?: string }

/** Validates a [start,end] timecode range: both parse, start<end, and duration ≤ max. */
export function validateRange(startRaw: string, endRaw: string, maxSeconds = REF_CLIP_MAX_SECONDS): RangeCheck {
  const start = parseTimecode(startRaw);
  const end = parseTimecode(endRaw);
  if (start === null || end === null) return { ok: false, error: 'use mm:ss (e.g. 00:30)' };
  if (end <= start) return { ok: false, error: 'end must be after start' };
  if (end - start > maxSeconds) return { ok: false, error: `clip must be ≤ ${maxSeconds}s` };
  return { ok: true, start, end };
}

/** Turns a user-supplied voice name into a safe id (single path component): lowercase, letters/
 *  digits/dashes only — no '.', '/' or '\' so it can never traverse. Null if nothing usable. */
export function voiceId(name: string): string | null {
  const id = name.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return id || null;
}

/** Is `id` a safe stored-clip id (no path traversal)? Fully anchored, restricted charset. */
export function isSafeVoiceId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(id);
}
