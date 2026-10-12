import type { KeyValueStore } from '@dispatch/client';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Reads the whole file; a missing or corrupt one is an empty store.
function readAll(path: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

/** A JSON file as the TUI's device storage (the browser's localStorage counterpart). */
export function fileStorage(path: string): KeyValueStore {
  return {
    get: (key) => readAll(path)[key] ?? null,
    set: (key, value) => {
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(
          path,
          `${JSON.stringify({ ...readAll(path), [key]: value }, null, 2)}\n`
        );
      } catch {
        // A read-only home only costs the memory of the pick.
      }
    },
  };
}
