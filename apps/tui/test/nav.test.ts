import { describe, expect, test } from 'bun:test';

import {
  initialNav,
  type Key,
  type NavContext,
  navReducer,
  type NavState,
  resolveKey,
} from '../src/nav';

const key = (name: string, mods: Partial<Key> = {}): Key => ({
  name,
  ctrl: false,
  shift: false,
  ...mods,
});

const ctx = (over: Partial<NavContext> = {}): NavContext => ({
  wide: true,
  cards: 0,
  canCompose: true,
  lengths: { in: 3, out: 2, list: 5 },
  ...over,
});

const run = (
  keys: Key[],
  c: NavContext = ctx(),
  from: NavState = initialNav
): NavState =>
  keys.reduce((s, k) => {
    const action = resolveKey(s, k, c);
    return action === null ? s : navReducer(s, action, c);
  }, from);

describe('views', () => {
  test('1, 2 and 3 switch views', () => {
    expect(run([key('2')]).view).toBe('tasks');
    expect(run([key('3')]).view).toBe('runs');
    expect(run([key('3'), key('1')]).view).toBe('overseer');
  });

  test('phase-3 views say so instead of doing nothing', () => {
    expect(run([key('4')]).notice).toContain('phase 3');
    expect(run([key('p', { ctrl: true })]).notice).toContain('phase 3');
  });
});

describe('the composer', () => {
  test('i and / focus it; esc leaves it', () => {
    expect(run([key('i')]).composing).toBe(true);
    expect(run([key('/')]).composing).toBe(true);
    expect(run([key('i'), key('escape')]).composing).toBe(false);
  });

  test('while composing, letters belong to the input: y, n, q and 2 do nothing', () => {
    const composing = run([key('i')]);
    for (const name of ['y', 'n', 'q', '2', 'j', 'd']) {
      expect(resolveKey(composing, key(name), ctx({ cards: 1 }))).toBeNull();
    }
  });

  test('without the app token, i explains instead of opening the composer', () => {
    const readOnly = run([key('i')], ctx({ canCompose: false }));
    expect(readOnly.composing).toBe(false);
    expect(readOnly.notice).toContain('--ask-token');
  });

  test('i does nothing while an overlay hides the composer', () => {
    expect(resolveKey(run([key('?')]), key('i'), ctx())).toBeNull();
    const narrow = ctx({ wide: false });
    expect(resolveKey(run([key('[')], narrow), key('i'), narrow)).toBeNull();
  });

  test('ctrl+c still quits while composing', () => {
    expect(
      resolveKey(run([key('i')]), key('c', { ctrl: true }), ctx())
    ).toEqual({ type: 'quit' });
  });
});

describe('proposal cards', () => {
  test('y and n decide the focused card', () => {
    const c = ctx({ cards: 2 });
    const onCards = run([key('j')], c);
    expect(onCards.card).toBe(0);
    expect(resolveKey(onCards, key('y'), c)).toEqual({
      type: 'decide',
      card: 0,
      approve: true,
    });
    const second = run([key('j'), key('j')], c);
    expect(resolveKey(second, key('n'), c)).toEqual({
      type: 'decide',
      card: 1,
      approve: false,
    });
  });

  test('y does nothing when no card has focus', () => {
    expect(resolveKey(initialNav, key('y'), ctx({ cards: 2 }))).toBeNull();
    expect(resolveKey(initialNav, key('y'), ctx({ cards: 0 }))).toBeNull();
    const onList = run([key('2')]);
    expect(resolveKey(onList, key('y'), ctx({ cards: 2 }))).toBeNull();
  });

  test('the card cursor stays within the cards', () => {
    const c = ctx({ cards: 1 });
    expect(run([key('j'), key('j'), key('j')], c).card).toBe(0);
    expect(run([key('j'), key('k'), key('k')], c).card).toBeNull();
  });
});

describe('panes and lists', () => {
  test('tab cycles the Overseer columns and shift+tab goes back', () => {
    expect(run([key('tab')]).pane).toBe('out');
    expect(run([key('tab'), key('tab')]).pane).toBe('in');
    expect(run([key('tab', { shift: true })]).pane).toBe('in');
  });

  test('a narrow terminal keeps focus on the conversation; [ and ] open overlays', () => {
    const narrow = ctx({ wide: false });
    expect(run([key('tab')], narrow).pane).toBe('conversation');
    expect(run([key('[')], narrow).overlay).toBe('in');
    expect(run([key(']')], narrow).overlay).toBe('out');
    expect(run([key(']'), key('escape')], narrow).overlay).toBeNull();
  });

  test('j and k move within the focused list and stop at its ends', () => {
    const tasks = run([key('2'), key('j'), key('j')]);
    expect(tasks.cursor.list).toBe(2);
    expect(run([key('2'), key('k')]).cursor.list).toBe(0);
    expect(
      run([key('2'), ...Array.from({ length: 9 }, () => key('j'))]).cursor.list
    ).toBe(4);
  });

  test('d opens the diff only in Runs', () => {
    expect(run([key('3'), key('d')]).diff).toBe(true);
    expect(run([key('d')]).diff).toBe(false);
    expect(run([key('3'), key('d'), key('escape')]).diff).toBe(false);
  });

  test('? toggles help and q quits outside the composer', () => {
    expect(run([key('?')]).overlay).toBe('help');
    expect(run([key('?'), key('?')]).overlay).toBeNull();
    expect(resolveKey(initialNav, key('q'), ctx())).toEqual({ type: 'quit' });
  });
});
