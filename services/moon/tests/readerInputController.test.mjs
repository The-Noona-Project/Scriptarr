/**
 * @file Unit tests for the reader input controller.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  READER_INPUT_ACTIONS,
  createReaderInputState,
  resolveGamepadActions,
  resolveKeyboardAction,
  resolvePointerSwipe
} from "../apps/reader-next/lib/inputController.js";

const makePad = ({buttons = [], axes = [0, 0]} = {}) => ({
  axes,
  buttons: Array.from({length: 16}, (_value, index) => ({
    pressed: buttons.includes(index)
  }))
});

test("reader keyboard maps reading controls without taking text input", () => {
  assert.equal(resolveKeyboardAction({key: "ArrowRight"}), READER_INPUT_ACTIONS.NEXT);
  assert.equal(resolveKeyboardAction({key: "PageUp"}), READER_INPUT_ACTIONS.PREVIOUS);
  assert.equal(resolveKeyboardAction({key: "s"}), READER_INPUT_ACTIONS.TOGGLE_SETTINGS);
  assert.equal(resolveKeyboardAction({key: "f"}), READER_INPUT_ACTIONS.FULLSCREEN);
  assert.equal(resolveKeyboardAction({key: "b"}), READER_INPUT_ACTIONS.BOOKMARK);
  assert.equal(resolveKeyboardAction({key: "Escape"}), READER_INPUT_ACTIONS.CLOSE_SETTINGS);
  assert.equal(resolveKeyboardAction({key: "ArrowRight", defaultPrevented: true}), "");
});

test("reader pointer swipes require a horizontal gesture", () => {
  assert.equal(resolvePointerSwipe({x: 120, y: 20}, {x: 20, y: 24}), READER_INPUT_ACTIONS.NEXT);
  assert.equal(resolvePointerSwipe({x: 20, y: 20}, {x: 120, y: 24}), READER_INPUT_ACTIONS.PREVIOUS);
  assert.equal(resolvePointerSwipe({x: 20, y: 20}, {x: 32, y: 140}), "");
});

test("reader gamepad default mapping covers console navigation buttons", () => {
  const state = createReaderInputState();

  assert.deepEqual(resolveGamepadActions([makePad({buttons: [15]})], state, {now: 1000}), [READER_INPUT_ACTIONS.NEXT]);
  assert.deepEqual(resolveGamepadActions([makePad({buttons: [15]})], state, {now: 1100}), []);
  assert.deepEqual(resolveGamepadActions([makePad({buttons: [15]})], state, {now: 1300}), [READER_INPUT_ACTIONS.NEXT]);
  assert.deepEqual(resolveGamepadActions([makePad({buttons: [4]})], state, {now: 1700}), [READER_INPUT_ACTIONS.PREVIOUS]);
  assert.deepEqual(resolveGamepadActions([makePad({buttons: [0]})], state, {now: 2100}), [READER_INPUT_ACTIONS.NEXT]);
  assert.deepEqual(resolveGamepadActions([makePad({axes: [0.7, 0]})], state, {now: 2500}), [READER_INPUT_ACTIONS.NEXT]);
  assert.deepEqual(resolveGamepadActions([makePad({axes: [-0.7, 0]})], state, {now: 2900}), [READER_INPUT_ACTIONS.PREVIOUS]);
});

test("reader gamepad settings mode suppresses page flips and scrolls the drawer", () => {
  const state = createReaderInputState();

  assert.deepEqual(
    resolveGamepadActions([makePad({buttons: [13]})], state, {now: 1000, settingsOpen: true}),
    [READER_INPUT_ACTIONS.SETTINGS_SCROLL_DOWN]
  );
  assert.deepEqual(
    resolveGamepadActions([makePad({buttons: [12]})], state, {now: 1400, settingsOpen: true}),
    [READER_INPUT_ACTIONS.SETTINGS_SCROLL_UP]
  );
  assert.deepEqual(
    resolveGamepadActions([makePad({buttons: [1]})], state, {now: 1800, settingsOpen: true}),
    [READER_INPUT_ACTIONS.CLOSE_SETTINGS]
  );
});

test("reader gamepad resets cleanly when disconnected or hidden", () => {
  const state = createReaderInputState();

  assert.deepEqual(resolveGamepadActions([makePad({buttons: [15]})], state, {now: 1000}), [READER_INPUT_ACTIONS.NEXT]);
  assert.equal(state.connected, true);
  assert.deepEqual(resolveGamepadActions([], state, {now: 1400}), []);
  assert.equal(state.connected, false);

  assert.deepEqual(resolveGamepadActions([makePad({buttons: [15]})], state, {now: 1800}), [READER_INPUT_ACTIONS.NEXT]);
  assert.deepEqual(resolveGamepadActions([makePad({buttons: [15]})], state, {now: 2200, documentHidden: true}), []);
  assert.equal(state.connected, false);
});
