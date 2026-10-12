// One-sentence definitions for the words a new user meets first. The guide and the
// hover hints both read from here, so a word means the same thing everywhere.
export const GLOSSARY = {
  task: 'A piece of work written down so an agent can pick it up.',
  agent: 'The AI coding tool that does the work, such as Claude Code or Codex.',
  review:
    'Reading what the agent changed before any of it reaches your project.',
  land: "Adding an agent's finished changes to your project.",
  overseer:
    'An AI assistant that keeps an eye on all your work, answers questions about it and plans bigger jobs.',
  milestone:
    'A bigger goal split into tasks that agents work through in order.',
  mergeQueue:
    'The line finished work waits in to be added to your project, one change at a time.',
  comingIn:
    'What is waiting on you: questions from agents, drafts and messages.',
  goingOut:
    'Work that has left your hands: agents running and changes on their way into your project.',
} as const;

export type GlossaryKey = keyof typeof GLOSSARY;
