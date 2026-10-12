/** Device-local key/value storage, so client logic runs the same in a browser, Tauri or a terminal. */
export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** An in-memory store: tests, and hosts with nowhere to persist. */
export function memoryStorage(
  seed: Record<string, string> = {}
): KeyValueStore {
  const values = new Map(Object.entries(seed));
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => {
      values.set(key, value);
    },
  };
}

/** `localStorage`, read lazily; missing or throwing storage reads as empty and drops writes. */
export function browserStorage(): KeyValueStore {
  const local = (): Storage | undefined =>
    (globalThis as { localStorage?: Storage }).localStorage;
  return {
    get: (key) => {
      try {
        return local()?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    set: (key, value) => {
      try {
        local()?.setItem(key, value);
      } catch {
        // A locked-down webview refuses storage; the choice just won't persist.
      }
    },
  };
}
