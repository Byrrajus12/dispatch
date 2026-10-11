import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  agentEnv,
  readAgentKeys,
  writeAgentKey,
} from '../src/setup/agentEnv.js';

let home: string;
const saved = {
  home: process.env.DISPATCH_HOME,
  openai: process.env.OPENAI_API_KEY,
  anthropic: process.env.ANTHROPIC_API_KEY,
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dispatch-agent-env-'));
  process.env.DISPATCH_HOME = home;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  for (const [k, v] of [
    ['DISPATCH_HOME', saved.home],
    ['OPENAI_API_KEY', saved.openai],
    ['ANTHROPIC_API_KEY', saved.anthropic],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

describe('agent API keys', () => {
  it('round-trips and clears a key', () => {
    writeAgentKey('ANTHROPIC_API_KEY', 'sk-ant-1');
    expect(readAgentKeys()).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-1' });
    writeAgentKey('ANTHROPIC_API_KEY', null);
    expect(readAgentKeys()).toEqual({});
  });

  it('refuses env vars no provider declares', () => {
    expect(() => writeAgentKey('PATH', 'x')).toThrow(/not an agent key/);
  });

  it('injects saved keys into agent env', () => {
    writeAgentKey('OPENAI_API_KEY', 'sk-openai');
    expect(agentEnv().OPENAI_API_KEY).toBe('sk-openai');
  });

  it('lets an explicit environment variable win over a saved key', () => {
    writeAgentKey('OPENAI_API_KEY', 'sk-saved');
    process.env.OPENAI_API_KEY = 'sk-env';
    expect(agentEnv().OPENAI_API_KEY).toBe('sk-env');
  });

  it('lets `extra` win over both', () => {
    writeAgentKey('OPENAI_API_KEY', 'sk-saved');
    expect(agentEnv({ OPENAI_API_KEY: 'sk-extra' }).OPENAI_API_KEY).toBe(
      'sk-extra'
    );
  });
});
