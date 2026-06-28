import * as vscode from 'vscode';
import * as path from 'path';
import { parseDoc } from './chatDocument';
import { chatDefaults, ChatMessage } from './providers';
import { makeNonce } from './chatHelpers';
import { tr } from './i18n';

/**
 * Compares versions of a .chat as TWO columns of rendered chat (past | current).
 * Triggered from the context menu of a Timeline item (Local History) or from the command palette.
 *
 * Note: the argument passed by `timeline/item/context` for Local History is poorly documented;
 * URI extraction is defensive (tries several forms) and falls back to a file picker.
 */

/** Reads and parses a .chat from a URI (tolerates content-provider schemes such as Local History). */
async function readChat(uri: vscode.Uri): Promise<{ title: string; messages: ChatMessage[] } | null> {
  try {
    const docu = await vscode.workspace.openTextDocument(uri);
    const doc = parseDoc(docu.getText(), chatDefaults());
    return { title: doc.title, messages: doc.messages.filter((m) => m.role !== 'system') };
  } catch {
    return null;
  }
}

/** The URI component shape vscode.Uri.from accepts (vscode has no exported UriComponents type). */
interface UriParts { scheme: string; authority?: string; path: string; query?: string; fragment?: string }
/** A Timeline item argument is opaque/poorly documented; this is the subset we probe. */
interface TimelineArg { command?: { arguments?: unknown[] }; uri?: UriParts }

/** Collects candidate URIs hidden inside the Timeline item argument. */
function collectUris(arg: unknown): vscode.Uri[] {
  const out: vscode.Uri[] = [];
  const add = (v: unknown) => {
    if (!v) return;
    if (v instanceof vscode.Uri) { out.push(v); return; }
    const o = v as Partial<UriParts>;
    if (typeof v === 'object' && typeof o.scheme === 'string' && typeof o.path === 'string') {
      try { out.push(vscode.Uri.from(o as UriParts)); } catch { /* not a valid URI */ }
    }
  };
  const a = arg as TimelineArg | undefined;
  if (a?.command?.arguments && Array.isArray(a.command.arguments)) a.command.arguments.forEach(add);
  add(a?.uri);
  add(arg);
  return out;
}

export function registerCompare(context: vscode.ExtensionContext): void {
  const cmd = vscode.commands.registerCommand('jotflow.compareVersion', async (arg: unknown) => {
    // 1) Resolve the "past" and "current" versions.
    let pastUri: vscode.Uri | undefined;
    let currentUri: vscode.Uri | undefined;

    const uris = collectUris(arg);
    const active = vscode.window.activeTextEditor?.document.uri
      ?? vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    const activeUri = active instanceof vscode.Uri ? active : (active as { uri?: vscode.Uri } | undefined)?.uri;

    if (uris.length >= 2) {
      // The Timeline diff command is typically vscode.diff(original, modified).
      pastUri = uris[0];
      currentUri = uris[1];
    } else if (uris.length === 1) {
      pastUri = uris[0];
      currentUri = activeUri;
    }

    // 2) If there is no past version, offer a file picker (guaranteed path).
    if (!pastUri) {
      const picked = await vscode.window.showOpenDialog({
        title: tr('Pick a .chat version to compare'),
        filters: { 'Jotflow': ['chat'] },
        canSelectMany: false,
      });
      if (!picked || !picked.length) return;
      pastUri = picked[0];
      currentUri = currentUri ?? activeUri;
    }
    if (!currentUri) currentUri = activeUri;
    if (!currentUri) {
      vscode.window.showErrorMessage(tr('Open the .chat first to compare it.'));
      return;
    }

    const past = await readChat(pastUri);
    const current = await readChat(currentUri);
    if (!past || !current) {
      vscode.window.showErrorMessage(tr('Could not read one of the .chat versions.'));
      return;
    }

    // 3) Open the two-column webview.
    const name = path.basename(currentUri.fsPath);
    const panel = vscode.window.createWebviewPanel(
      'jotflow.compare',
      tr('Compare: ') + name,
      vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] }
    );
    const media = (f: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', f));
    const nonce = makeNonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${panel.webview.cspSource} data: blob:`,
      `style-src ${panel.webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    panel.webview.html = `<!DOCTYPE html>
<html lang="${vscode.env.language.startsWith('es') ? 'es' : 'en'}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link href="${media('compare.css')}" rel="stylesheet" />
  <title>${tr('Compare')}</title>
</head>
<body>
  <div id="cols">
    <section class="col"><header id="pastLabel"></header><div id="pastBody" class="msgs"></div></section>
    <section class="col"><header id="curLabel"></header><div id="curBody" class="msgs"></div></section>
  </div>
  <script nonce="${nonce}" src="${media('dist/compare.js')}"></script>
</body>
</html>`;

    panel.webview.onDidReceiveMessage((m) => {
      if (m?.type === 'ready') {
        panel.webview.postMessage({
          type: 'render',
          past: { label: tr('Past version'), ...past },
          current: { label: tr('Current version'), ...current },
        });
      }
    });

    context.subscriptions.push(panel);
  });
  context.subscriptions.push(cmd);
}
