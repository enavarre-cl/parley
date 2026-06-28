/** Management of Chatterbox reference-voice clips (WAV samples in globalStorage/chatterbox-voices).
 *  Each voice = `<id>.wav` (the reference audio for cloning) + `<id>.json` (label + origin). */
import * as fs from 'fs';
import * as path from 'path';

export interface ChatterboxVoice { id: string; label: string; sizeBytes: number; source?: string; language?: string }
export interface VoiceMeta { label?: string; source?: string; language?: string }

function readMeta(jsonPath: string): VoiceMeta {
  try {
    const m = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    return m && typeof m === 'object' && !Array.isArray(m) ? m as VoiceMeta : {};
  } catch { return {}; }
}

/** Lists reference clips (each `<id>.wav`), with their label and size. */
export function listChatterboxVoices(dir: string): ChatterboxVoice[] {
  let files: string[];
  try { files = fs.readdirSync(dir); } catch { return []; }
  return files
    .filter((f) => f.endsWith('.wav'))
    .map((f) => {
      const id = f.slice(0, -'.wav'.length);
      let sizeBytes = 0;
      try { sizeBytes = fs.statSync(path.join(dir, f)).size; } catch { /* nothing */ }
      const meta = readMeta(path.join(dir, id + '.json'));
      return { id, label: meta.label || id, sizeBytes, source: meta.source, language: meta.language };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** The language tag of a stored voice (e.g. 'es'), or undefined if not set. */
export function chatterboxVoiceLanguage(dir: string, id: string): string | undefined {
  return readMeta(path.join(dir, id + '.json')).language;
}

/** Writes the metadata sidecar for a clip (best-effort). */
export function writeChatterboxVoiceMeta(dir: string, id: string, meta: VoiceMeta): void {
  try { fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(meta, null, 2)); } catch { /* best-effort */ }
}

/** Deletes a clip: its `.wav` and the `.json` sidecar. */
export function removeChatterboxVoice(dir: string, id: string): void {
  for (const ext of ['.wav', '.json']) {
    try { fs.unlinkSync(path.join(dir, id + ext)); } catch { /* does not exist */ }
  }
}

/** Path of a clip's WAV (whether or not it exists). */
export function chatterboxVoicePath(dir: string, id: string): string {
  return path.join(dir, id + '.wav');
}
