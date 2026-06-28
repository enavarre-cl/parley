import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ChatDoc } from './chatDocument';
import { tr } from './i18n';

/** Resolves the effective system prompt (file or inline) with a path allow-list. One dep: the doc. */
export function makeSystemPrompt(document: vscode.TextDocument) {
    const sysPromptRoots = (): string[] => [
      path.dirname(document.uri.fsPath),
      ...(vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath),
    ];
    const sysPromptPathAllowed = (resolved: string): boolean =>
      sysPromptRoots().some((root) => resolved === root || resolved.startsWith(root + path.sep));

    let sysPromptWarned = ''; // debounce: warn once per failing-file set, not on every send

    // Assembles the EFFECTIVE system prompt: the inline base (if any) followed by every enabled .md
    // layer, in order, joined by a blank line. No side effects. `failures` lists the layers that
    // couldn't be read (missing, empty, or outside the workspace) so the caller can warn.
    const readSystemPrompt = (doc: ChatDoc): { text: string; failures: string[] } => {
      const dir = path.dirname(document.uri.fsPath);
      const segments: string[] = [];
      const failures: string[] = [];
      const base = doc.systemPrompt || '';
      if (base.trim()) segments.push(base);
      for (const part of doc.systemPromptFiles ?? []) {
        if (!part || typeof part.path !== 'string' || part.enabled === false) continue;
        const resolved = path.resolve(dir, part.path);
        if (!sysPromptPathAllowed(resolved)) { failures.push(part.path); continue; }
        try {
          const text = fs.readFileSync(resolved, 'utf8');
          if (text.trim()) segments.push(text);
          else failures.push(part.path);
        } catch { failures.push(part.path); }
      }
      return { text: segments.join('\n\n'), failures };
    };

    // Effective system prompt for sending; warns once (visibly) if any referenced layer couldn't be
    // used, instead of silently dropping it (which looks like the prompt is being ignored).
    const resolveSystemPrompt = (doc: ChatDoc): string => {
      const { text, failures } = readSystemPrompt(doc);
      const key = failures.join('\n');
      if (failures.length) {
        if (sysPromptWarned !== key) {
          sysPromptWarned = key;
          void vscode.window.showWarningMessage(
            `${tr('Some system-prompt files were skipped (missing, empty, or outside the workspace):')} ${failures.join(', ')}`
          );
        }
      } else {
        sysPromptWarned = '';
      }
      return text;
    };
  return { resolveSystemPrompt, readSystemPrompt, sysPromptPathAllowed };
}
