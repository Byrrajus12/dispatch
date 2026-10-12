import { afterEach, describe, expect, test } from 'bun:test';

import { browserStorage, memoryStorage } from '../src/storage';

const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

afterEach(() => {
  if (original !== undefined)
    Object.defineProperty(globalThis, 'localStorage', original);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});

function setLocalStorage(value: unknown) {
  Object.defineProperty(globalThis, 'localStorage', {
    value,
    configurable: true,
    writable: true,
  });
}

describe('memoryStorage', () => {
  test('round-trips a value and starts from its seed', () => {
    const store = memoryStorage({ a: '1' });
    expect(store.get('a')).toBe('1');
    store.set('b', '2');
    expect(store.get('b')).toBe('2');
    expect(store.get('missing')).toBeNull();
  });
});

describe('browserStorage', () => {
  test('without a localStorage, reads nothing and ignores writes', () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    const store = browserStorage();
    store.set('k', 'v');
    expect(store.get('k')).toBeNull();
  });

  test('a localStorage that throws reads as empty and never throws', () => {
    setLocalStorage({
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    const store = browserStorage();
    expect(() => store.set('k', 'v')).not.toThrow();
    expect(store.get('k')).toBeNull();
  });

  test('reads and writes through a working localStorage', () => {
    const backing = new Map<string, string>();
    setLocalStorage({
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => backing.set(k, v),
    });
    const store = browserStorage();
    store.set('k', 'v');
    expect(backing.get('k')).toBe('v');
    expect(store.get('k')).toBe('v');
  });
});
