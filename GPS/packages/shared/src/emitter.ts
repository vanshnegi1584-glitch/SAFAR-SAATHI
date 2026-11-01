// Minimal typed event emitter shared by the mock and live data sources.
export class Emitter<Events extends { [K in keyof Events]: (...args: any[]) => void }> {
  private handlers = new Map<keyof Events, Set<(...args: any[]) => void>>();

  on<E extends keyof Events>(event: E, handler: Events[E]): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler);
    this.handlers.set(event, set);
    return () => set.delete(handler);
  }

  emit<E extends keyof Events>(event: E, ...args: Parameters<Events[E]>): void {
    this.handlers.get(event)?.forEach((h) => h(...args));
  }

  clear(): void {
    this.handlers.clear();
  }
}
