/**
 * Chat-zoom math (pure). Lives in `src/shared/` so it has a single source of truth for BOTH the host
 * unit test (`node:test`, compiled to `out/`) and the webview (esbuild bundles it into the chat graph
 * via `src/webview/chat/composer`). No DOM/VS Code dependency.
 */
export const ZOOM_MIN = 0.6;
export const ZOOM_MAX = 2.5;
export const ZOOM_STEP = 0.1;

/** Clamps and rounds to 2 decimals (avoids float drift like 1.0000000002 from additions). */
export function clampZoom(z: number): number {
  if (typeof z !== 'number' || !isFinite(z)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
}

/** Next level by wheel direction: deltaY<0 (up) zooms in. */
export function stepZoom(z: number, deltaY: number): number {
  return clampZoom(z + (deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
}
