/**
 * Immediate-mode UI toolkit.
 *
 * Widgets are declared every frame; `UIContext` performs layout, hit-testing,
 * hover/active/focus states and keyboard navigation. Screens only describe what
 * they want, which keeps them declarative and guarantees the drawn state and
 * the interactive state can never disagree (no "fake buttons").
 *
 * Accessibility: every interactive widget is reachable with Tab/arrows and
 * activated with Enter/Space, and the focused widget is always visibly marked.
 */

import { clamp, clamp01 } from '../core/math.js';
import { FONTS, FONT_SIZES, PALETTE, rgba } from '../config/palette.js';

export class Rect {
  constructor(x = 0, y = 0, w = 0, h = 0) {
    this.x = x;
    this.y = y;
    this.w = w;
    this.h = h;
  }

  get right() {
    return this.x + this.w;
  }

  get bottom() {
    return this.y + this.h;
  }

  get centerX() {
    return this.x + this.w / 2;
  }

  get centerY() {
    return this.y + this.h / 2;
  }

  contains(px, py) {
    return px >= this.x && px <= this.right && py >= this.y && py <= this.bottom;
  }

  inset(amount) {
    return new Rect(this.x + amount, this.y + amount, this.w - amount * 2, this.h - amount * 2);
  }

  offset(dx, dy) {
    return new Rect(this.x + dx, this.y + dy, this.w, this.h);
  }
}

