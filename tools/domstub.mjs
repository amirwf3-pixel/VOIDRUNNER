/**
 * Minimal DOM / Canvas / Web Audio stub so the real game code can run in Node.
 *
 * This is not a browser emulator: it implements exactly the surface VOIDRUNNER
 * touches (canvas 2D context, event listeners, localStorage-shaped storage,
 * a silent Web Audio graph, rAF). Anything the game calls that is missing will
 * throw loudly, which is the point - the smoke test must exercise the real code.
 */

class StubClassList {
  constructor() {
    this.set = new Set();
  }

  add(...names) {
    for (const name of names) this.set.add(name);
  }

  remove(...names) {
    for (const name of names) this.set.delete(name);
  }

  contains(name) {
    return this.set.has(name);
  }

  toggle(name) {
    if (this.set.has(name)) this.set.delete(name);
    else this.set.add(name);
  }
}

class StubElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.classList = new StubClassList();
    this.listeners = new Map();
    this.parentElement = null;
    this.textContent = '';
    this.width = 300;
    this.height = 150;
    this.clientWidth = 300;
    this.clientHeight = 150;
  }

  getBoundingClientRect() {
    return { x: 0, y: 0, left: 0, top: 0, right: this.clientWidth, bottom: this.clientHeight, width: this.clientWidth, height: this.clientHeight };
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  dispatch(type, event = {}) {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const handler of Array.from(set)) handler(event);
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (this.parentElement) {
      const idx = this.parentElement.children.indexOf(this);
      if (idx >= 0) this.parentElement.children.splice(idx, 1);
    }
  }

  setPointerCapture() {}
  releasePointerCapture() {}
  focus() {}
}

/**
 * A canvas 2D context that records how many operations were issued and
 * implements every method the renderer uses. Gradient objects are stubs with
 * addColorStop.
 */
class StubContext2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.commandCount = 0;
    this.fillStyle = '#000';
    this.strokeStyle = '#000';
    this.lineWidth = 1;
    this.globalAlpha = 1;
    this.globalCompositeOperation = 'source-over';
    this.font = '10px sans-serif';
    this.textAlign = 'left';
    this.textBaseline = 'alphabetic';
    this.lineCap = 'butt';
    this.lineJoin = 'miter';
    this.letterSpacing = '0px';
    this.lineDashOffset = 0;
    this.imageSmoothingEnabled = true;
    this.shadowBlur = 0;
    this.shadowColor = 'transparent';
    this.miterLimit = 10;
  }

  _tick() {
    this.commandCount += 1;
  }

  save() { this._tick(); }
  restore() { this._tick(); }
  translate() { this._tick(); }
  rotate() { this._tick(); }
  scale() { this._tick(); }
  setTransform() { this._tick(); }
  resetTransform() { this._tick(); }
  transform() { this._tick(); }
  beginPath() { this._tick(); }
  closePath() { this._tick(); }
  moveTo() { this._tick(); }
  lineTo() { this._tick(); }
  arc() { this._tick(); }
  arcTo() { this._tick(); }
  ellipse() { this._tick(); }
  rect() { this._tick(); }
  quadraticCurveTo() { this._tick(); }
  bezierCurveTo() { this._tick(); }
  fill() { this._tick(); }
  stroke() { this._tick(); }
  clip() { this._tick(); }
  fillRect() { this._tick(); }
  strokeRect() { this._tick(); }
  clearRect() { this._tick(); }
  fillText() { this._tick(); }
  strokeText() { this._tick(); }
  setLineDash() { this._tick(); }
  getLineDash() { return []; }
  drawImage() { this._tick(); }
  createLinearGradient() {
    this._tick();
    return { addColorStop() {} };
  }
  createRadialGradient() {
    this._tick();
    return { addColorStop() {} };
  }
  createPattern() {
    this._tick();
    return null;
  }
  measureText(text) {
    return { width: String(text).length * 7 };
  }
  getImageData(x, y, w, h) {
    return { data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h };
  }
  putImageData() { this._tick(); }
  createImageData(w, h) {
    return { data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h };
  }
}

class StubCanvas extends StubElement {
  constructor(width = 1280, height = 720) {
    super('canvas');
    this.width = width;
    this.height = height;
    this.clientWidth = width;
    this.clientHeight = height;
    this._ctx = new StubContext2D(this);
  }

  getContext(type) {
    if (type !== '2d') return null;
    return this._ctx;
  }
}

