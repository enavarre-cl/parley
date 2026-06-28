// Test-only stub for the `vscode` module. Several production modules (e.g. providers/index,
// spellWords, messageRouter) `import * as vscode`, which is unavailable outside the extension host.
// Importing this file FIRST registers a minimal in-memory mock so those modules can be required from
// node:test. `vscodeCalls` records the vscode-side calls the router makes directly (clipboard,
// executeCommand, fs…) so integration tests can assert on them; clear it between tests.
import Module from 'node:module';

interface LoaderModule { _load(request: string, parent: unknown, isMain: boolean): unknown }
const M = Module as unknown as LoaderModule;
const originalLoad = M._load.bind(M);

/** Names of the vscode APIs invoked since the last reset (see resetVscodeCalls). */
export const vscodeCalls: string[] = [];
export function resetVscodeCalls(): void { vscodeCalls.length = 0; }
const recAsync = (name: string) => async (..._args: unknown[]): Promise<undefined> => { vscodeCalls.push(name); return undefined; };

const stub: Record<string, unknown> = {
  EventEmitter: class { event = (): void => {}; fire = (): void => {}; dispose = (): void => {}; },
  Uri: {
    joinPath: (...parts: unknown[]) => ({ path: parts.join('/') }),
    file: (p: unknown) => ({ fsPath: String(p), path: String(p), toString: () => String(p) }),
  },
  Range: class { constructor(..._a: unknown[]) {} },
  WorkspaceEdit: class { replace(..._a: unknown[]): void {} },
  TextDocumentChangeReason: { Undo: 1, Redo: 2 },
  workspace: {
    fs: { writeFile: recAsync('fs.writeFile') },
    isTrusted: true,
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: (_k: string, d?: unknown) => d }),
  },
  window: {
    showWarningMessage: recAsync('window.showWarningMessage'),
    showInformationMessage: recAsync('window.showInformationMessage'),
    showSaveDialog: recAsync('window.showSaveDialog'),
    showOpenDialog: recAsync('window.showOpenDialog'),
  },
  commands: { executeCommand: recAsync('commands.executeCommand') },
  env: { language: 'en', clipboard: { writeText: recAsync('clipboard.writeText') }, openExternal: recAsync('env.openExternal') },
};

M._load = (request: string, parent: unknown, isMain: boolean): unknown => {
  if (request === 'vscode') return stub;
  return originalLoad(request, parent, isMain);
};
