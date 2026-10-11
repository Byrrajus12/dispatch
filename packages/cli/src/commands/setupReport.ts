import type { SetupReport, SetupStep } from '@dispatch-foo/core';

const TITLES: Record<SetupStep['id'], string> = {
  git: 'Git',
  project: 'Your project',
  agent: 'Your AI agent',
};
const MARKS: Record<SetupStep['status'], string> = {
  ok: '✓',
  unknown: '?',
  'needs-action': '✗',
  missing: '✗',
};

// Human-readable `doctor --setup`: one line per step with its fix, then each installed agent.
export function formatSetupReport(report: SetupReport): string[] {
  const lines = ['Setup'];
  for (const step of report.steps) {
    lines.push(`  ${MARKS[step.status]} ${TITLES[step.id]} — ${step.message}`);
    if (step.fix?.kind === 'run') {
      lines.push(`      Fix: ${step.fix.command.join(' ')}`);
    } else if (step.fix?.kind === 'open-url') {
      lines.push(`      Fix: ${step.fix.href}`);
    } else if (step.fix?.kind === 'git-identity') {
      lines.push(
        '      Fix: git config --global user.name "Your Name" && git config --global user.email you@example.com'
      );
    } else if (step.fix?.kind === 'install-git') {
      lines.push(
        '      Fix: xcode-select --install (macOS) or your package manager'
      );
    } else if (step.fix?.kind === 'prepare-folder') {
      lines.push(
        '      Fix: git init && git add -A && git commit -m "Start tracking with Dispatch"'
      );
    }
  }
  const installed = report.providers.filter((p) => p.installed);
  if (installed.length > 0) {
    lines.push('', 'Agents');
    for (const p of installed) {
      const name =
        p.id === report.defaultProvider ? `${p.name} (default)` : p.name;
      const state = !p.works
        ? `installed, but won't start${p.detail === undefined ? '' : `: ${p.detail}`}`
        : p.usingApiKey
          ? 'using an API key'
          : p.auth === 'signed-in'
            ? 'signed in'
            : p.auth === 'signed-out'
              ? 'signed out'
              : "installed (sign-in can't be checked)";
      lines.push(`  ${p.ready ? '✓' : '·'} ${name} — ${state}`);
    }
  }
  return lines;
}
