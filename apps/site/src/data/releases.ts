import { VERSION } from '../lib/downloads';

// Releases for /changelog and llms.txt, newest first.
export interface Release {
  v: string;
  title: string;
  points: string[];
}

export const releases: Release[] = [
  {
    v: VERSION,
    title: 'The rewrite',
    points: [
      'A new native macOS app. Every panel is a small JavaScript file and every theme is a file, so you or your agent can change any of it.',
      'Each person talks to their own Overseer. It plans, creates tasks, sends Claude Code or Codex, and flags you only when a task needs your input.',
      'Finished work lands as a GitHub pull request after your project’s own checks pass. Review comments on the pull request go back to the agent.',
      'Planning moves into the app: My week, Allocation, Projects, Timeline and Graph.',
      'Teams on a hosted server at team.dispatch.foo that stores only end-to-end encrypted data. Sign in with Linear.',
      'Two-way Linear sync.',
    ],
  },
];
