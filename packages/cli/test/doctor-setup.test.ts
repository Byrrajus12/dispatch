import type { SetupReport } from '@dispatch-foo/core';
import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { formatSetupReport } from '../src/commands/setupReport.js';
import { makeProgram } from '../src/program.js';

const REPORT: SetupReport = {
  defaultProvider: 'claude',
  steps: [
    {
      id: 'git',
      status: 'ok',
      message: 'Git is installed and knows who you are.',
    },
    {
      id: 'agent',
      status: 'needs-action',
      message: "Claude Code isn't signed in.",
      fix: {
        kind: 'run',
        label: 'Sign in',
        command: ['claude', 'auth', 'login'],
      },
    },
  ],
  providers: [
    {
      id: 'claude',
      name: 'Claude Code',
      blurb: '',
      installed: true,
      works: true,
      auth: 'signed-out',
      usingApiKey: false,
      ready: false,
      capabilities: { execute: true, plan: true, oversee: true },
    },
    {
      id: 'codex',
      name: 'Codex',
      blurb: '',
      installed: true,
      works: false,
      auth: 'unknown',
      usingApiKey: false,
      ready: false,
      capabilities: { execute: true, plan: false, oversee: false },
      detail: 'spawn ENOENT',
    },
    {
      id: 'gemini',
      name: 'Gemini CLI',
      blurb: '',
      installed: false,
      works: false,
      auth: 'unknown',
      usingApiKey: false,
      ready: false,
      capabilities: { execute: true, plan: false, oversee: false },
    },
  ],
};

describe('formatSetupReport', () => {
  it('prints steps with their fix commands and every installed agent', () => {
    const text = formatSetupReport(REPORT).join('\n');
    expect(text).toContain('✓ Git');
    expect(text).toContain("✗ Your AI agent — Claude Code isn't signed in.");
    expect(text).toContain('Fix: claude auth login');
    expect(text).toContain('Claude Code (default) — signed out');
    expect(text).toContain("Codex — installed, but won't start: spawn ENOENT");
    expect(text).not.toContain('Gemini');
  });
});

describe('doctor --setup --json', () => {
  it('prints a setup report outside any project', async () => {
    const out: string[] = [];
    const cwd = mkdtempSync(join(tmpdir(), 'dispatch-no-project-'));
    try {
      await makeProgram({ cwd, log: (l) => out.push(l) }).parseAsync(
        ['doctor', '--setup', '--json'],
        { from: 'user' }
      );
    } catch {
      // A machine missing something exits non-zero; the JSON is still printed.
    }
    const report = JSON.parse(out.join('\n')) as SetupReport;
    expect(report.steps.map((s) => s.id)).toEqual(['git', 'agent']);
  });
});
