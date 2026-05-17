"use client";

/**
 * @file Reader input controller helpers for keyboard, touch, and gamepad input.
 */

export const READER_INPUT_ACTIONS = Object.freeze({
  NEXT: "next",
  PREVIOUS: "previous",
  TOGGLE_SETTINGS: "toggleSettings",
  CLOSE_SETTINGS: "closeSettings",
  TOGGLE_CONTROLS: "toggleControls",
  BOOKMARK: "bookmark",
  FULLSCREEN: "fullscreen",
  SETTINGS_SCROLL_UP: "settingsScrollUp",
  SETTINGS_SCROLL_DOWN: "settingsScrollDown"
});

const BUTTONS = Object.freeze({
  A: 0,
  B: 1,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  BACK: 8,
  START: 9,
  DPAD_UP: 12,
  DPAD_DOWN: 13,
  DPAD_LEFT: 14,
  DPAD_RIGHT: 15
});

const EDGE_ACTION_BUTTONS = Object.freeze(new Map([
  [BUTTONS.START, READER_INPUT_ACTIONS.TOGGLE_SETTINGS],
  [BUTTONS.BACK, READER_INPUT_ACTIONS.TOGGLE_CONTROLS],
  [BUTTONS.Y, READER_INPUT_ACTIONS.BOOKMARK]
]));

const REPEAT_DELAY_MS = 260;
const EDGE_DELAY_MS = 360;
const ANALOG_DEAD_ZONE = 0.45;

/**
 * Create mutable controller state for repeat and edge-trigger handling.
 *
 * @returns {{lastActionAt: Record<string, number>, pressedButtons: Set<string>, connected: boolean}}
 */
export const createReaderInputState = () => ({
  lastActionAt: {},
  pressedButtons: new Set(),
  connected: false
});

const buttonPressed = (pad, index) => Boolean(pad?.buttons?.[index]?.pressed);
const axisValue = (pad, index) => Number.parseFloat(String(pad?.axes?.[index] || 0)) || 0;

const canRepeat = (state, action, now, delay = REPEAT_DELAY_MS) => {
  const previous = Number.parseInt(String(state.lastActionAt[action] || 0), 10) || 0;
  if (now - previous < delay) {
    return false;
  }
  state.lastActionAt[action] = now;
  return true;
};

const resolveNavigationAction = (pad) => {
  const horizontal = axisValue(pad, 0);
  const vertical = axisValue(pad, 1);
  if (buttonPressed(pad, BUTTONS.DPAD_RIGHT)
      || buttonPressed(pad, BUTTONS.DPAD_DOWN)
      || buttonPressed(pad, BUTTONS.RB)
      || buttonPressed(pad, BUTTONS.RT)
      || buttonPressed(pad, BUTTONS.A)
      || horizontal > ANALOG_DEAD_ZONE
      || vertical > ANALOG_DEAD_ZONE) {
    return READER_INPUT_ACTIONS.NEXT;
  }
  if (buttonPressed(pad, BUTTONS.DPAD_LEFT)
      || buttonPressed(pad, BUTTONS.DPAD_UP)
      || buttonPressed(pad, BUTTONS.LB)
      || buttonPressed(pad, BUTTONS.LT)
      || buttonPressed(pad, BUTTONS.B)
      || horizontal < -ANALOG_DEAD_ZONE
      || vertical < -ANALOG_DEAD_ZONE) {
    return READER_INPUT_ACTIONS.PREVIOUS;
  }
  return "";
};

const resolveSettingsAction = (pad) => {
  const vertical = axisValue(pad, 1);
  if (buttonPressed(pad, BUTTONS.START) || buttonPressed(pad, BUTTONS.B)) {
    return READER_INPUT_ACTIONS.CLOSE_SETTINGS;
  }
  if (buttonPressed(pad, BUTTONS.DPAD_DOWN) || vertical > ANALOG_DEAD_ZONE) {
    return READER_INPUT_ACTIONS.SETTINGS_SCROLL_DOWN;
  }
  if (buttonPressed(pad, BUTTONS.DPAD_UP) || vertical < -ANALOG_DEAD_ZONE) {
    return READER_INPUT_ACTIONS.SETTINGS_SCROLL_UP;
  }
  return "";
};

