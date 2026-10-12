import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';

import { parseWrites, SendToAgent } from './SendToAgent';

test('one click sends on the defaults', async () => {
  const onSend = mock(() => Promise.resolve());
  render(<SendToAgent options={{ modelChoice: true }} onSend={onSend} />);
  fireEvent.click(screen.getByRole('button', { name: 'Send to agent' }));
  await waitFor(() => expect(onSend).toHaveBeenCalledWith({ writes: [] }));
});

test('More options carries the model, effort and files it may change', async () => {
  const onSend = mock(() => Promise.resolve());
  render(
    <SendToAgent
      options={{ modelChoice: true, defaultModel: 'claude-opus-5-5' }}
      onSend={onSend}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'More options' }));
  fireEvent.change(await screen.findByLabelText('Model'), {
    target: { value: 'claude-sonnet-5-5' },
  });
  fireEvent.change(screen.getByLabelText('Effort'), {
    target: { value: 'high' },
  });
  fireEvent.change(screen.getByLabelText('Files it may change'), {
    target: { value: ' src/a.ts \n\n src/b/** ' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send to agent' }));
  await waitFor(() =>
    expect(onSend).toHaveBeenCalledWith({
      model: 'claude-sonnet-5-5',
      effort: 'high',
      writes: ['src/a.ts', 'src/b/**'],
    })
  );
});

test("another agent gets no model or effort picker (they are Claude's lists)", async () => {
  render(
    <SendToAgent
      options={{ modelChoice: false }}
      onSend={() => Promise.resolve()}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'More options' }));
  expect(await screen.findByLabelText('Files it may change')).toBeTruthy();
  expect(screen.queryByLabelText('Model')).toBeNull();
});

test('a refused send explains itself', async () => {
  render(
    <SendToAgent
      options={{ modelChoice: false }}
      onSend={() =>
        Promise.reject(new Error('Claude Code CLI not found. Install it'))
      }
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Send to agent' }));
  expect(
    await screen.findByText(
      "Claude Code isn't installed, or Dispatch can't find it."
    )
  ).toBeTruthy();
});

test('declared files are one per line, trimmed', () => {
  expect(parseWrites(' a\n\n  b/** \n')).toEqual(['a', 'b/**']);
});
