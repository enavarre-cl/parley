import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ChatDoc } from './chatDocument';
import { Attachment } from './providers';

/**
 * Persists attachment blobs in a `<chat>.attach` sidecar; the `.chat` keeps only `{kind,name,mime,ref}`.
 * Single dependency: the `.chat` document URI. Cohesive (all blob lifecycle), low coupling.
 */
export class AttachmentStore {
  private cache: Record<string, Attachment> | null = null;
  private cacheMtime = -1;                 // mtimeMs the cache was loaded from; -1 = unknown/none
  private tmpSeq = 0;                       // makes each temp file name unique within this process
  private loadFailed = false;             // sidecar exists but couldn't be parsed → never clobber it
  private writeChain: Promise<void> = Promise.resolve(); // serialize sidecar writes

  constructor(private readonly docUri: vscode.Uri) {}

  private uri(): vscode.Uri {
    const stem = path.basename(this.docUri.fsPath).replace(/\.chat$/i, '');
    return vscode.Uri.joinPath(this.docUri, '..', stem + '.attach');
  }

  load(): Record<string, Attachment> {
    const p = this.uri().fsPath;
    let mtime = -1;
    try { mtime = fs.statSync(p).mtimeMs; } catch { mtime = -1; }
    // Serve the cache only while the file on disk hasn't changed since we read it. Another window
    // editing the same .chat rewrites the sidecar; without this we'd keep serving stale blobs.
    if (this.cache && mtime === this.cacheMtime) return this.cache;
    let raw: string;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch (e) {
      this.cache = {};
      this.cacheMtime = mtime;
      this.loadFailed = (e as NodeJS.ErrnoException)?.code !== 'ENOENT'; // ENOENT = no sidecar yet (safe to create fresh)
      return this.cache;
    }
    try {
      this.cache = JSON.parse(raw);
      this.loadFailed = false;
    } catch {
      this.cache = {};
      this.loadFailed = true; // existing-but-corrupt (e.g. a half-written read): don't overwrite it
    }
    this.cacheMtime = mtime;
    return this.cache!;
  }

  // Atomic write (temp file + rename) so a concurrent reader never sees a half-written sidecar and
  // resets it to {} (which a later save/prune would then persist, losing every blob). Serialized.
  private writeSidecar(store: Record<string, Attachment>): Promise<void> {
    const run = this.writeChain.then(async () => {
      const main = this.uri();
      // Per-process unique temp name: a fixed `.tmp` would collide if the same .chat is open in two
      // windows, with one rename clobbering the other's half-written file.
      const tmp = main.with({ path: `${main.path}.${process.pid}.${this.tmpSeq++}.tmp` });
      await vscode.workspace.fs.writeFile(tmp, Buffer.from(JSON.stringify(store) + '\n', 'utf8'));
      await vscode.workspace.fs.rename(tmp, main, { overwrite: true });
      // Adopt the mtime we just wrote so load() doesn't needlessly re-read our own write.
      try { this.cacheMtime = fs.statSync(main.fsPath).mtimeMs; } catch { /* stat may fail; load() re-reads */ }
    });
    this.writeChain = run.catch(() => {}); // keep the chain alive even if one write fails
    return run;
  }

  private async save(store: Record<string, Attachment>): Promise<void> {
    this.cache = store;
    this.loadFailed = false; // we now hold an authoritative store
    await this.writeSidecar(store);
  }

  /** Saves new blobs and returns attachments with only {kind,name,mime,ref,bytes}. */
  async store(atts: Attachment[]): Promise<Attachment[]> {
    if (!atts.length) return [];
    const store = this.load();
    const refs: Attachment[] = [];
    for (const a of atts) {
      const id = `att_${crypto.randomUUID()}`; // collision-free (Date.now()+random collided in a sync loop)
      const bytes = typeof a.data === 'string' ? a.data.length : 0;
      store[id] = { kind: a.kind, name: a.name, mime: a.mime, data: a.data, bytes };
      refs.push({ kind: a.kind, name: a.name, mime: a.mime, ref: id, bytes }); // bytes → token budgeting
    }
    await this.save(store);
    return refs;
  }

  /** Stores images returned by an image-output model as image attachments. */
  async storeGenImages(images: { mime: string; data: string }[]): Promise<Attachment[]> {
    const ext = (mime: string) => (/jpeg|jpg/i.test(mime) ? 'jpg' : /webp/i.test(mime) ? 'webp' : /gif/i.test(mime) ? 'gif' : 'png');
    return this.store(images.map((im, i) => ({
      kind: 'image', name: `image-${i + 1}.${ext(im.mime)}`, mime: im.mime || 'image/png', data: im.data,
    })));
  }

  /** Returns an attachment with `data` resolved (from the sidecar if a ref, or legacy inline).
   *  Arrow property so it can be passed as `.map(store.resolve)` without losing `this`. */
  resolve = (a: Attachment): Attachment => {
    if (typeof a?.data === 'string') return a; // legacy inline
    if (a?.ref) {
      const e = this.load()[a.ref];
      if (e) return { kind: a.kind, name: a.name || e.name, mime: a.mime || e.mime, data: e.data };
    }
    return a;
  };

  /** Removes entries no longer referenced by any message (on delete/merge/fork). */
  async prune(doc: ChatDoc): Promise<void> {
    if (!this.cache) return;        // only if attachments have been/were loaded
    if (this.loadFailed) return;    // store unreadable: never delete from a set we couldn't read
    const used = new Set<string>();
    for (const m of doc.messages) {
      for (const a of (m.attachments ?? [])) if (a.ref) used.add(a.ref);
      for (const v of (m.variants ?? [])) for (const a of (v.attachments ?? [])) if (a.ref) used.add(a.ref);
    }
    let changed = false;
    for (const id of Object.keys(this.cache)) {
      if (!used.has(id)) { delete this.cache[id]; changed = true; }
    }
    if (!changed) return;
    if (Object.keys(this.cache).length === 0) {
      await this.writeChain.catch(() => {}); // let pending writes settle before deleting
      try { await vscode.workspace.fs.delete(this.uri()); } catch { /* no longer exists */ }
    } else {
      await this.writeSidecar(this.cache);
    }
  }
}
