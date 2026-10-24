/** Typed, decoupled publish/subscribe channel between game systems. */
export interface GameEvents {
  'enemy:killed': { x: number; y: number; z: number; points: number; kind: string };
  'enemy:hit': { x: number; y: number; z: number };
  'player:fire': { heat: number };
  'player:hit': { damage: number; hp: number };
  'player:dash': { x: number; y: number };
  'player:died': Record<string, never>;
  'player:overheat': Record<string, never>;
  'boss:spawn': { name: string; maxHp: number };
  'boss:phase': { phase: number };
  'boss:killed': { x: number; y: number; z: number };
  'sector:clear': { sector: number };
  'synergy:unlocked': { name: string };
  explosion: { x: number; y: number; z: number; size: number };
  'chain:arc': { count: number };
}

type Handler<T> = (payload: T) => void;

export class EventBus<E> {
  private handlers = new Map<keyof E, Set<Handler<never>>>();

  on<K extends keyof E>(type: K, fn: Handler<E[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(fn as Handler<never>);
    return () => this.off(type, fn);
  }

  off<K extends keyof E>(type: K, fn: Handler<E[K]>): void {
    this.handlers.get(type)?.delete(fn as Handler<never>);
  }

  emit<K extends keyof E>(type: K, payload: E[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const fn of set) (fn as Handler<E[K]>)(payload);
  }
}

export const bus = new EventBus<GameEvents>();
