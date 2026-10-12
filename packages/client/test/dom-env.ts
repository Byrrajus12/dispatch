// Registers happy-dom for the one client test that renders hooks; imported first so it
// precedes @testing-library/react, and unregistered after so other files see plain Bun.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll } from 'bun:test';

GlobalRegistrator.register();

afterAll(async () => {
  const { cleanup } = await import('@testing-library/react');
  cleanup();
  await GlobalRegistrator.unregister();
});
