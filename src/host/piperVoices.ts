/** Management of downloaded Piper voices (.onnx models in globalStorage/piper-voices). */
import * as fs from 'fs';
import * as path from 'path';

export interface PiperVoice { id: string; sizeBytes: number; }

/** Lists downloaded voices (each `*.onnx`), with their size. */
export function listPiperVoices(dir: string): PiperVoice[] {
  let files: string[];
  try { files = fs.readdirSync(dir); } catch { return []; }
  return files
    .filter((f) => f.endsWith('.onnx'))
    .map((f) => {
      const id = f.slice(0, -'.onnx'.length);
      let sizeBytes = 0;
      try { sizeBytes = fs.statSync(path.join(dir, f)).size; } catch { /* nothing */ }
      return { id, sizeBytes };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Deletes a voice: its `.onnx` file and the accompanying `.onnx.json`. */
export function removePiperVoice(dir: string, id: string): void {
  for (const ext of ['.onnx', '.onnx.json']) {
    try { fs.unlinkSync(path.join(dir, id + ext)); } catch { /* does not exist */ }
  }
}
