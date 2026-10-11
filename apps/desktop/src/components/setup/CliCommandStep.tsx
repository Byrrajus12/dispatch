import { useState } from 'react';

import { installCliCommand } from '../../lib/tauri';
import { errorText } from './errorText';
import { SetupStepRow } from './SetupStepRow';
import { Button } from '@/ui/button';

/** Optional: puts the `dispatch` command on PATH for people who also use a terminal. */
export function CliCommandStep() {
  const [linked, setLinked] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function install() {
    setBusy(true);
    setDetail(null);
    try {
      setLinked(await installCliCommand());
    } catch (err) {
      setDetail(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SetupStepRow
      status={linked === null ? 'waiting' : 'ok'}
      title="Terminal command"
      message={
        linked !== null
          ? `Installed at ${linked}`
          : detail !== null
            ? "Couldn't install the command."
            : 'Use Dispatch from a terminal with the `dispatch` command.'
      }
      action={
        <Button disabled={busy} onClick={() => void install()}>
          Install command
        </Button>
      }
      {...(detail === null ? {} : { detail })}
    />
  );
}
