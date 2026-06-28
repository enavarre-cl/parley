// Single VS Code webview API handle, acquired once and shared by every module.
// (acquireVsCodeApi may only be called once per webview.)
export const vscode = acquireVsCodeApi();
