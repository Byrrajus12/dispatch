// Every app screenshot on the site, by slot. Each slot is a set of files in
// public/shots/: `<file>-light-<w>.webp` and `<file>-dark-<w>.webp` at 900 and
// 1600 pixels wide (dark only when `darkOnly`). To swap a picture, replace its
// files and update its size and alt text here.
export interface Shot {
  file: string;
  width: number;
  height: number;
  alt: string;
  darkOnly?: boolean;
}

export const WIDTHS = [900, 1600] as const;

export const shots = {
  // The home page hero: the Overseer flagging a task that needs you.
  hero: {
    file: 'overseer',
    width: 1600,
    height: 979,
    alt: 'Dispatch with the Overseer conversation in the middle. On the left, Needs you lists a tool approval with Approve, Approve session and Deny, and a run ready to merge. On the right, Going out lists one run ready to land and one still working.',
  },
  // A finished run: its log, the reviewer's note, the diff and Merge.
  run: {
    file: 'run',
    width: 1600,
    height: 996,
    alt: 'A run opened in the middle of Dispatch: what the agent did step by step, an approval you answered, the review, the changed files with their diff, and a Ready to merge box with Merge and Dismiss.',
  },
  // The board, one of the panels people change.
  board: {
    file: 'board',
    width: 1600,
    height: 979,
    alt: 'The board in Dispatch: tasks listed by status, with Needs you on the left and Going out on the right.',
  },
  // A teammate's window: their agents show under Sessions.
  team: {
    file: 'team',
    width: 1600,
    height: 979,
    alt: "Bob's Dispatch, with his teammate Ada's two agents listed under Sessions, Teammates: one blocked waiting on her, one working.",
    darkOnly: true,
  },
  week: {
    file: 'week',
    width: 1600,
    height: 980,
    alt: 'My week: one person’s open tasks this week and later, grouped by milestone, against their capacity in points.',
  },
  allocation: {
    file: 'allocation',
    width: 1600,
    height: 980,
    alt: 'Allocation: a preview of which unassigned tasks would go to whom, each person’s load against capacity, and an Allocate button.',
  },
  projects: {
    file: 'projects',
    width: 1600,
    height: 980,
    alt: 'Projects: each project and milestone with its lead, dates, standing and progress, beside a list of warnings such as slipping milestones and missing leads.',
  },
  timeline: {
    file: 'timeline',
    width: 1600,
    height: 980,
    alt: 'Timeline: projects and milestones as bars across the coming weeks, with a line for today and labels for what is at risk or overdue.',
  },
  graph: {
    file: 'graph',
    width: 1600,
    height: 980,
    alt: 'Graph: initiatives, projects, milestones and tasks in columns, with lines for what blocks what.',
  },
} satisfies Record<string, Shot>;

export type ShotName = keyof typeof shots;
