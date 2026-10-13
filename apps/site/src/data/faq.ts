// The home page's questions. The page renders them and its FAQPage structured
// data restates them, so search and AI answers quote the same words. Every
// answer restates something the site already says elsewhere.
export const homeFaq: [string, string][] = [
  [
    'What is Dispatch?',
    'Dispatch is a desktop app and shared task board for AI coding agents. You give agents tasks instead of chats, they work through them on your own machines, and you review and land what they produce.',
  ],
  [
    'Which AI coding agents work with Dispatch?',
    'Claude Code and Codex are built in, with live output, turn counts and spend. Gemini CLI, Cursor or any agent that speaks MCP connects through the one MCP server that dispatch init registers in your repo, and any CLI agent can be declared in config.',
  ],
  [
    'How is a task different from a chat with an agent?',
    'A task has an owner, a status, the files it may write and a definition of done. It survives the tab closing, so anyone can ask the board where work stands instead of pinging people.',
  ],
  [
    'How does Dispatch stop agents from breaking things?',
    'Every run works on its own branch in its own git worktree. A task lists the files it may write and anything else waits for your yes. Spend and turn caps per run and per milestone stop work when hit, and every change goes through review and a merge queue.',
  ],
  [
    'Does my code leave my machine?',
    'No. Runs use your machine, your checkout and your own agent and API key. Tasks live in your repo as markdown or SQLite with a git receipt log.',
  ],
  [
    'How much does Dispatch cost?',
    'It is free for up to three people with every feature, commercial use included. Teams of four or more need a license key.',
  ],
  [
    'What does Dispatch run on?',
    'macOS on Apple Silicon and Intel, installed from a DMG or with brew install --cask wsoule/tap/dispatch. Linux packages are on GitHub.',
  ],
];