export class UIContext {
  constructor() {
    this.ctx = null;
    this.input = null;
    this.width = 0;
    this.height = 0;
    this.time = 0;
    this.dt = 0;
    this.scale = 1;
    this.focusables = [];
    this.focusIndex = 0;
    this.focusGroup = 'default';
    this.pointerConsumed = false;
    this.keyboardUsed = false;
    this.hoveredId = null;
    this.lastActivated = null;
    this.tooltip = null;
    /** Set while a text field is capturing typing, so gameplay input pauses. */
    this.focusInput = false;
    this.theme = {
      panel: PALETTE.uiPanel,
      panelSolid: PALETTE.uiPanelSolid,
      border: PALETTE.uiBorder,
      text: PALETTE.ui,
      dim: PALETTE.uiDim,
      accent: PALETTE.uiAccent,
    };
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {import('../core/input.js').Input} input
   * @param {number} width CSS pixels
   * @param {number} height CSS pixels
   * @param {number} time seconds
   * @param {number} dt seconds
   */
  begin(ctx, input, width, height, time, dt) {
    this.ctx = ctx;
    this.input = input;
    this.width = width;
    this.height = height;
    this.time = time;
    this.dt = dt;
    this.focusables = [];
    this.pointerConsumed = false;
    this.hoveredId = null;
    this.tooltip = null;
    this.textFieldActive = false;
    ctx.save();
    ctx.textBaseline = 'middle';
  }

  end() {
    this.ctx.restore();
    ctx_resetAlpha(this.ctx);
  }

  /** Registers an interactive region and returns its interaction state. */
  _register(id, rect, { disabled = false, onActivate = null, navOrder = null } = {}) {
    const pointer = this.input.pointer;
    const hovered = !disabled && !this.pointerConsumed && rect.contains(pointer.x, pointer.y);
    if (hovered) this.hoveredId = id;
    const entry = { id, rect, disabled, onActivate, navOrder };
    this.focusables.push(entry);

    const clicked = hovered && this.input.pointerClicked(0);
    if (clicked) {
      this.pointerConsumed = true;
      if (onActivate) onActivate();
      this.lastActivated = id;
    }
    return { hovered, clicked, focused: false, disabled, rect, id };
  }

  /** Applies keyboard navigation across the registered focusables. */
  resolveFocus() {
    if (this.focusables.length === 0) {
      this.focusIndex = 0;
      return null;
    }
    const enabled = this.focusables.filter((f) => !f.disabled);
    if (enabled.length === 0) return null;
    this.focusIndex = clamp(this.focusIndex, 0, enabled.length - 1);

    if (
      this.input.wasPressed('up') ||
      this.input.wasPressed('left') ||
      this.input.codePressed('Tab')
    ) {
      const backwards = this.input.wasPressed('up') || this.input.wasPressed('left');
      this.focusIndex = backwards
        ? (this.focusIndex - 1 + enabled.length) % enabled.length
        : (this.focusIndex + 1) % enabled.length;
      this.keyboardUsed = true;
    }
    if (this.input.wasPressed('down') || this.input.wasPressed('right')) {
      this.focusIndex = (this.focusIndex + 1) % enabled.length;
      this.keyboardUsed = true;
    }

    const current = enabled[this.focusIndex];
    const confirm = this.input.wasPressed('confirm') || this.input.codePressed('Space');
    if (confirm && !current.disabled) {
      if (current.onActivate) current.onActivate();
      this.lastActivated = current.id;
    }
    return current;
  }

  /** True when the pointer is over any registered widget this frame. */
  get pointerOverUI() {
    return this.hoveredId !== null;
  }

  isFocused(id) {
    const enabled = this.focusables.filter((f) => !f.disabled);
    const current = enabled[this.focusIndex];
    return current ? current.id === id : false;
  }

  // ---------------------------------------------------------------------
  // Primitives
  // ---------------------------------------------------------------------

  panel(rect, { alpha = 0.92, border = true, fill = null, radius = 8, glow = false } = {}) {
    const ctx = this.ctx;
    ctx.save();
    roundRect(ctx, rect, radius);
    ctx.fillStyle = fill ?? rgba(PALETTE.uiPanelSolid, alpha);
    ctx.fill();
    if (border) {
      ctx.strokeStyle = this.theme.border;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (glow) {
      ctx.strokeStyle = rgba(PALETTE.uiAccent, 0.35);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }

  text(str, x, y, {
    size = FONT_SIZES.body,
    color = this.theme.text,
    align = 'left',
    font = FONTS.body,
    weight = 400,
    baseline = 'middle',
    alpha = 1,
    letterSpacing = null,
    maxWidth = null,
    shadow = false,
  } = {}) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `${weight} ${size}px ${font}`;
    ctx.textAlign = align;
    ctx.textBaseline = baseline;
    if (letterSpacing !== null && 'letterSpacing' in ctx) ctx.letterSpacing = `${letterSpacing}px`;
    if (shadow) {
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillText(str, x + 1, y + 1, maxWidth ?? undefined);
    }
    ctx.fillStyle = color;
    ctx.fillText(str, x, y, maxWidth ?? undefined);
    ctx.restore();
    return ctx.measureText(str).width;
  }

  /** Uppercase display text with wide tracking, used for headers. */
  heading(str, x, y, { size = FONT_SIZES.heading, color = this.theme.text, align = 'left', weight = 700 } = {}) {
    return this.text(str.toUpperCase(), x, y, { size, color, align, font: FONTS.display, weight, letterSpacing: 2 });
  }

  label(str, x, y, opts = {}) {
    return this.text(str.toUpperCase(), x, y, {
      size: opts.size ?? FONT_SIZES.tiny,
      color: opts.color ?? this.theme.dim,
      font: FONTS.display,
      weight: 600,
      letterSpacing: 1.4,
      align: opts.align ?? 'left',
    });
  }

  button(id, rect, label, {
    onClick = null,
    disabled = false,
    variant = 'default',
    hint = null,
    icon = null,
    subtitle = null,
  } = {}) {
    const state = this._register(id, rect, { disabled, onActivate: onClick });
    const focused = this.isFocused(id);
    const hovered = state.hovered || focused;
    const ctx = this.ctx;

    const colors = {
      default: { bg: 'rgba(18,26,38,0.9)', border: 'rgba(127,230,255,0.22)', text: PALETTE.ui },
      primary: { bg: 'rgba(16,44,54,0.95)', border: rgba(PALETTE.uiAccent, 0.55), text: PALETTE.uiAccent },
      danger: { bg: 'rgba(48,18,26,0.95)', border: rgba(PALETTE.uiDanger, 0.5), text: PALETTE.uiDanger },
      ghost: { bg: 'rgba(10,15,22,0.4)', border: 'rgba(120,140,165,0.18)', text: PALETTE.uiDim },
    }[variant] ?? {};

    ctx.save();
    roundRect(ctx, rect, 6);
    ctx.fillStyle = disabled ? 'rgba(12,16,22,0.6)' : hovered ? shade(colors.bg) : colors.bg;
    ctx.fill();
    ctx.strokeStyle = disabled ? 'rgba(80,90,105,0.25)' : hovered ? colors.text : colors.border;
    ctx.lineWidth = hovered ? 2 : 1;
    ctx.stroke();

    // Left accent bar marks keyboard focus explicitly (not only colour).
    if (focused) {
      ctx.fillStyle = rgba(PALETTE.uiAccent, 0.9);
      ctx.fillRect(rect.x + 2, rect.y + 6, 3, rect.h - 12);
    }

    const textX = rect.x + (icon ? 34 : 16);
    if (icon) {
      ctx.fillStyle = disabled ? PALETTE.uiFaint : colors.text;
      ctx.font = `700 15px ${FONTS.display}`;
      ctx.textAlign = 'center';
      ctx.fillText(icon, rect.x + 20, rect.centerY);
    }
    ctx.globalAlpha = disabled ? 0.45 : 1;
    this.text(label.toUpperCase(), textX, subtitle ? rect.centerY - 8 : rect.centerY, {
      size: FONT_SIZES.body,
      color: disabled ? PALETTE.uiFaint : hovered ? '#ffffff' : colors.text,
      font: FONTS.display,
      weight: 700,
      letterSpacing: 1.2,
    });
    if (subtitle) {
      this.text(subtitle, textX, rect.centerY + 10, { size: FONT_SIZES.tiny, color: this.theme.dim });
    }
    if (hint && hovered) {
      this.text(hint, rect.right - 14, rect.centerY, {
        size: FONT_SIZES.tiny,
        color: this.theme.dim,
        align: 'right',
        font: FONTS.mono,
      });
    }
    ctx.restore();
    ctx.globalAlpha = 1;
    return state.clicked;
  }

  /** Horizontal slider with keyboard support. Returns the new value. */
  slider(id, rect, value, { min = 0, max = 1, step = 0.05, onChange = null, format = null } = {}) {
    const state = this._register(id, rect, { onActivate: null });
    const focused = this.isFocused(id);
    const ctx = this.ctx;
    const ratio = clamp01((value - min) / (max - min || 1));

    // Click / drag anywhere on the track sets the value.
    if ((state.hovered && this.input.pointerDown(0)) || (state.hovered && state.clicked)) {
      const t = clamp01((this.input.pointer.x - rect.x) / rect.w);
      const next = clamp(min + t * (max - min), min, max);
      if (onChange && next !== value) onChange(next);
      this.pointerConsumed = true;
    }
    // Arrow keys adjust the focused slider.
    if (focused) {
      if (this.input.wasPressed('left')) {
        const next = clamp(value - step, min, max);
        if (onChange) onChange(next);
      }
      if (this.input.wasPressed('right')) {
        const next = clamp(value + step, min, max);
        if (onChange) onChange(next);
      }
    }

    ctx.save();
    const trackH = 6;
    const trackY = rect.centerY - trackH / 2;
    ctx.fillStyle = 'rgba(10,14,20,0.9)';
    roundRect(ctx, new Rect(rect.x, trackY, rect.w, trackH), 3);
    ctx.fill();
    ctx.fillStyle = state.hovered || focused ? PALETTE.uiAccent : rgba(PALETTE.uiAccent, 0.7);
    roundRect(ctx, new Rect(rect.x, trackY, rect.w * ratio, trackH), 3);
    ctx.fill();

    const knobX = rect.x + rect.w * ratio;
    ctx.beginPath();
    ctx.arc(knobX, rect.centerY, focused ? 8 : 6.5, 0, Math.PI * 2);
    ctx.fillStyle = '#0b1119';
    ctx.fill();
    ctx.strokeStyle = state.hovered || focused ? '#ffffff' : PALETTE.uiAccent;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    if (format) {
      this.text(format(value), rect.right + 8, rect.centerY, {
        size: FONT_SIZES.small,
        color: this.theme.text,
        font: FONTS.mono,
        align: 'left',
      });
    }
    return value;
  }

  /** Segmented selector rendered as adjacent buttons. */
  segmented(id, rect, options, value, { onChange = null, columns = null } = {}) {
    const count = options.length;
    const cols = columns ?? count;
    const rows = Math.ceil(count / cols);
    const gap = 4;
    const cellW = (rect.w - gap * (cols - 1)) / cols;
    const cellH = (rect.h - gap * (rows - 1)) / rows;
    let changed = value;
    for (let i = 0; i < count; i += 1) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const cell = new Rect(rect.x + col * (cellW + gap), rect.y + row * (cellH + gap), cellW, cellH);
      const option = options[i];
      const active = option.value === value;
      const state = this._register(`${id}:${option.value}`, cell, {
        onActivate: () => {
          if (onChange) onChange(option.value);
          changed = option.value;
        },
      });
      const focused = this.isFocused(`${id}:${option.value}`);
      const ctx = this.ctx;
      ctx.save();
      roundRect(ctx, cell, 5);
      ctx.fillStyle = active ? rgba(PALETTE.uiAccent, 0.2) : state.hovered ? 'rgba(30,42,58,0.9)' : 'rgba(14,20,28,0.85)';
      ctx.fill();
      ctx.strokeStyle = active ? PALETTE.uiAccent : focused ? rgba(PALETTE.uiAccent, 0.6) : 'rgba(120,140,165,0.2)';
      ctx.lineWidth = active ? 2 : 1;
      ctx.stroke();
      ctx.restore();
      this.text(option.label.toUpperCase(), cell.centerX, cell.centerY, {
        size: FONT_SIZES.small,
        color: active ? PALETTE.uiAccent : state.hovered ? '#ffffff' : this.theme.dim,
        align: 'center',
        font: FONTS.display,
        weight: 700,
        letterSpacing: 0.8,
      });
    }
    return changed;
  }

  toggle(id, rect, value, { onChange = null, label = '' } = {}) {
    const state = this._register(id, rect, {
      onActivate: () => {
        if (onChange) onChange(!value);
      },
    });
    const focused = this.isFocused(id);
    const ctx = this.ctx;
    const boxSize = Math.min(20, rect.h);
    const box = new Rect(rect.x, rect.centerY - boxSize / 2, boxSize, boxSize);
    ctx.save();
    roundRect(ctx, box, 4);
    ctx.fillStyle = value ? rgba(PALETTE.uiAccent, 0.25) : 'rgba(12,18,26,0.9)';
    ctx.fill();
    ctx.strokeStyle = focused || state.hovered ? PALETTE.uiAccent : 'rgba(120,140,165,0.35)';
    ctx.lineWidth = focused ? 2 : 1;
    ctx.stroke();
    if (value) {
      ctx.strokeStyle = PALETTE.uiAccent;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(box.x + 4, box.centerY);
      ctx.lineTo(box.centerX - 1, box.bottom - 5);
      ctx.lineTo(box.right - 4, box.y + 5);
      ctx.stroke();
    }
    ctx.restore();
    this.text(label, rect.x + boxSize + 12, rect.centerY, {
      size: FONT_SIZES.small,
      color: state.hovered || focused ? '#ffffff' : this.theme.text,
    });
    return value;
  }

  /** Read-only stat row used across the results and upgrade screens. */
  statRow(rect, label, value, { color = this.theme.text, valueColor = null, sublabel = null } = {}) {
    this.text(label.toUpperCase(), rect.x, rect.centerY, {
      size: FONT_SIZES.tiny,
      color: this.theme.dim,
      font: FONTS.display,
      weight: 600,
      letterSpacing: 1.2,
    });
    if (sublabel) {
      this.text(sublabel, rect.x, rect.centerY + 13, { size: FONT_SIZES.micro, color: this.theme.dim });
    }
    this.text(value, rect.right, rect.centerY, {
      size: FONT_SIZES.body,
      color: valueColor ?? color,
      align: 'right',
      font: FONTS.mono,
      weight: 600,
    });
  }

  progressBar(rect, ratio, { color = PALETTE.uiAccent, background = 'rgba(8,12,18,0.85)', border = false, label = null, showFraction = false } = {}) {
    const ctx = this.ctx;
    const clamped = clamp01(ratio);
    ctx.save();
    roundRect(ctx, rect, 3);
    ctx.fillStyle = background;
    ctx.fill();
    if (clamped > 0) {
      const fill = new Rect(rect.x, rect.y, Math.max(2, rect.w * clamped), rect.h);
      roundRect(ctx, fill, 3);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillRect(fill.x, fill.y, fill.w, Math.max(1, fill.h * 0.28));
    }
    if (border) {
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 1;
      roundRect(ctx, rect, 3);
      ctx.stroke();
    }
    ctx.restore();
    if (label) {
      this.text(label, rect.x + 6, rect.centerY, {
        size: FONT_SIZES.micro,
        color: '#ffffff',
        font: FONTS.display,
        weight: 700,
        shadow: true,
      });
    }
    if (showFraction) {
      this.text(`${Math.round(clamped * 100)}%`, rect.right - 6, rect.centerY, {
        size: FONT_SIZES.micro,
        color: '#ffffff',
        align: 'right',
        font: FONTS.mono,
        shadow: true,
      });
    }
  }

  /** Draws a formatted key cap, e.g. [R]. */
  keycap(x, y, label, { size = FONT_SIZES.micro } = {}) {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = `700 ${size}px ${FONTS.mono}`;
    const w = Math.max(18, ctx.measureText(label).width + 10);
    const rect = new Rect(x, y - 8, w, 16);
    roundRect(ctx, rect, 3);
    ctx.fillStyle = 'rgba(120,140,165,0.16)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(160,180,205,0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
    this.text(label, rect.centerX, rect.centerY, {
      size,
      color: PALETTE.ui,
      align: 'center',
      font: FONTS.mono,
      weight: 700,
    });
    return w;
  }

  divider(x1, x2, y, { alpha = 0.16 } = {}) {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = rgba(PALETTE.uiAccent, alpha);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x1, Math.round(y) + 0.5);
    ctx.lineTo(x2, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.restore();
  }

  /** Centred modal overlay used by pause / confirmations. */
  scrim(alpha = 0.72) {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = `rgba(3,5,9,${alpha})`;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.restore();
  }

  setTooltip(text) {
    this.tooltip = text;
  }

  /**
   * Single-line text input. Returns the (possibly updated) value.
   * Typing is captured from `Input.typed`, so the caller must ensure gameplay
   * input is paused while a field is focused.
   */
  textField(id, rect, value, {
    placeholder = '',
    maxLength = 32,
    onChange = null,
    onSubmit = null,
    sanitize = null,
  } = {}) {
    const state = this._register(id, rect, { onActivate: null });
    const focused = state.hovered;
    const ctx = this.ctx;
    let next = value;

    if (focused) {
      this.pointerConsumed = true;
      this.textFieldActive = true;
      for (const ch of this.input.typed) {
        if (ch.length !== 1) continue;
        const candidate = sanitize ? sanitize(ch) : ch;
        if (!candidate) continue;
        if (next.length < maxLength) next += candidate;
      }
      if (this.input.codePressed('Backspace')) next = next.slice(0, -1);
      if (this.input.wasPressed('confirm') && onSubmit) onSubmit(next);
      if (next !== value && onChange) onChange(next);
    }

    ctx.save();
    roundRect(ctx, rect, 6);
    ctx.fillStyle = 'rgba(8,12,18,0.92)';
    ctx.fill();
    ctx.strokeStyle = focused ? PALETTE.uiAccent : 'rgba(120,140,165,0.3)';
    ctx.lineWidth = focused ? 2 : 1;
    ctx.stroke();
    ctx.restore();

    const shown = next.length > 0 ? next.toUpperCase() : placeholder;
    this.text(shown, rect.x + 12, rect.centerY, {
      size: FONT_SIZES.body,
      color: next.length > 0 ? PALETTE.ui : PALETTE.uiFaint,
      font: FONTS.mono,
      weight: 600,
      letterSpacing: 1.4,
    });
    if (focused && Math.floor(this.time * 2) % 2 === 0) {
      ctx.save();
      const width = ctx.measureText(shown).width;
      ctx.fillStyle = PALETTE.uiAccent;
      ctx.fillRect(rect.x + 13 + width, rect.centerY - 9, 2, 18);
      ctx.restore();
    }
    return next;
  }

  drawTooltip() {
    if (!this.tooltip) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.font = `500 ${FONT_SIZES.tiny}px ${FONTS.body}`;
    const metrics = ctx.measureText(this.tooltip);
    const w = metrics.width + 20;
    const h = 26;
    const pointer = this.input.pointer;
    const x = clamp(pointer.x + 16, 8, this.width - w - 8);
    const y = clamp(pointer.y + 18, 8, this.height - h - 8);
    roundRect(ctx, new Rect(x, y, w, h), 5);
    ctx.fillStyle = 'rgba(8,12,18,0.96)';
    ctx.fill();
    ctx.strokeStyle = rgba(PALETTE.uiAccent, 0.3);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
    this.text(this.tooltip, x + 10, y + h / 2, { size: FONT_SIZES.tiny, color: PALETTE.ui });
  }
}

export function roundRect(ctx, rect, radius = 6) {
  const r = Math.min(radius, rect.w / 2, rect.h / 2);
  ctx.beginPath();
  ctx.moveTo(rect.x + r, rect.y);
  ctx.lineTo(rect.right - r, rect.y);
  ctx.quadraticCurveTo(rect.right, rect.y, rect.right, rect.y + r);
  ctx.lineTo(rect.right, rect.bottom - r);
  ctx.quadraticCurveTo(rect.right, rect.bottom, rect.right - r, rect.bottom);
  ctx.lineTo(rect.x + r, rect.bottom);
  ctx.quadraticCurveTo(rect.x, rect.bottom, rect.x, rect.bottom - r);
  ctx.lineTo(rect.x, rect.y + r);
  ctx.quadraticCurveTo(rect.x, rect.y, rect.x + r, rect.y);
  ctx.closePath();
}

function shade(color) {
  if (color.startsWith('rgba')) {
    return color.replace(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/, (_, r, g, b, a) => {
      const lighten = (v) => Math.min(255, Math.round(v * 1.6) + 12);
      return `rgba(${lighten(+r)}, ${lighten(+g)}, ${lighten(+b)}, ${Math.min(1, +a + 0.06)})`;
    });
  }
  return color;
}

function ctx_resetAlpha(ctx) {
  if (ctx) ctx.globalAlpha = 1;
}

/** Layout helper: vertical stack of rects with consistent spacing. */
export class VStack {
  constructor(x, y, width, gap = 8) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.gap = gap;
    this.cursor = y;
  }

  row(height) {
    const rect = new Rect(this.x, this.cursor, this.width, height);
    this.cursor += height + this.gap;
    return rect;
  }

  space(amount) {
    this.cursor += amount;
    return this;
  }

  get bottom() {
    return this.cursor;
  }
}
