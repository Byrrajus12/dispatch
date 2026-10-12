import { describe, expect, it } from 'bun:test';

import {
  codexApprovalNeedsHuman,
  codexCommandFloor,
  readCodexCommand,
} from '../../src/orchestrator/codexCommand.js';

describe('reading a Codex command', () => {
  it('reads the script a shell wrapper runs, from a string or an argv', () => {
    expect(readCodexCommand("/bin/zsh -lc 'pnpm test'")).toEqual({
      text: 'pnpm test',
      simple: true,
    });
    expect(readCodexCommand(['/bin/zsh', '-lc', 'pnpm test'])).toEqual({
      text: 'pnpm test',
      simple: true,
    });
    expect(readCodexCommand(null)).toBeUndefined();
    expect(readCodexCommand("/bin/zsh -lc '$(echo gh) release'")?.simple).toBe(
      false
    );
  });

  it('finds a floor command behind a wrapper, an argv or split quotes', () => {
    expect(codexCommandFloor("/bin/zsh -lc 'gh release create v1'")).toBe(
      'publish'
    );
    expect(codexCommandFloor(['/bin/zsh', '-lc', 'npm publish'])).toBe(
      'publish'
    );
    expect(codexCommandFloor(`/bin/zsh -lc "g''h release create v1"`)).toBe(
      'publish'
    );
    expect(codexCommandFloor("/bin/zsh -lc 'pnpm test'")).toBeNull();
  });
});

describe('the policy answering a run approval', () => {
  it('leaves a Codex command to a human when it trips the floor or hides what runs', () => {
    const asks = (command: unknown) =>
      codexApprovalNeedsHuman('codex.commandExecution', { command });
    expect(asks("/bin/zsh -lc 'pnpm test'")).toBe(false);
    expect(asks("/bin/zsh -lc 'gh release create v1'")).toBe(true);
    expect(asks(['/bin/zsh', '-lc', 'npm publish'])).toBe(true);
    expect(asks('/bin/zsh -lc \'eval "$X"\'')).toBe(true);
    expect(asks("/bin/zsh -lc '`echo gh` release create'")).toBe(true);
    expect(asks(null)).toBe(true);
  });

  // The run relaxation covers shell syntax only, never a stdin ask or an escalation.
  it('leaves stdin and permission or network escalations to a human, however plain the command', () => {
    const asks = (extra: Record<string, unknown>) =>
      codexApprovalNeedsHuman('codex.commandExecution', {
        command: "/bin/zsh -lc 'pnpm test'",
        ...extra,
      });
    expect(asks({})).toBe(false);
    expect(asks({ kind: 'writeStdin' })).toBe(true);
    expect(
      asks({ additionalPermissions: { network: { enabled: true } } })
    ).toBe(true);
    expect(asks({ networkApprovalContext: { host: 'x' } })).toBe(true);
    expect(asks({ proposedExecpolicyAmendment: ['pnpm'] })).toBe(true);
    expect(asks({ proposedNetworkPolicyAmendments: [] })).toBe(true);
    expect(asks({ additionalPermissions: null })).toBe(false);
    expect(codexApprovalNeedsHuman('codex.commandExecution', null)).toBe(true);
  });

  it('says nothing about other tools', () => {
    expect(codexApprovalNeedsHuman('Bash', { command: 'eval "$X"' })).toBe(
      false
    );
    expect(codexApprovalNeedsHuman('codex.fileChange', { paths: [] })).toBe(
      false
    );
  });
});