class StubAudioParam {
  constructor(value = 0) {
    this.value = value;
  }

  setValueAtTime() { return this; }
  setTargetAtTime() { return this; }
  linearRampToValueAtTime() { return this; }
  exponentialRampToValueAtTime() { return this; }
  cancelScheduledValues() { return this; }
}

class StubAudioNode {
  constructor(kind = 'node') {
    this.kind = kind;
    this.gain = new StubAudioParam(1);
    this.frequency = new StubAudioParam(440);
    this.detune = new StubAudioParam(0);
    this.Q = new StubAudioParam(1);
    this.playbackRate = new StubAudioParam(1);
    this.type = 'sine';
    this.loop = false;
    this.buffer = null;
    this.onended = null;
  }

  connect(dest) {
    return dest;
  }

  disconnect() {}

  start() {}

  stop() {}
}

class StubAudioContext {
  constructor() {
    this.state = 'running';
    this.sampleRate = 44100;
    this.currentTime = 0;
    this.destination = new StubAudioNode('destination');
  }

  createGain() {
    return new StubAudioNode('gain');
  }

  createOscillator() {
    return new StubAudioNode('oscillator');
  }

  createBiquadFilter() {
    return new StubAudioNode('filter');
  }

  createBufferSource() {
    return new StubAudioNode('bufferSource');
  }

  createBuffer(channels, length, rate) {
    const data = new Float32Array(length);
    return {
      length,
      sampleRate: rate,
      numberOfChannels: channels,
      getChannelData: () => data,
    };
  }

  createStereoPanner() {
    return new StubAudioNode('panner');
  }

  createDelay() {
    return new StubAudioNode('delay');
  }

  createDynamicsCompressor() {
    return new StubAudioNode('compressor');
  }

  resume() {
    this.state = 'running';
    return Promise.resolve();
  }

  suspend() {
    this.state = 'suspended';
    return Promise.resolve();
  }

  close() {
    this.state = 'closed';
    return Promise.resolve();
  }
}

/**
 * Installs the stub environment on globalThis. Idempotent.
 * @returns {{canvas: StubCanvas, container: StubElement, window: Object, storage: Map}}
 */
export function installDom() {
  if (globalThis.__voidrunnerDom) return globalThis.__voidrunnerDom;

  const container = new StubElement('div');
  container.clientWidth = 1600;
  container.clientHeight = 900;
  const canvas = new StubCanvas(1600, 900);
  container.appendChild(canvas);

  const body = new StubElement('body');
  body.appendChild(container);

  const storage = new Map();
  const localStorageStub = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear(),
    key: (i) => Array.from(storage.keys())[i] ?? null,
    get length() {
      return storage.size;
    },
  };

  const documentStub = new StubElement('document');
  documentStub.readyState = 'complete';
  documentStub.hidden = false;
  documentStub.body = body;
  documentStub.documentElement = body;
  documentStub.createElement = (tag) => (tag === 'canvas' ? new StubCanvas() : new StubElement(tag));
  documentStub.getElementById = (id) => {
    if (id === 'game-canvas') return canvas;
    if (id === 'game-root') return container;
    return null;
  };
  documentStub.querySelector = () => null;

  const windowStub = {
    devicePixelRatio: 1,
    innerWidth: 1600,
    innerHeight: 900,
    AudioContext: StubAudioContext,
    webkitAudioContext: StubAudioContext,
    localStorage: localStorageStub,
    document: documentStub,
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    performance: { now: () => Date.now() },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
  };

  globalThis.window = windowStub;
  globalThis.document = documentStub;
  globalThis.localStorage = localStorageStub;
  globalThis.AudioContext = StubAudioContext;
  globalThis.HTMLCanvasElement = StubCanvas;
  globalThis.requestAnimationFrame = windowStub.requestAnimationFrame;
  globalThis.cancelAnimationFrame = windowStub.cancelAnimationFrame;
  globalThis.devicePixelRatio = 1;

  // The game uses `performance.now()` for frame timing.
  globalThis.performance = windowStub.performance;

  // Interval-based music/ambient scheduling must not keep Node alive.
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn, ms) => {
    const id = realSetInterval(fn, ms);
    if (id && typeof id.unref === 'function') id.unref();
    return id;
  };

  const env = { canvas, container, window: windowStub, storage: localStorageStub, document: documentStub };
  globalThis.__voidrunnerDom = env;
  return env;
}

export { StubCanvas, StubElement, StubContext2D, StubAudioContext };
