import type { ApiClient } from '@dispatch/client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTerminalOutput } from '../../hooks/useTerminalOutput';
import { createInputQueue } from '../../lib/terminalInput';
import { encodeKey } from '../../lib/terminalKeys';
import { TerminalCanvas } from '../terminal/TerminalCanvas';
import { DetailsDisclosure } from './DetailsDisclosure';

interface CommandTerminalProps {
  client: ApiClient;
  command: string[];
  title: string;
  /** Fires once when the command exits, with its exit code (null if unknown). */
  onExit: (exitCode: number | null) => void;
}

/** A small inline terminal running one command (an installer or a sign-in), keyboard included. */
export function CommandTerminal({
  client,
  command,
  title,
  onExit,
}: CommandTerminalProps) {
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const exited = useRef(false);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  // Started once per mount from the first props; a new command remounts via `key`.
  const launch = useRef({ command, title });
  const { screen, revision, info, refresh } = useTerminalOutput(
    client,
    terminalId,
    null
  );

  useEffect(() => {
    let cancelled = false;
    client
      .createTerminal(launch.current)
      .then((t) => !cancelled && setTerminalId(t.id))
      .catch(
        (err: unknown) =>
          !cancelled &&
          setStartError(
            err instanceof Error
              ? err.message
              : typeof err === 'string'
                ? err
                : 'Unknown error'
          )
      );
    return () => {
      cancelled = true;
    };
  }, [client]);

  useEffect(() => {
    if (info !== null && info.state !== 'running' && !exited.current) {
      exited.current = true;
      onExit(info.exitCode ?? null);
    }
  }, [info, onExit]);

  useEffect(() => surfaceRef.current?.focus(), [terminalId]);

  const send = useMemo(
    () =>
      createInputQueue(async (data) => {
        if (terminalId === null) return;
        await client.sendTerminalInput(terminalId, data);
        refresh();
      }),
    [client, terminalId, refresh]
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const bytes = encodeKey(event);
      if (bytes === null) return;
      event.preventDefault();
      send(bytes);
    },
    [send]
  );

  if (startError !== null) {
    return (
      <div className="flex flex-col gap-1">
        <p className="text-sm text-(--state-error-fg)" role="alert">
          Couldn&apos;t start that. Try again.
        </p>
        <DetailsDisclosure text={startError} />
      </div>
    );
  }

  return (
    <div
      ref={surfaceRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="border-border h-56 overflow-hidden rounded-md border outline-none focus:border-[var(--color-ring)]"
      aria-label={title}
    >
      <TerminalCanvas screen={screen} revision={revision} search="" follow />
    </div>
  );
}
