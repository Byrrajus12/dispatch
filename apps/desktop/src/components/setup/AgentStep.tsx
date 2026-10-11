import type { ProviderState, SetupFix } from '@dispatch-foo/core/browser';
import type { ApiClient } from '@dispatch/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { openUrl } from '../../lib/tauri';
import { CommandTerminal } from './CommandTerminal';
import { DetailsDisclosure } from './DetailsDisclosure';
import { SetupStepRow } from './SetupStepRow';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { RadioGroup, RadioGroupItem } from '@/ui/radio-group';

interface AgentStepProps {
  client: ApiClient;
  /** Persists the chosen provider as the project's default agent. */
  onSetDefault: (providerId: string) => Promise<unknown>;
  onContinue: () => void;
}

type Running = {
  providerId: string;
  fix: Extract<SetupFix, { kind: 'run' }>;
  title: string;
};

/** A plain sentence for the screen plus the raw reason for the Details disclosure. */
type Problem = { sentence: string; detail: string };

// Tauri rejects with plain strings, the daemon client with Errors.
function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : 'Unknown error';
}

function problemOf(sentence: string, err: unknown): Problem {
  return { sentence, detail: errorText(err) };
}

function stateLabel(p: ProviderState): string {
  if (!p.installed) return 'Not installed';
  if (!p.works) return "Won't start";
  if (p.usingApiKey) return 'Using an API key';
  if (p.auth === 'signed-in') return 'Signed in';
  if (p.auth === 'signed-out') return 'Signed out';
  return 'Installed';
}

/** Pick an agent, install it, sign in (or paste a key), and continue. Works for every catalog provider. */
export function AgentStep({
  client,
  onSetDefault,
  onContinue,
}: AgentStepProps) {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ['setup', 'report'],
    queryFn: () => client.fetchSetup(),
  });
  const [chosen, setChosen] = useState<string | null>(null);
  const [running, setRunning] = useState<Running | null>(null);
  const [keyFor, setKeyFor] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const [problem, setProblem] = useState<Problem | null>(null);

  if (data === undefined) {
    return (
      <SetupStepRow
        status="checking"
        title="Your AI agent"
        message="Checking…"
      />
    );
  }

  const step = data.steps.find((s) => s.id === 'agent');
  if (step === undefined) return null;
  const selected = chosen ?? data.defaultProvider;
  const ordered = [...data.providers].sort(
    (a, b) =>
      Number(b.ready) - Number(a.ready) ||
      Number(b.installed) - Number(a.installed)
  );
  const canContinue = step.status === 'ok' || step.status === 'unknown';

  // Re-reads the machine after an install or sign-in so the row reflects it.
  async function recheck() {
    try {
      await client.refreshSetup();
      await queryClient.invalidateQueries({ queryKey: ['setup', 'report'] });
    } catch (err) {
      setProblem(problemOf("Couldn't re-check your agents.", err));
    }
  }

  function act(p: ProviderState, fix: SetupFix) {
    setChosen(p.id);
    setProblem(null);
    if (fix.kind === 'run') {
      setRunning({
        providerId: p.id,
        fix,
        title: fix.label === 'Sign in' ? `Sign in to ${p.name}` : fix.label,
      });
    } else if (fix.kind === 'open-url') {
      openUrl(fix.href).catch((err: unknown) =>
        setProblem(problemOf("Couldn't open the download page.", err))
      );
    }
  }

  async function saveKey(p: ProviderState) {
    setProblem(null);
    try {
      const next = await client.saveAgentKey(p.id, key);
      queryClient.setQueryData(['setup', 'report'], next);
      setKeyFor(null);
      setKey('');
    } catch (err) {
      setProblem(
        problemOf("Couldn't save that key. Check it and try again.", err)
      );
    }
  }

  async function proceed() {
    setProblem(null);
    try {
      if (selected !== null) await onSetDefault(selected);
      onContinue();
    } catch (err) {
      setProblem(problemOf("Couldn't save your choice. Try again.", err));
    }
  }

  return (
    <SetupStepRow
      status={step.status}
      title="Your AI agent"
      message={step.message}
      action={
        <Button disabled={!canContinue} onClick={() => void proceed()}>
          Continue
        </Button>
      }
      {...(step.detail === undefined ? {} : { detail: step.detail })}
    >
      {problem !== null && (
        <div className="flex flex-col gap-1">
          <p className="text-sm text-(--state-error-fg)" role="alert">
            {problem.sentence}
          </p>
          <DetailsDisclosure text={problem.detail} />
        </div>
      )}
      <RadioGroup
        value={selected ?? ''}
        onValueChange={(value) => setChosen(String(value))}
        className="flex flex-col gap-2"
      >
        {ordered.map((p) => (
          <div
            key={p.id}
            className="border-border flex flex-col gap-2 rounded-md border p-3"
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem
                value={p.id}
                aria-label={`Use ${p.name}`}
                disabled={!p.installed}
              />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium">{p.name}</span>
                <span className="text-muted-foreground text-xs">{p.blurb}</span>
              </div>
              <Badge variant={p.ready ? 'secondary' : 'outline'}>
                {stateLabel(p)}
              </Badge>
              {p.install !== undefined && (
                <Button
                  size="sm"
                  onClick={() => p.install && act(p, p.install)}
                >
                  {p.install.label}
                </Button>
              )}
              {p.installed && p.works && !p.ready && p.signIn !== undefined && (
                <Button size="sm" onClick={() => p.signIn && act(p, p.signIn)}>
                  Sign in
                </Button>
              )}
            </div>
            {running?.providerId === p.id && (
              <CommandTerminal
                key={running.fix.command.join(' ')}
                client={client}
                command={running.fix.command}
                title={running.title}
                onExit={() => {
                  setRunning(null);
                  void recheck();
                }}
              />
            )}
            {p.apiKeyEnv !== undefined &&
              p.installed &&
              !p.usingApiKey &&
              (keyFor === p.id ? (
                <div className="flex items-end gap-2">
                  <div className="flex flex-1 flex-col gap-1">
                    <Label htmlFor={`key-${p.id}`}>{p.name} API key</Label>
                    <Input
                      id={`key-${p.id}`}
                      type="password"
                      value={key}
                      onChange={(e) => setKey(e.target.value)}
                    />
                  </div>
                  <Button
                    size="sm"
                    disabled={key.trim() === ''}
                    onClick={() => void saveKey(p)}
                  >
                    Save key
                  </Button>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="link"
                  className="self-start px-0"
                  onClick={() => setKeyFor(p.id)}
                >
                  Use an API key instead
                </Button>
              ))}
          </div>
        ))}
      </RadioGroup>
    </SetupStepRow>
  );
}