/**
 * Resolve keyboard input to a reader action while preserving text input focus.
 *
 * @param {KeyboardEvent | {key?: string, target?: EventTarget | null, defaultPrevented?: boolean}} event
 * @returns {string}
 */
export const resolveKeyboardAction = (event) => {
  const target = event?.target;
  const tagName = typeof HTMLElement !== "undefined" && target instanceof HTMLElement ? target.tagName.toLowerCase() : "";
  if (event?.defaultPrevented || tagName === "input" || tagName === "textarea" || tagName === "select") {
    return "";
  }
  const key = String(event?.key || "");
  if (["ArrowRight", "PageDown", " "].includes(key)) {
    return READER_INPUT_ACTIONS.NEXT;
  }
  if (["ArrowLeft", "PageUp"].includes(key)) {
    return READER_INPUT_ACTIONS.PREVIOUS;
  }
  if (key.toLowerCase() === "s") {
    return READER_INPUT_ACTIONS.TOGGLE_SETTINGS;
  }
  if (key.toLowerCase() === "f") {
    return READER_INPUT_ACTIONS.FULLSCREEN;
  }
  if (key.toLowerCase() === "b") {
    return READER_INPUT_ACTIONS.BOOKMARK;
  }
  if (key === "Escape") {
    return READER_INPUT_ACTIONS.CLOSE_SETTINGS;
  }
  return "";
};

/**
 * Resolve a pointer swipe into next or previous navigation.
 *
 * @param {{x: number, y: number} | null} start
 * @param {{x: number, y: number} | null} end
 * @param {number} [threshold]
 * @returns {string}
 */
export const resolvePointerSwipe = (start, end, threshold = 56) => {
  if (!start || !end) {
    return "";
  }
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  if (Math.abs(deltaX) <= threshold || Math.abs(deltaX) <= Math.abs(deltaY)) {
    return "";
  }
  return deltaX < 0 ? READER_INPUT_ACTIONS.NEXT : READER_INPUT_ACTIONS.PREVIOUS;
};

/**
 * Resolve gamepad state into debounced reader actions.
 *
 * @param {Array<Gamepad | null> | Gamepad[]} pads
 * @param {{lastActionAt: Record<string, number>, pressedButtons: Set<string>, connected: boolean}} state
 * @param {{now?: number, settingsOpen?: boolean, documentHidden?: boolean}} [options]
 * @returns {string[]}
 */
export const resolveGamepadActions = (pads, state, {now = Date.now(), settingsOpen = false, documentHidden = false} = {}) => {
  if (documentHidden) {
    state.connected = false;
    state.pressedButtons.clear();
    return [];
  }

  const pad = Array.from(pads || []).find(Boolean);
  if (!pad) {
    state.connected = false;
    state.pressedButtons.clear();
    return [];
  }

  state.connected = true;
  const actions = [];
  for (const [buttonIndex, action] of EDGE_ACTION_BUTTONS.entries()) {
    const key = String(buttonIndex);
    const pressed = buttonPressed(pad, buttonIndex);
    if (pressed && !state.pressedButtons.has(key) && canRepeat(state, action, now, EDGE_DELAY_MS)) {
      actions.push(action);
    }
    if (pressed) {
      state.pressedButtons.add(key);
    } else {
      state.pressedButtons.delete(key);
    }
  }

  const action = settingsOpen ? resolveSettingsAction(pad) : resolveNavigationAction(pad);
  if (action && canRepeat(state, action, now)) {
    actions.push(action);
  }
  return actions;
};

export default {
  READER_INPUT_ACTIONS,
  createReaderInputState,
  resolveGamepadActions,
  resolveKeyboardAction,
  resolvePointerSwipe
};
