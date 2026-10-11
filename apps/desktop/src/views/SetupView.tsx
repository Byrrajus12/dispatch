import { type ReactNode, useCallback, useState } from 'react';

import { GitStep } from '../components/setup/GitStep';
import { ProjectStep } from '../components/setup/ProjectStep';
import { SetupStepRow } from '../components/setup/SetupStepRow';

interface SetupViewProps {
  /** The open folder when it isn't set up yet; null on a first launch with no project. */
  projectPath: string | null;
  onProjectChosen: (path: string) => Promise<void>;
  /** The agent step, rendered by App once a project (and its daemon) exists. */
  agentStep?: ReactNode;
}

/**
 * First-launch setup: Git, then your project, then your AI agent. Everything a new
 * user needs before their first task, each with its own fix button.
 */
export function SetupView({
  projectPath,
  onProjectChosen,
  agentStep,
}: SetupViewProps) {
  const [gitReady, setGitReady] = useState(false);
  const onGitReady = useCallback((ready: boolean) => setGitReady(ready), []);
  return (
    <div className="flex h-full min-h-0 flex-col items-center overflow-y-auto px-6 py-12">
      <div className="flex w-full max-w-xl flex-col gap-1">
        <h1 className="text-lg font-medium">Welcome to Dispatch</h1>
        <p className="text-text-secondary text-sm">
          A few things and you're ready to hand work to an AI agent.
        </p>
        <div className="mt-4">
          <GitStep onReady={onGitReady} />
          {agentStep === undefined ? (
            <>
              <ProjectStep
                enabled={gitReady}
                projectPath={projectPath}
                onProjectChosen={onProjectChosen}
              />
              <SetupStepRow
                status="waiting"
                title="Your AI agent"
                message="Then: choose the AI agent that does the work."
              />
            </>
          ) : (
            <>
              <SetupStepRow
                status="ok"
                title="Your project"
                message="Your project is ready."
              />
              {agentStep}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
