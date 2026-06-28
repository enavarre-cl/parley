import { test } from 'node:test';
import assert from 'node:assert';
import { clampZoom, stepZoom, ZOOM_MIN, ZOOM_MAX, ZOOM_STEP } from '../../shared/zoomMath';

test('clampZoom respects the limits', () => {
  assert.strictEqual(clampZoom(5), ZOOM_MAX);
  assert.strictEqual(clampZoom(0.1), ZOOM_MIN);
  assert.strictEqual(clampZoom(1), 1);
});

test('clampZoom rounds to 2 decimals (no float drift)', () => {
  // 1 + 0.1 + 0.1 in float gives 1.2000000000000002 → should become 1.2
  assert.strictEqual(clampZoom(0.1 + 0.1 + 1), 1.2);
});

test('clampZoom returns 1 for non-numeric or non-finite values', () => {
  assert.strictEqual(clampZoom(NaN), 1);
  assert.strictEqual(clampZoom(Infinity), 1);
  assert.strictEqual(clampZoom('x' as unknown as number), 1); // intentionally invalid input: exercises the runtime guard
  assert.strictEqual(clampZoom(undefined as unknown as number), 1);
});

test('stepZoom zooms in with negative deltaY and out with positive', () => {
  assert.strictEqual(stepZoom(1, -1), 1 + ZOOM_STEP); // wheel up → zoom in
  assert.strictEqual(stepZoom(1, 1), 1 - ZOOM_STEP);  // wheel down → zoom out
});

test('stepZoom does not exceed the limits', () => {
  assert.strictEqual(stepZoom(ZOOM_MAX, -1), ZOOM_MAX); // already at maximum
  assert.strictEqual(stepZoom(ZOOM_MIN, 1), ZOOM_MIN);  // already at minimum
});

test('stepZoom is stable accumulating steps (no drift)', () => {
  let z = 1;
  for (let i = 0; i < 5; i++) z = stepZoom(z, -1); // 5 zoom-ins
  assert.strictEqual(z, 1.5);
  for (let i = 0; i < 5; i++) z = stepZoom(z, 1); // 5 zoom-outs
  assert.strictEqual(z, 1);
});
