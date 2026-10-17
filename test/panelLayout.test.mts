import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONFIG_MIN_PX,
  INPUT_MIN_PX,
  clampInputHeight,
  configHeightAfterDrag,
  inputHeightAfterDrag,
  normalizePanelLayout,
} from '../src/sidepanel/panelLayout.ts';

test('dragging the chat/input handle up grows the input, within limits', () => {
  assert.equal(inputHeightAfterDrag(60, 500, 400, 1000), 160);
  assert.equal(inputHeightAfterDrag(60, 500, 600, 1000), INPUT_MIN_PX);
  assert.equal(inputHeightAfterDrag(60, 900, 0, 1000), 600, 'max is 60% of the panel');
});

test('dragging the top handle down grows the top section, within limits', () => {
  assert.equal(configHeightAfterDrag(200, 300, 350, 1000), 250);
  assert.equal(configHeightAfterDrag(200, 300, 0, 1000), CONFIG_MIN_PX);
  assert.equal(configHeightAfterDrag(200, 0, 2000, 1000), 750);
});

test('stored layout is validated', () => {
  assert.deepEqual(normalizePanelLayout(undefined), {});
  assert.deepEqual(normalizePanelLayout([1]), {});
  assert.deepEqual(normalizePanelLayout({ inputHeight: 120.4, configHeight: 'x' }), { inputHeight: 120 });
  assert.deepEqual(normalizePanelLayout({ inputHeight: -5, configHeight: 300 }), { configHeight: 300 });
  assert.equal(clampInputHeight(Number.NaN, 800), INPUT_MIN_PX);
});
