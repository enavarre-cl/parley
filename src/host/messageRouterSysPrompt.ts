/** System-prompt layer handlers (add/create/open/remove/move/toggle the .md layers), split from the
 *  router. The effective prompt is the inline base + every enabled layer, assembled at send time. */
import * as vscode from 'vscode';
import * as path from 'path';
import { tr } from './i18n';
import type { SysPromptFile } from './chatDocument';
import type { RouterCtx, WebviewMessage } from './messageRouter';

/** Layer index from the message, valid against the current list length (or -1). */
function layerIndex(msg: WebviewMessage, len: number): number {
  const i = msg.index;
  return typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < len ? i : -1;
}

export async function routeSysPrompt(msg: WebviewMessage, ctx: RouterCtx): Promise<void> {
  const dir = vscode.Uri.joinPath(ctx.document.uri, '..');

  switch (msg.type) {
    case 'refreshSysPrompt': {
      // Re-syncs the layer list from the path/glob, additively: every layer already in the list is
      // kept in its current order (and enabled flag), and any matched file not yet present is appended
      // at the end. So refreshing with nothing removed leaves the list (and order) untouched, a
      // removed-but-still-matching file reappears last, and files added by hand (the [+] picker) are
      // never wiped. Removal stays manual (the row's ✕).
      const doc = ctx.getDoc();
      if (!doc) break;
      const pattern = typeof msg.glob === 'string' ? msg.glob : (doc.systemPromptGlob ?? '');
      doc.systemPromptGlob = pattern.trim() ? pattern : undefined;
      const matched = await ctx.resolveSysPromptGlob(pattern);
      const existing = doc.systemPromptFiles ?? [];
      const have = new Set(existing.map((l) => l.path));
      const appended = matched.filter((p) => !have.has(p)).map((p): SysPromptFile => ({ path: p }));
      const next = [...existing, ...appended];
      doc.systemPromptFiles = next.length ? next : undefined;
      await ctx.writeDoc(doc);
      ctx.pushDoc();
      break;
    }
    case 'pickSysPrompt': {
      // Adds one or more existing .md files as layers (appended, in pick order).
      const doc = ctx.getDoc();
      if (!doc) break;
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: true,
        filters: { 'System prompt': ['md', 'sysprompt', 'txt'] },
        openLabel: tr('Add as system-prompt layer'),
      });
      if (!picked || !picked.length) break;
      const layers = [...(doc.systemPromptFiles ?? [])];
      let anyOutside = false;
      for (const uri of picked) {
        if (!ctx.sysPromptPathAllowed(uri.fsPath)) anyOutside = true;
        layers.push({ path: path.relative(dir.fsPath, uri.fsPath) });
      }
      doc.systemPromptFiles = layers;
      await ctx.writeDoc(doc);
      ctx.pushDoc();
      // Warn at pick time if any layer lives outside the workspace: it is skipped at send time.
      if (anyOutside) {
        void vscode.window.showWarningMessage(
          tr('One or more files are outside the workspace, so they will be skipped. Move them inside the project folder.')
        );
      }
      break;
    }
    case 'openSysPrompt': {
      const doc = ctx.getDoc();
      if (!doc) break;
      const i = layerIndex(msg, doc.systemPromptFiles?.length ?? 0);
      if (i < 0) break;
      // Same allow-list as ctx.resolveSystemPrompt (.chat folder + workspace): a manually edited
      // layer path cannot open files outside (e.g. ../../etc/passwd).
      const resolved = path.resolve(path.dirname(ctx.document.uri.fsPath), doc.systemPromptFiles![i].path);
      if (!ctx.sysPromptPathAllowed(resolved)) break;
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(resolved));
      break;
    }
    case 'removeSysPrompt': {
      const doc = ctx.getDoc();
      if (!doc) break;
      const i = layerIndex(msg, doc.systemPromptFiles?.length ?? 0);
      if (i < 0) break;
      const layers = [...doc.systemPromptFiles!];
      layers.splice(i, 1);
      doc.systemPromptFiles = layers.length ? layers : undefined;
      await ctx.writeDoc(doc);
      ctx.pushDoc();
      break;
    }
    case 'moveSysPrompt': {
      const doc = ctx.getDoc();
      if (!doc) break;
      const len = doc.systemPromptFiles?.length ?? 0;
      const from = layerIndex(msg, len);
      const to = msg.to;
      if (from < 0 || typeof to !== 'number' || !Number.isInteger(to) || to < 0 || to >= len || to === from) break;
      const layers = [...doc.systemPromptFiles!];
      const [moved] = layers.splice(from, 1);
      layers.splice(to, 0, moved);
      doc.systemPromptFiles = layers;
      await ctx.writeDoc(doc);
      ctx.pushDoc();
      break;
    }
    case 'toggleSysPrompt': {
      const doc = ctx.getDoc();
      if (!doc) break;
      const i = layerIndex(msg, doc.systemPromptFiles?.length ?? 0);
      if (i < 0 || typeof msg.enabled !== 'boolean') break;
      const layers = doc.systemPromptFiles!.map((l, idx): SysPromptFile => {
        if (idx !== i) return l;
        // Default-on stays absent (clean JSON); only an explicit `false` is persisted.
        return msg.enabled ? { path: l.path } : { path: l.path, enabled: false };
      });
      doc.systemPromptFiles = layers;
      await ctx.writeDoc(doc);
      ctx.pushDoc();
      break;
    }
  }
}
