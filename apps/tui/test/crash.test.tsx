import { testRender } from '@opentui/react/test-utils';
import { expect, test } from 'bun:test';

import { CrashGuard } from '../src/CrashGuard';

function Boom(): never {
  throw new Error('render went wrong');
}

test('a render crash shows the error and q still quits', async () => {
  const quit: string[] = [];
  const t = await testRender(
    <CrashGuard onQuit={() => quit.push('quit')}>
      <Boom />
    </CrashGuard>,
    { width: 80, height: 10 }
  );
  const settle = () => new Promise((r) => setTimeout(r, 30));
  await settle();
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain('render went wrong');
  t.mockInput.pressKey('q');
  await settle();
  expect(quit).toEqual(['quit']);
  t.renderer.destroy();
});
