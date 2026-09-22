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
    // Set when the frame's focused slider consumes the arrow keys itself, so
    // navigation does not also move the focus in the same press.
    this._sliderTookNav = false;
    ctx.save();
    ctx.textBaseline = 'middle';
  }

  end() {
    this._resolveFocusFrame();
    this.ctx.restore();
    ctx_resetAlpha(this.ctx);
  }

  /**
   * Keyboard focus, resolved once per frame after every widget has registered.
   *
   * The focused id is consumed by `isFocused()` while the *next* frame draws,
   * which keeps the marker stable within a frame. Focus only becomes visible
   * once the player actually uses the keyboard, so a mouse-only player is never
   * shown a focus marker on a control they never selected.
   */
  _resolveFocusFrame() {
    const enabled = this.focusables.filter((f) => !f.disabled);
    if (enabled.length === 0) {
      this.focusedId = null;
      this._prevStateTime = this.stateTime ?? 0;
      return;
    }
    // A new screen starts its focus at the top: carrying an index across screens
    // would land the ring (and the next Enter) on an arbitrary control.
    const stateTime = this.stateTime ?? 0;
    if (stateTime < (this._prevStateTime ?? 0)) this.focusIndex = 0;
    this._prevStateTime = stateTime;
    this.focusIndex = clamp(this.focusIndex, 0, enabled.length - 1);

    const tab = this.input.codePressed('Tab');
    const backwards = !this._sliderTookNav && (this.input.wasPressed('up') || this.input.wasPressed('left'));
    const forwards = !this._sliderTookNav && (this.input.wasPressed('down') || this.input.wasPressed('right'));
    if (tab || backwards || forwards) {
      if (!this.keyboardUsed) {
        // First keyboard interaction: reveal the marker on the current entry
        // instead of skipping past it.
        this.keyboardUsed = true;
      } else {
        const direction = backwards && !forwards ? -1 : 1;
        this.focusIndex = (this.focusIndex + direction + enabled.length) % enabled.length;
      }
    }
    this.focusedId = enabled[this.focusIndex]?.id ?? null;
  }

  /**
   * Activates whatever the player is pointing at or has focused with the
   * keyboard. Called by the game after the frame renders, so it uses exactly
   * the widgets that were drawn.
   * @returns {boolean} whether a control was activated
   */
  activateFocused() {
    const id = this.hoveredId ?? (this.keyboardUsed ? this.focusedId : null);
    if (!id) return false;
    const entry = this.focusables.find((f) => f.id === id && !f.disabled);
    if (!entry || !entry.onActivate) return false;
    entry.onActivate();
    this.lastActivated = entry.id;
    return true;
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

  /** True when the pointer is over any registered widget this frame. */
  get pointerOverUI() {
    return this.hoveredId !== null;
  }

  isFocused(id) {
    // Nothing is focused until the player reaches for the keyboard: without
    // this the first registered widget of every screen looked permanently
    // selected (bright focus bar, hover treatment) even for mouse-only play.
    if (!this.keyboardUsed) return false;
    return this.focusedId === id;
  }

  /**
   * Entrance animation for screens: returns alpha and a small vertical offset
   * for the current moment, based on how long the current state has existed.
   * Presentation only — nothing here touches game state.
   */
  reveal(duration = 0.18, delay = 0) {
    // Respect the OS "reduce motion" preference: screens simply appear.
    if (this.reducedMotion) return { t: 1, alpha: 1, dy: 0 };
    const t = clamp01(((this.stateTime ?? 0) - delay) / Math.max(0.001, duration));
    // easeOutQuad reads as "settling" rather than "fading".
    const eased = 1 - (1 - t) * (1 - t);
    return { t: eased, alpha: eased, dy: (1 - eased) * 8 };
  }

  // ---------------------------------------------------------------------
  // Primitives
  // ---------------------------------------------------------------------

  panel(rect, { alpha = 0.92, border = true, fill = null, radius = 8, glow = false, accent = null, shadow = false, header = false } = {}) {
    const ctx = this.ctx;
    const cut = Math.min(18, Math.max(5, rect.h * 0.28), rect.w * 0.08);
    ctx.save();
    if (shadow) {
      ctx.fillStyle = PALETTE.uiShadow;
      cutRect(ctx, new Rect(rect.x, rect.y + 3, rect.w, rect.h), radius, cut);
      ctx.fill();
    }
    cutRect(ctx, rect, radius, cut);
    ctx.fillStyle = fill ?? rgba(PALETTE.uiPanelSolid, alpha);
    ctx.fill();
    // A faint top light makes stacked panels read as raised surfaces.
    ctx.save();
    cutRect(ctx, new Rect(rect.x, rect.y, rect.w, Math.min(rect.h, 22)), radius, cut);
    ctx.clip();
    ctx.fillStyle = PALETTE.uiTrackLight;
    ctx.fillRect(rect.x, rect.y, rect.w, Math.min(rect.h, 22));
    ctx.restore();
    if (header && rect.h > 34) {
      ctx.fillStyle = 'rgba(127, 230, 255, 0.05)';
      ctx.fillRect(rect.x + 1, rect.y + 1, rect.w - 2, 30);
      ctx.fillStyle = rgba(PALETTE.uiAccent, 0.18);
      ctx.fillRect(rect.x + 1, rect.y + 31, rect.w - 2, 1);
    }
    if (border) {
      ctx.strokeStyle = this.theme.border;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (accent) {
      ctx.save();
      cutRect(ctx, rect, radius, cut);
      ctx.clip();
      ctx.fillStyle = accent;
      ctx.fillRect(rect.x, rect.y, 3, rect.h);
      ctx.restore();
    }
    // Corner tick: the small machined detail that ties every surface together.
    // Only on panels large enough for it to read as intent, not noise.
    if (rect.h >= 30 && rect.w >= 90) {
      ctx.save();
      ctx.strokeStyle = rgba(PALETTE.uiAccent, accent ? 0.5 : 0.22);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(rect.right - cut - 6, rect.y + 0.5);
      ctx.lineTo(rect.right - 6, rect.y + 0.5);
      ctx.stroke();
      ctx.restore();
    }
    if (glow) {
      ctx.strokeStyle = rgba(PALETTE.uiAccent, 0.35);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Small pill label for tiers, rarities, statuses and perk names.
   * Returns the width consumed so callers can lay chips out in a row.
   */
  chip(x, y, str, { color = PALETTE.uiDim, filled = false, size = FONT_SIZES.micro, height = 16, icon = null } = {}) {
    const ctx = this.ctx;
    const text = str.toUpperCase();
    ctx.save();
    ctx.font = `700 ${size}px ${FONTS.display}`;
    const iconW = icon ? ctx.measureText(`${icon} `).width : 0;
    const w = Math.ceil(ctx.measureText(text).width + iconW + 14);
    const rect = new Rect(x, y - height / 2, w, height);
    cutRect(ctx, rect, 3, Math.min(6, height * 0.45));
    ctx.fillStyle = filled ? rgba(color, 0.22) : rgba(color, 0.09);
    ctx.fill();
    ctx.strokeStyle = rgba(color, filled ? 0.7 : 0.35);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
    this.text(icon ? `${icon} ${text}` : text, rect.centerX, rect.centerY, {
      size,
      color,
      align: 'center',
      font: FONTS.display,
      weight: 700,
      letterSpacing: 0.8,
    });
    return w;
  }

  /** Key cap followed by its action label, e.g. [F] Repair Kit. */
  keyHint(x, y, key, label, { color = null, size = FONT_SIZES.micro, dim = false, gap = 6 } = {}) {
    const width = this.keycap(x, y, key, { size });
    if (!label) return width;
    const textW = this.text(label, x + width + gap, y, {
      size,
      color: color ?? (dim ? PALETTE.uiGhost : PALETTE.uiDim),
      font: FONTS.display,
      weight: 700,
      letterSpacing: 0.6,
    });
    return width + gap + textW;
  }

  /**
   * Panel title. The same treatment is used by the HUD and every screen, which
   * is what keeps the game reading as one interface.
   */
  panelLabel(str, x, y, { color = null, align = 'left' } = {}) {
    return this.text(str.toUpperCase(), x, y, {
      size: FONT_SIZES.micro,
      color: color ?? rgba(PALETTE.uiAccent, 0.8),
      align,
      font: FONTS.display,
      weight: 700,
      letterSpacing: 1.8,
    });
  }

  /**
   * Screen title block: heading, optional subtitle and the accent rule that
   * appears under every modal title. Returns the y to place content at.
   */
  screenTitle(x, y, title, { subtitle = null, color = PALETTE.uiAccent, ruleWidth = 54, align = 'left' } = {}) {
    this.text(title.toUpperCase(), x, y, {
      size: FONT_SIZES.heading,
      color,
      align,
      font: FONTS.display,
      weight: 800,
      letterSpacing: 3,
    });
    const ruleX = align === 'center' ? x - ruleWidth / 2 : x;
    const grad = this.ctx.createLinearGradient(ruleX, 0, ruleX + ruleWidth, 0);
    grad.addColorStop(0, rgba(color, 0.65));
    grad.addColorStop(1, rgba(color, 0));
    this.ctx.save();
    this.ctx.fillStyle = grad;
    this.ctx.fillRect(ruleX, y + 16, ruleWidth, 2);
    this.ctx.restore();
    if (subtitle) {
      this.text(subtitle, x, y + 26, { size: FONT_SIZES.micro, color: PALETTE.uiGhost });
    }
    return y + (subtitle ? 32 : 24);
  }

  /**
   * Consistent panel header: title on the left, optional meta on the right and
   * a rule underneath. Returns the y coordinate content should start at.
   */
  panelHeader(rect, title, { meta = null, metaColor = null, color = null, accent = PALETTE.uiAccent, rule = true, y = null, inset = 14 } = {}) {
    const titleY = (y ?? rect.y) + 18;
    this.panelLabel(title, rect.x + inset, titleY, { color: color ?? accent });
    if (meta !== null) {
      this.text(meta, rect.right - inset, titleY, {
        size: FONT_SIZES.micro,
        color: metaColor ?? PALETTE.uiDim,
        align: 'right',
        font: FONTS.mono,
        weight: 600,
      });
    }
    if (rule) this.divider(rect.x + inset, rect.right - inset, titleY + 12);
    return titleY + 12;
  }

  /** Draws text wrapped to a width; returns the number of lines drawn. */
  paragraph(str, x, y, { maxWidth, size = FONT_SIZES.small, color = PALETTE.uiDim, lineHeight = null, font = FONTS.body, weight = 400, maxLines = 6 } = {}) {
    const lines = wrapText(this.ctx, str, maxWidth, size, font, weight);
    const lh = lineHeight ?? Math.round(size * 1.5);
    let drawn = 0;
    for (const line of lines) {
      if (drawn >= maxLines) break;
      this.text(line, x, y + drawn * lh, { size, color, font, weight });
      drawn += 1;
    }
    return drawn;
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
    badge = null,
    badgeColor = null,
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
    cutRect(ctx, rect, 6, Math.min(14, rect.h * 0.42));
    ctx.fillStyle = disabled ? 'rgba(12,16,22,0.6)' : hovered ? shade(colors.bg) : colors.bg;
    ctx.fill();
    ctx.strokeStyle = disabled ? 'rgba(80,90,105,0.25)' : hovered ? colors.text : colors.border;
    ctx.lineWidth = hovered ? 2 : 1;
    ctx.stroke();
    if (!disabled) {
      // Inner top light, matching the panel treatment.
      ctx.save();
      cutRect(ctx, rect, 6, Math.min(14, rect.h * 0.42));
      ctx.clip();
      ctx.fillStyle = PALETTE.uiTrackLight;
      ctx.fillRect(rect.x, rect.y, rect.w, 1);
      ctx.restore();
    }

    // Left accent bar marks keyboard focus explicitly (not only colour).
    if (focused) {
      ctx.fillStyle = rgba(PALETTE.uiAccent, 0.9);
      ctx.fillRect(rect.x + 2, rect.y + 6, 3, rect.h - 12);
    }

    const textX = rect.x + (icon ? 34 : 16);
    if (icon) {
      ctx.fillStyle = disabled ? PALETTE.uiDisabled : colors.text;
      ctx.font = `700 ${FONT_SIZES.body}px ${FONTS.display}`;
      ctx.textAlign = 'center';
      ctx.fillText(icon, rect.x + 20, rect.centerY);
    }
    const badgeW = badge ? 46 : 0;
    ctx.globalAlpha = disabled ? 0.75 : 1;
    this.text(label.toUpperCase(), textX, subtitle ? rect.centerY - 8 : rect.centerY, {
      size: FONT_SIZES.body,
      color: disabled ? PALETTE.uiDisabled : hovered ? '#ffffff' : colors.text,
      font: FONTS.display,
      weight: 700,
      letterSpacing: 1.2,
      maxWidth: Math.max(40, rect.w - (textX - rect.x) - badgeW - 20),
    });
    if (subtitle) {
      this.text(subtitle, textX, rect.centerY + 10, {
        size: FONT_SIZES.tiny,
        color: disabled ? PALETTE.uiDisabled : PALETTE.uiGhost,
        maxWidth: Math.max(40, rect.w - (textX - rect.x) - 18),
      });
    }
    if (badge) {
      this.chip(rect.right - 22 - badgeW / 2, rect.centerY, badge, {
        color: badgeColor ?? (disabled ? PALETTE.uiDisabled : colors.text),
        filled: !disabled,
        height: Math.min(18, rect.h - 12),
      });
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
      if (this.input.wasPressed('left') || this.input.wasPressed('right')) this._sliderTookNav = true;
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
      cutRect(ctx, cell, 5, Math.min(10, cell.h * 0.4));
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
    cutRect(ctx, box, 4, Math.min(8, boxSize * 0.4));
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
  statRow(rect, label, value, { color = this.theme.text, valueColor = null, sublabel = null, icon = null, valueSize = FONT_SIZES.body, emphasize = false } = {}) {
    if (icon) {
      this.text(icon, rect.x, rect.centerY, {
        size: FONT_SIZES.small,
        color: valueColor ?? PALETTE.uiGhost,
        font: FONTS.display,
        weight: 700,
      });
    }
    this.text(label.toUpperCase(), rect.x + (icon ? 18 : 0), rect.centerY, {
      size: FONT_SIZES.tiny,
      color: emphasize ? PALETTE.ui : this.theme.dim,
      font: FONTS.display,
      weight: 600,
      letterSpacing: 1.2,
    });
    if (sublabel) {
      this.text(sublabel, rect.x + (icon ? 18 : 0), rect.centerY + 13, { size: FONT_SIZES.micro, color: PALETTE.uiGhost });
    }
    this.text(value, rect.right, rect.centerY, {
      size: valueSize,
      color: valueColor ?? color,
      align: 'right',
      font: FONTS.mono,
      weight: 600,
    });
  }

  progressBar(rect, ratio, {
    color = PALETTE.uiAccent,
    background = PALETTE.uiTrack,
    border = false,
    label = null,
    showFraction = false,
    ticks = 0,
    radius = 3,
    glow = false,
    marker = null,
    labelColor = '#ffffff',
    labelSize = FONT_SIZES.micro,
  } = {}) {
    const ctx = this.ctx;
    const clamped = clamp01(Number.isFinite(ratio) ? ratio : 0);
    ctx.save();
    roundRect(ctx, rect, radius);
    ctx.fillStyle = background;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 1;
    ctx.stroke();

    if (clamped > 0) {
      const fill = new Rect(rect.x + 1, rect.y + 1, Math.max(2, (rect.w - 2) * clamped), Math.max(1, rect.h - 2));
      ctx.save();
      roundRect(ctx, rect, radius);
      ctx.clip();
      const grad = ctx.createLinearGradient(fill.x, fill.y, fill.x, fill.bottom);
      grad.addColorStop(0, rgba(color, 0.95));
      grad.addColorStop(1, rgba(color, 0.72));
      ctx.fillStyle = grad;
      ctx.fillRect(fill.x, fill.y, fill.w, fill.h);
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.fillRect(fill.x, fill.y, fill.w, Math.max(1, fill.h * 0.3));
      if (glow) {
        ctx.fillStyle = rgba(color, 0.35);
        ctx.fillRect(fill.x, fill.y, fill.w, fill.h);
      }
      ctx.restore();
    }

    if (ticks > 1) {
      ctx.strokeStyle = 'rgba(4, 7, 11, 0.7)';
      ctx.lineWidth = 1;
      for (let i = 1; i < ticks; i += 1) {
        const x = Math.round(rect.x + (rect.w * i) / ticks) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, rect.y + 1);
        ctx.lineTo(x, rect.bottom - 1);
        ctx.stroke();
      }
    }
    if (marker !== null) {
      const mx = Math.round(rect.x + rect.w * clamp01(marker)) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(mx, rect.y - 1);
      ctx.lineTo(mx, rect.bottom + 1);
      ctx.stroke();
    }
    if (border) {
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 1;
      roundRect(ctx, rect, radius);
      ctx.stroke();
    }
    ctx.restore();

    if (label) {
      this.text(label, rect.x + 7, rect.centerY, {
        size: labelSize,
        color: labelColor,
        font: FONTS.display,
        weight: 700,
        letterSpacing: 0.8,
        shadow: true,
      });
    }
    if (showFraction) {
      this.text(`${Math.round(clamped * 100)}%`, rect.right - 7, rect.centerY, {
        size: labelSize,
        color: labelColor,
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
    cutRect(ctx, rect, 3, 5);
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

  divider(x1, x2, y, { alpha = 0.16, fade = true } = {}) {
    const ctx = this.ctx;
    ctx.save();
    if (fade) {
      const grad = ctx.createLinearGradient(x1, 0, x2, 0);
      grad.addColorStop(0, rgba(PALETTE.uiAccent, alpha * 0.35));
      grad.addColorStop(0.5, rgba(PALETTE.uiAccent, alpha));
      grad.addColorStop(1, rgba(PALETTE.uiAccent, alpha * 0.35));
      ctx.strokeStyle = grad;
    } else {
      ctx.strokeStyle = rgba(PALETTE.uiAccent, alpha);
    }
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x1, Math.round(y) + 0.5);
    ctx.lineTo(x2, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.restore();
  }

  /** Centred modal overlay used by pause / confirmations. */
  scrim(alpha = 0.72, { vignette = false } = {}) {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = `rgba(3,5,9,${alpha})`;
    ctx.fillRect(0, 0, this.width, this.height);
    if (vignette) {
      const grad = ctx.createRadialGradient(
        this.width / 2, this.height / 2, Math.min(this.width, this.height) * 0.18,
        this.width / 2, this.height / 2, Math.max(this.width, this.height) * 0.75,
      );
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(1, 'rgba(0,0,0,0.55)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, this.width, this.height);
    }
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
    cutRect(ctx, rect, 6, Math.min(12, rect.h * 0.4));
    ctx.fillStyle = 'rgba(8,12,18,0.92)';
    ctx.fill();
    ctx.strokeStyle = focused ? PALETTE.uiAccent : 'rgba(120,140,165,0.3)';
    ctx.lineWidth = focused ? 2 : 1;
    ctx.stroke();
    ctx.restore();

    const shown = next.length > 0 ? next.toUpperCase() : placeholder;
    this.text(shown, rect.x + 12, rect.centerY, {
      size: FONT_SIZES.body,
      // Still clearly dimmer than typed text, but readable (4.24:1).
      color: next.length > 0 ? PALETTE.ui : PALETTE.uiGhost,
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
    cutRect(ctx, new Rect(x, y, w, h), 5, 8);
    ctx.fillStyle = 'rgba(8,12,18,0.96)';
    ctx.fill();
    ctx.strokeStyle = rgba(PALETTE.uiAccent, 0.3);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
    this.text(this.tooltip, x + 10, y + h / 2, { size: FONT_SIZES.tiny, color: PALETTE.ui });
  }
}

/** Word-wraps a string for canvas rendering. Returns an array of lines. */
export function wrapText(ctx, str, maxWidth, size, font = FONTS.body, weight = 400) {
  const text = String(str ?? '');
  if (!maxWidth) return [text];
  ctx.save();
  ctx.font = `${weight} ${size}px ${font}`;
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  ctx.restore();
  return lines.length > 0 ? lines : [''];
}

/**
 * Signature panel/button silhouette: a rounded rectangle with the top-right
 * corner chamfered. One shared shape is what makes the HUD, menus and overlays
 * read as the same product instead of assorted rectangles.
 */
export function cutRect(ctx, rect, radius = 6, cut = 12) {
  const r = Math.min(radius, rect.w / 2, rect.h / 2);
  const c = Math.min(cut, rect.w * 0.5, rect.h * 0.8);
  ctx.beginPath();
  ctx.moveTo(rect.x + r, rect.y);
  ctx.lineTo(rect.right - c, rect.y);
  ctx.lineTo(rect.right, rect.y + c);
  ctx.lineTo(rect.right, rect.bottom - r);
  ctx.quadraticCurveTo(rect.right, rect.bottom, rect.right - r, rect.bottom);
  ctx.lineTo(rect.x + r, rect.bottom);
  ctx.quadraticCurveTo(rect.x, rect.bottom, rect.x, rect.bottom - r);
  ctx.lineTo(rect.x, rect.y + r);
  ctx.quadraticCurveTo(rect.x, rect.y, rect.x + r, rect.y);
  ctx.closePath();
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

  /** Full-width rule at the current cursor position. */
  divider(ui, x2 = this.x + this.width, { alpha = 0.16, padding = 0 } = {}) {
    ui.divider(this.x + padding, x2 - padding, this.cursor);
    this.cursor += 12;
    return this;
  }

  get bottom() {
    return this.cursor;
  }
}
