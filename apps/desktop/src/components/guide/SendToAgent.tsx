import type { EffortLevel } from '@dispatch-foo/core/browser';
import { Send, SlidersHorizontal } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';

import {
  DEFAULT_EFFORT_ID,
  effortFromId,
  effortOptions,
  modelLabel,
  MODELS,
} from '../../lib/models';
import { FailureNotice } from '../failure/FailureNotice';
import { Button } from '@/ui/button';
import { Field, FieldLabel } from '@/ui/field';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { Spinner } from '@/ui/spinner';
import { Textarea } from '@/ui/textarea';

export interface SendChoice {
  model?: string;
  effort?: EffortLevel;
  writes: string[];
}

export interface SendToAgentOptions {
  /** Offer the model and effort pickers; their lists are Claude's, so only for that agent. */
  modelChoice: boolean;
  /** What "Default" resolves to, named in its label. */
  defaultModel?: string;
  defaultEffort?: EffortLevel;
}

/** Declared files, one per line; blank lines and stray spaces dropped. */
export function parseWrites(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * The guide's one Send to agent button. Model, effort and the files the agent may
 * change wait behind More options, so the first send is a single click.
 */
export function SendToAgent({
  options,
  onSend,
  disabled = false,
  extra,
}: {
  options: SendToAgentOptions;
  onSend: (choice: SendChoice) => Promise<void>;
  disabled?: boolean;
  /** More controls at the bottom of More options (the draft's "Just create the task"). */
  extra?: ReactNode;
}) {
  const id = useId();
  const [model, setModel] = useState('');
  const [effortId, setEffortId] = useState(DEFAULT_EFFORT_ID);
  const [writes, setWrites] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const defaultName = modelLabel(options.defaultModel);

  async function send() {
    setSending(true);
    setError(null);
    const effort = options.modelChoice ? effortFromId(effortId) : undefined;
    try {
      await onSend({
        ...(options.modelChoice && model !== '' ? { model } : {}),
        ...(effort === undefined ? {} : { effort }),
        writes: parseWrites(writes),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-1.5">
        <Popover>
          <PopoverTrigger render={<Button variant="ghost" size="sm" />}>
            <SlidersHorizontal />
            More options
          </PopoverTrigger>
          <PopoverContent align="end" className="flex w-72 flex-col gap-3">
            {options.modelChoice && (
              <>
                <Field>
                  <FieldLabel htmlFor={`${id}-model`}>Model</FieldLabel>
                  <NativeSelect
                    id={`${id}-model`}
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                  >
                    <NativeSelectOption value="">
                      {defaultName === undefined
                        ? 'Default'
                        : `Default (${defaultName})`}
                    </NativeSelectOption>
                    {MODELS.map((m) => (
                      <NativeSelectOption key={m.id} value={m.id}>
                        {m.label}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${id}-effort`}>Effort</FieldLabel>
                  <NativeSelect
                    id={`${id}-effort`}
                    value={effortId}
                    onChange={(e) => setEffortId(e.target.value)}
                  >
                    {effortOptions(options.defaultEffort).map((e) => (
                      <NativeSelectOption key={e.id} value={e.id}>
                        {e.label}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
              </>
            )}
            <Field>
              <FieldLabel htmlFor={`${id}-writes`}>
                Files it may change
              </FieldLabel>
              <Textarea
                id={`${id}-writes`}
                rows={3}
                value={writes}
                onChange={(e) => setWrites(e.target.value)}
                placeholder={'src/settings/**\nOne path per line'}
              />
            </Field>
            {extra}
          </PopoverContent>
        </Popover>
        <Button
          size="sm"
          disabled={disabled || sending}
          onClick={() => void send()}
        >
          {sending ? <Spinner className="size-3.5" /> : <Send />}
          Send to agent
        </Button>
      </div>
      {error !== null && <FailureNotice error={error} onRetry={send} />}
    </div>
  );
}
