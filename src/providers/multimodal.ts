import { Attachment, ChatMessage } from './types';

/** Image attachments of a message. */
export function imageAttachments(m: ChatMessage): Attachment[] {
  return (m.attachments ?? []).filter((a) => a.kind === 'image');
}

/** Document attachments (PDF, etc.) of a message. */
export function documentAttachments(m: ChatMessage): Attachment[] {
  return (m.attachments ?? []).filter((a) => a.kind === 'document');
}

/** data URL for an image (OpenAI/Gemini format in image_url). */
export function dataUrl(a: Attachment): string {
  return `data:${a.mime};base64,${a.data}`;
}

/**
 * Does this model OUTPUT images (e.g. Gemini "nano-banana" / *-flash-image)? Such models need the
 * image modality requested and return image parts. Detected by id since neither API exposes it at
 * call time; a false positive just yields a clear API error (the modality is rejected).
 */
export function isImageOutputModel(model: string): boolean {
  // Match image-GENERATION ids, not any id containing "image" (which also hit vision / image-INPUT
  // models like `gpt-4o-image-input`, wrongly stripping their tools). Covers `nano-banana`,
  // `*-flash-image`, `*-image-generation`/`-preview`, and ids ending in `-image`.
  return /nano-?banana|flash[-_]image|image[-_](generation|preview)|[-_]image$/i.test(model || '');
}

/** Parses a base64 data URL ("data:image/png;base64,XXXX") into {mime,data}, or null. */
export function parseDataUrl(url: string): { mime: string; data: string } | null {
  const m = typeof url === 'string' && url.match(/^data:([^;,]+);base64,(.+)$/);
  return m ? { mime: m[1], data: m[2] } : null;
}
