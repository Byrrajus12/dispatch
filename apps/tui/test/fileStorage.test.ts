import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fileStorage } from '../src/fileStorage';

const tempFile = () =>
  join(mkdtempSync(join(tmpdir(), 'tui-store-')), 'nested', 'tui.json');

describe('fileStorage', () => {
  test('persists a value across instances, creating the directory', () => {
    const path = tempFile();
    fileStorage(path).set('dispatch:model:overseer', 'claude-fable-5-1');
    expect(fileStorage(path).get('dispatch:model:overseer')).toBe(
      'claude-fable-5-1'
    );
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      'dispatch:model:overseer': 'claude-fable-5-1',
    });
  });

  test('a missing file reads as empty', () => {
    expect(fileStorage(tempFile()).get('k')).toBeNull();
  });

  test('a corrupt file reads as empty and is replaced on the next write', () => {
    const path = tempFile();
    fileStorage(path).set('a', '1');
    writeFileSync(path, '{not json');
    const store = fileStorage(path);
    expect(store.get('a')).toBeNull();
    store.set('b', '2');
    expect(fileStorage(path).get('b')).toBe('2');
  });
});
