/**
 * Minimal synchronous event bus. Systems talk through events instead of
 * importing each other, which keeps the dependency graph acyclic.
 *
 * Listener errors are surfaced (never swallowed) but do not stop the emitter:
 * we collect them, report them, then rethrow the first one after dispatch.
 */
export class EventBus {
  constructor({ onError = null } = {}) {
    this.listeners = new Map();
    this.onError = onError;
  }

  on(type, handler) {
    if (typeof handler !== 'function') {
      throw new TypeError(`EventBus.on("${type}") requires a function`);
    }
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(handler);
    return () => this.off(type, handler);
  }

  once(type, handler) {
    const dispose = this.on(type, (payload) => {
      dispose();
      handler(payload);
    });
    return dispose;
  }

  off(type, handler) {
    const set = this.listeners.get(type);
    if (set) set.delete(handler);
  }

  emit(type, payload) {
    const set = this.listeners.get(type);
    if (!set || set.size === 0) return;
    let firstError = null;
    for (const handler of Array.from(set)) {
      try {
        handler(payload);
      } catch (error) {
        if (!firstError) firstError = error;
        if (this.onError) this.onError(error, type);
        else console.error(`[EventBus] listener for "${type}" threw:`, error);
      }
    }
    if (firstError) throw firstError;
  }

  clear() {
    this.listeners.clear();
  }
}
