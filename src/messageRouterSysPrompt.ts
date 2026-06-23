/** System-prompt message handlers (create/pick/open/clear the external .md), split from the router. */
import * as vscode from 'vscode';
import * as path from 'path';
import { tr } from './i18n';
import type { RouterCtx, WebviewMessage } from './messageRouter';

export async function routeSysPrompt(msg: WebviewMessage, ctx: RouterCtx): Promise<void> {
  switch (msg.type) {
    case 'createSysPrompt': {
      // Creates a .md file (with the current inline prompt) next to the .chat, references it and opens it.
      const doc = ctx.getDoc();
      if (!doc) break;
      const dir = vscode.Uri.joinPath(ctx.document.uri, '..');
      const stem = path.basename(ctx.document.uri.fsPath).replace(/\.chat$/i, '') || 'system';
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(dir, `${stem}.md`),
        filters: { 'System prompt': ['md', 'sysprompt', 'txt'] },
        saveLabel: tr('Create .md'),
      });
      if (!target) break;
      await vscode.workspace.fs.writeFile(target, Buffer.from(doc.systemPrompt || '', 'utf8'));
      doc.systemPromptFile = path.relative(dir.fsPath, target.fsPath);
      await ctx.writeDoc(doc);
      ctx.pushDoc();
      await vscode.commands.executeCommand('vscode.open', target);
      break;
    }
    case 'pickSysPrompt': {
      const doc = ctx.getDoc();
      if (!doc) break;
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { 'System prompt': ['md', 'sysprompt', 'txt'] },
        openLabel: tr('Use as system prompt'),
      });
      if (!picked || !picked[0]) break;
      const dir = vscode.Uri.joinPath(ctx.document.uri, '..');
      doc.systemPromptFile = path.relative(dir.fsPath, picked[0].fsPath);
      await ctx.writeDoc(doc);
      ctx.pushDoc();
      // Warn at pick time if it lives outside the workspace: it would be ignored at send time.
      if (!ctx.sysPromptPathAllowed(picked[0].fsPath)) {
        void vscode.window.showWarningMessage(
          tr('This file is outside the workspace, so it will not be used as the system prompt. Move it inside the project folder.')
        );
      }
      break;
    }
    case 'openSysPrompt': {
      const doc = ctx.getDoc();
      if (!doc || !doc.systemPromptFile) break;
      // Same allow-list as ctx.resolveSystemPrompt (.chat folder + workspace): a manually edited
      // systemPromptFile cannot open files outside (e.g. ../../etc/passwd).
      const resolved = path.resolve(path.dirname(ctx.document.uri.fsPath), doc.systemPromptFile);
      if (!ctx.sysPromptPathAllowed(resolved)) break;
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(resolved));
      break;
    }
    case 'clearSysPrompt': {
      const doc = ctx.getDoc();
      if (!doc) break;
      doc.systemPromptFile = undefined;
      await ctx.writeDoc(doc);
      ctx.pushDoc();
      break;
    }
  }
}
