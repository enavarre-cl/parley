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
    case 'createSysPrompt': {
      // Externalises the current inline base into a NEW .md layer: writes the base to the file, appends
      // it as a layer, clears the base (the text now lives in the file — no doubling) and opens it.
      const doc = ctx.getDoc();
      if (!doc) break;
      const stem = path.basename(ctx.document.uri.fsPath).replace(/\.chat$/i, '') || 'system';
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(dir, `${stem}.md`),
        filters: { 'System prompt': ['md', 'sysprompt', 'txt'] },
        saveLabel: tr('Create .md'),
      });
      if (!target) break;
      await vscode.workspace.fs.writeFile(target, Buffer.from(doc.systemPrompt || '', 'utf8'));
      doc.systemPromptFiles = [...(doc.systemPromptFiles ?? []), { path: path.relative(dir.fsPath, target.fsPath) }];
      doc.systemPrompt = '';
      await ctx.writeDoc(doc);
      ctx.pushDoc();
      await vscode.commands.executeCommand('vscode.open', target);
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
