/** Parsing of a progress fraction from a tool's output line (pip, Hugging Face, the TTS daemon).
 *  Pure and testable; shared by the engines panel (Piper + Chatterbox) and the Chatterbox manager. */

/** Extracts a 0..1 fraction from a line: a literal `45%`, or an `a/b MB|GB` byte ratio. Undefined if
 *  the line carries no parseable progress (e.g. the model-load phase, which has no signal). */
export function parseProgressPct(line: string): number | undefined {
  const pc = line.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
  if (pc) { const v = parseFloat(pc[1]); if (v >= 0 && v <= 100) return v / 100; }
  const frac = line.match(/([\d.]+)\s*\/\s*([\d.]+)\s*(?:MB|GB|MiB|GiB|kB)/i);
  if (frac) { const a = parseFloat(frac[1]), b = parseFloat(frac[2]); if (b > 0 && a <= b) return a / b; }
  return undefined;
}
