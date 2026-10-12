import { describe, expect, it } from 'bun:test';

import {
  providerById,
  providerForBinary,
  PROVIDERS,
  resolveInstallFix,
} from '../src/setup/providers.js';
import { CLI_AGENT_PRESET_BINARIES_FOR_TEST } from './setupFixtures.js';

describe('provider catalog', () => {
  it('covers claude, codex and every CLI preset binary', () => {
    const binaries = PROVIDERS.map((p) => p.binary);
    for (const b of [
      'claude',
      'codex',
      ...CLI_AGENT_PRESET_BINARIES_FOR_TEST,
    ]) {
      expect(binaries).toContain(b);
    }
  });

  it('gives every provider at least one install method ending in a url fallback', () => {
    for (const p of PROVIDERS) {
      expect(p.install.length).toBeGreaterThan(0);
      expect(p.install.at(-1)?.kind).toBe('url');
    }
  });

  it('marks claude and codex as able to plan and oversee, every CLI agent as execute-only', () => {
    const planners = PROVIDERS.filter((p) => p.capabilities.plan).map(
      (p) => p.id
    );
    const overseers = PROVIDERS.filter((p) => p.capabilities.oversee).map(
      (p) => p.id
    );
    expect(planners).toEqual(['claude', 'codex']);
    expect(overseers).toEqual(['claude', 'codex']);
    for (const p of PROVIDERS) expect(p.capabilities.execute).toBe(true);
  });

  it('parses claude auth status json', () => {
    const check = providerById('claude')!.authCheck!;
    expect(
      check.parse({ status: 0, stdout: '{"loggedIn":true}', stderr: '' })
    ).toBe('signed-in');
    expect(
      check.parse({ status: 0, stdout: '{"loggedIn":false}', stderr: '' })
    ).toBe('signed-out');
    expect(check.parse({ status: 0, stdout: 'garbage', stderr: '' })).toBe(
      'unknown'
    );
    // What a signed-out Claude Code really does: the JSON, with exit code 1.
    expect(
      check.parse({ status: 1, stdout: '{"loggedIn":false}', stderr: '' })
    ).toBe('signed-out');
    expect(check.parse({ status: 1, stdout: '', stderr: 'boom' })).toBe(
      'unknown'
    );
  });

  it('reads codex login status from the exit code', () => {
    const check = providerById('codex')!.authCheck!;
    expect(
      check.parse({ status: 0, stdout: 'Logged in using ChatGPT', stderr: '' })
    ).toBe('signed-in');
    expect(
      check.parse({ status: 1, stdout: 'Not logged in', stderr: '' })
    ).toBe('signed-out');
    expect(
      check.parse({ status: null, stdout: '', stderr: '', error: 'timeout' })
    ).toBe('unknown');
  });

  it('finds a provider by binary', () => {
    expect(providerForBinary('cursor-agent')?.id).toBe('cursor-agent');
    expect(providerForBinary('nope')).toBeUndefined();
  });
});

describe('resolveInstallFix', () => {
  const claude = providerById('claude')!;
  const codex = providerById('codex')!;

  it('prefers a script installer when curl and bash exist', () => {
    expect(
      resolveInstallFix(claude, (b) => b === 'curl' || b === 'bash')
    ).toEqual({
      kind: 'run',
      label: 'Install Claude Code',
      command: ['bash', '-c', 'curl -fsSL https://claude.ai/install.sh | bash'],
    });
  });

  it('uses brew before npm when both exist', () => {
    expect(resolveInstallFix(codex, () => true)).toEqual({
      kind: 'run',
      label: 'Install Codex',
      command: ['brew', 'install', '--cask', 'codex'],
    });
  });

  it('falls back to npm, then to the website', () => {
    expect(resolveInstallFix(codex, (b) => b === 'npm')).toEqual({
      kind: 'run',
      label: 'Install Codex',
      command: ['npm', 'install', '-g', '@openai/codex'],
    });
    expect(resolveInstallFix(codex, () => false).kind).toBe('open-url');
  });
});
