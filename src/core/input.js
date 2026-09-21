/**
 * Input layer: keyboard + pointer state with per-frame edge detection.
 *
 * Two consumption models are supported:
 *  - Gameplay reads level-triggered state (isDown / pointer position).
 *  - UI reads edge-triggered state (wasPressed / pointerPressed) which is
 *    cleared at the end of every frame by `endFrame()`.
 */

const DEFAULT_BINDINGS = {
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  reload: ['KeyR'],
  interact: ['KeyE'],
  dash: ['Space', 'ShiftLeft'],
  swapWeapon: ['KeyQ'],
  useMedkit: ['KeyF'],
  mapToggle: ['KeyM'],
  pause: ['Escape', 'KeyP'],
  confirm: ['Enter', 'NumpadEnter'],
  cancel: ['Escape', 'Backspace'],
  slot1: ['Digit1'],
  slot2: ['Digit2'],
  slot3: ['Digit3'],
  slot4: ['Digit4'],
  slot5: ['Digit5', 'Mouse2'],
};

export function defaultBindings() {
  const out = {};
  for (const [action, codes] of Object.entries(DEFAULT_BINDINGS)) out[action] = codes.slice();
  return out;
}

export class Input {
  constructor(target) {
    this.target = target;
    this.bindings = defaultBindings();
    this.down = new Set();
    this.pressed = new Set();
    this.released = new Set();
    this.pointer = { x: 0, y: 0, screenX: 0, screenY: 0, inside: false };
    this.pointerButtons = new Set();
    this.pointerPressedButtons = new Set();
    this.wheelDelta = 0;
    this.enabled = true;
    this.modifiers = { shift: false, ctrl: false, alt: false };
    /** Printable characters captured this frame, for text fields. */
    this.typed = [];
    this._listeners = [];
    this._bind();
  }

  _add(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    this._listeners.push(() => target.removeEventListener(type, handler, options));
  }

  _bind() {
    const t = this.target;
    this._add(window, 'keydown', (event) => {
      if (!this.enabled) return;
      if (event.repeat) {
        // Still record level state, but never re-trigger an edge.
        this.down.add(event.code);
        return;
      }
      this.down.add(event.code);
      this.pressed.add(event.code);
      if (event.key && event.key.length === 1) this.typed.push(event.key);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(event.code)) {
        event.preventDefault();
      }
      this._syncModifiers(event);
    });
    this._add(window, 'keyup', (event) => {
      this.down.delete(event.code);
      this.released.add(event.code);
      this._syncModifiers(event);
    });
    this._add(window, 'blur', () => this.clearAll());

    this._add(t, 'pointermove', (event) => {
      const rect = t.getBoundingClientRect();
      this.pointer.screenX = event.clientX;
      this.pointer.screenY = event.clientY;
      this.pointer.x = event.clientX - rect.left;
      this.pointer.y = event.clientY - rect.top;
      this.pointer.inside = true;
    });
    this._add(t, 'pointerdown', (event) => {
      if (!this.enabled) return;
      const rect = t.getBoundingClientRect();
      this.pointer.x = event.clientX - rect.left;
      this.pointer.y = event.clientY - rect.top;
      this.pointer.inside = true;
      this.pointerButtons.add(event.button);
      this.pointerPressedButtons.add(event.button);
      if (t.setPointerCapture && event.pointerId !== undefined) {
        try {
          t.setPointerCapture(event.pointerId);
        } catch {
          /* capture is a nice-to-have; ignore browsers that refuse */
        }
      }
      event.preventDefault();
    });
    const up = (event) => {
      this.pointerButtons.delete(event.button);
    };
    this._add(window, 'pointerup', up);
    this._add(window, 'pointercancel', up);
    this._add(t, 'pointerleave', () => {
      this.pointer.inside = false;
    });
    this._add(
      t,
      'wheel',
      (event) => {
        this.wheelDelta += Math.sign(event.deltaY);
        event.preventDefault();
      },
      { passive: false },
    );
    this._add(t, 'contextmenu', (event) => event.preventDefault());
  }

  _syncModifiers(event) {
    this.modifiers.shift = event.shiftKey;
    this.modifiers.ctrl = event.ctrlKey;
    this.modifiers.alt = event.altKey;
  }

  resetBindings() {
    this.bindings = defaultBindings();
  }

  setBinding(action, codes) {
    this.bindings[action] = codes.slice();
  }

  codesFor(action) {
    return this.bindings[action] ?? [];
  }

  isDown(action) {
    const codes = this.bindings[action];
    if (!codes) return false;
    for (const code of codes) {
      if (code.startsWith('Mouse')) {
        if (this.pointerButtons.has(Number(code.slice(5)))) return true;
      } else if (this.down.has(code)) {
        return true;
      }
    }
    return false;
  }

  wasPressed(action) {
    const codes = this.bindings[action];
    if (!codes) return false;
    for (const code of codes) {
      if (code.startsWith('Mouse')) {
        if (this.pointerPressedButtons.has(Number(code.slice(5)))) return true;
      } else if (this.pressed.has(code)) {
        return true;
      }
    }
    return false;
  }

  codePressed(code) {
    return this.pressed.has(code);
  }

  keyDown(code) {
    return this.down.has(code);
  }

  pointerDown(button = 0) {
    return this.pointerButtons.has(button);
  }

  pointerClicked(button = 0) {
    return this.pointerPressedButtons.has(button);
  }

  /** Normalised movement vector, guaranteed length <= 1. */
  axis() {
    let x = 0;
    let y = 0;
    if (this.isDown('left')) x -= 1;
    if (this.isDown('right')) x += 1;
    if (this.isDown('up')) y -= 1;
    if (this.isDown('down')) y += 1;
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    return { x, y, len: Math.min(len, 1) };
  }

  consumeWheel() {
    const value = this.wheelDelta;
    this.wheelDelta = 0;
    return value;
  }

  clearAll() {
    this.down.clear();
    this.pressed.clear();
    this.released.clear();
    this.pointerButtons.clear();
    this.pointerPressedButtons.clear();
    this.typed.length = 0;
  }

  /** Called once per frame, after the frame has consumed edge input. */
  endFrame() {
    this.pressed.clear();
    this.released.clear();
    this.pointerPressedButtons.clear();
    this.wheelDelta = 0;
    this.typed.length = 0;
  }

  dispose() {
    for (const dispose of this._listeners) dispose();
    this._listeners.length = 0;
    this.clearAll();
  }
}
