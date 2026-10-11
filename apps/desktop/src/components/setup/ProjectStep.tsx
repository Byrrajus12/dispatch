import { useState } from 'react';

import {
  pickDirectory,
  prepareProjectFolder,
  projectFolderState,
} from '../../lib/tauri';
import { AddProjectDialog } from '../shell/AddProjectDialog';
import { SetupStepRow } from './SetupStepRow';
import { Button } from '@/ui/button';

interface ProjectStepProps {
  /** Disabled until git is ready: preparing a folder needs git and its identity. */
  enabled: boolean;
  /** A folder already open in this window that hasn't been set up yet. */
  projectPath: string | null;
  onProjectChosen: (path: string) => Promise<void>;
}

const basename = (p: string) => p.split('/').filter(Boolean).at(-1) ?? p;

/** Choose (or confirm) the project folder, make it a repo with a first snapshot, then hand it to the app. */
export function ProjectStep({
  enabled,
  projectPath,
  onProjectChosen,
}: ProjectStepProps) {
  const [pending, setPending] = useState<string | null>(projectPath);
  const [needsPrep, setNeedsPrep] = useState<'init' | 'snapshot' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [githubOpen, setGithubOpen] = useState(false);

  async function consider(path: string) {
    setError(null);
    setPending(path);
    const state = await projectFolderState(path);
    if (!state.isGitRepo) return setNeedsPrep('init');
    if (!state.hasCommits) return setNeedsPrep('snapshot');
    await finish(path);
  }

  async function finish(path: string) {
    setBusy(true);
    try {
      await onProjectChosen(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function prepare() {
    if (pending === null) return;
    setBusy(true);
    setError(null);
    try {
      await prepareProjectFolder(pending);
      setNeedsPrep(null);
      await finish(pending);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  if (!enabled)
    return (
      <SetupStepRow
        status="waiting"
        title="Your project"
        message="Next: pick the folder you want agents to work on."
      />
    );

  if (needsPrep !== null && pending !== null) {
    return (
      <SetupStepRow
        status="needs-action"
        title="Your project"
        message={
          needsPrep === 'init'
            ? `Dispatch keeps each agent's work on its own copy of ${basename(pending)}, so this folder needs version tracking. Turn it on? Private files like .env stay out.`
            : `${basename(pending)} needs a first saved snapshot before an agent can work on it.`
        }
        action={
          <Button onClick={() => void prepare()} disabled={busy}>
            {needsPrep === 'init'
              ? 'Turn on version tracking'
              : 'Save a first snapshot'}
          </Button>
        }
        {...(error === null ? {} : { detail: error })}
      />
    );
  }

  return (
    <>
      <SetupStepRow
        status="needs-action"
        title="Your project"
        message={
          pending === null
            ? 'Pick the folder you want agents to work on.'
            : `Set up ${basename(pending)} for Dispatch.`
        }
        action={
          pending === null ? (
            <>
              <Button
                onClick={() =>
                  void pickDirectory().then((p) =>
                    p === null ? undefined : consider(p)
                  )
                }
                disabled={busy}
              >
                Choose a folder
              </Button>
              <Button
                variant="outline"
                onClick={() => setGithubOpen(true)}
                disabled={busy}
              >
                From GitHub
              </Button>
            </>
          ) : (
            <Button onClick={() => void consider(pending)} disabled={busy}>
              Set up this folder
            </Button>
          )
        }
        {...(error === null ? {} : { detail: error })}
      />
      {githubOpen && (
        <AddProjectDialog
          initialMode="github"
          onAdd={async (path) => {
            setGithubOpen(false);
            await consider(path);
          }}
          onClose={() => setGithubOpen(false)}
        />
      )}
    </>
  );
}
