/**
 * Camera: follow, look-ahead, shake, recoil kick and world<->screen transforms.
 * Shake is additive and decays exponentially so overlapping hits stay readable.
 */

import { clamp, damp, lerp } from '../core/math.js';

export class Camera {
  constructor({ width = 1280, height = 720 } = {}) {
    this.x = 0;
    this.y = 0;
    this.width = width;
    this.height = height;
    this.zoom = 1;
    this.targetZoom = 1;
    this.bounds = null;
    this.shakeAmount = 0;
    this.shakeDecay = 6.5;
    this.shakeOffsetX = 0;
    this.shakeOffsetY = 0;
    this.kickX = 0;
    this.kickY = 0;
    this.lookAhead = { x: 0, y: 0 };
    this._shakeSeed = 1;
    this._shakeTime = 0;
    this._trauma = 0;
  }

  setViewport(width, height) {
    this.width = width;
    this.height = height;
  }

  setBounds(bounds) {
    this.bounds = bounds;
  }

  /** Adds trauma in the [0, 2] range; larger hits read as heavier. */
  addShake(amount) {
    this._trauma = clamp(this._trauma + amount, 0, 2.4);
  }

  addKick(x, y) {
    this.kickX += x;
    this.kickY += y;
  }

  snapTo(x, y) {
    this.x = x;
    this.y = y;
    this.lookAhead.x = 0;
    this.lookAhead.y = 0;
  }

  /**
   * @param {number} dt
   * @param {{x:number,y:number}} target
   * @param {{x:number,y:number}} aimDir normalised aim direction
   * @param {number} shakeScale user setting (0 disables shake entirely)
   */
  update(dt, target, aimDir = { x: 0, y: 0 }, shakeScale = 1) {
    const smooth = 0.0009;
    const desiredLookX = aimDir.x * 90;
    const desiredLookY = aimDir.y * 90;
    this.lookAhead.x = damp(this.lookAhead.x, desiredLookX, 0.002, dt);
    this.lookAhead.y = damp(this.lookAhead.y, desiredLookY, 0.002, dt);

    const desiredX = target.x + this.lookAhead.x;
    const desiredY = target.y + this.lookAhead.y;
    this.x = damp(this.x, desiredX, smooth, dt);
    this.y = damp(this.y, desiredY, smooth, dt);
    this.zoom = damp(this.zoom, this.targetZoom, 0.004, dt);

    // Recoil kick springs back to zero.
    this.kickX = damp(this.kickX, 0, 0.00002, dt);
    this.kickY = damp(this.kickY, 0, 0.00002, dt);

    this._trauma = Math.max(0, this._trauma - this.shakeDecay * dt);
    this._shakeTime += dt;
    const magnitude = this._trauma * this._trauma * 18 * clamp(shakeScale, 0, 2);
    this._shakeSeed = Math.sin(this._shakeTime * 71.3) * 43758.5453;
    const rx = (this._shakeSeed - Math.floor(this._shakeSeed)) * 2 - 1;
    const ry = (Math.sin(this._shakeTime * 53.7 + 1.3) * 24634.6345) % 1;
    this.shakeOffsetX = magnitude * rx;
    this.shakeOffsetY = magnitude * (ry * 2 - 1);
    if (this._trauma <= 0.0001) {
      this.shakeOffsetX = 0;
      this.shakeOffsetY = 0;
    }

    if (this.bounds) {
      const halfW = this.width / (2 * this.zoom);
      const halfH = this.height / (2 * this.zoom);
      const minX = this.bounds.x + halfW;
      const maxX = this.bounds.x + this.bounds.w - halfW;
      const minY = this.bounds.y + halfH;
      const maxY = this.bounds.y + this.bounds.h - halfH;
      this.x = minX > maxX ? this.bounds.x + this.bounds.w / 2 : clamp(this.x, minX, maxX);
      this.y = minY > maxY ? this.bounds.y + this.bounds.h / 2 : clamp(this.y, minY, maxY);
    }
  }

  get renderX() {
    return this.x + this.shakeOffsetX + this.kickX;
  }

  get renderY() {
    return this.y + this.shakeOffsetY + this.kickY;
  }

  get shakeIntensity() {
    return this._trauma;
  }

  worldToScreen(wx, wy) {
    return {
      x: (wx - this.renderX) * this.zoom + this.width / 2,
      y: (wy - this.renderY) * this.zoom + this.height / 2,
    };
  }

  screenToWorld(sx, sy) {
    return {
      x: (sx - this.width / 2) / this.zoom + this.renderX,
      y: (sy - this.height / 2) / this.zoom + this.renderY,
    };
  }

  /** Visible world rect, padded by `pad` world units. */
  visibleRect(pad = 64) {
    const halfW = this.width / (2 * this.zoom);
    const halfH = this.height / (2 * this.zoom);
    return {
      x: this.renderX - halfW - pad,
      y: this.renderY - halfH - pad,
      w: halfW * 2 + pad * 2,
      h: halfH * 2 + pad * 2,
    };
  }

  /** Applies the camera transform to a 2D context (call inside save/restore). */
  applyTransform(ctx) {
    ctx.translate(this.width / 2, this.height / 2);
    ctx.scale(this.zoom, this.zoom);
    ctx.translate(-this.renderX, -this.renderY);
  }

  lerpToZoom(target, speedFactor = 0.1) {
    this.targetZoom = lerp(this.targetZoom, target, speedFactor);
  }
}
