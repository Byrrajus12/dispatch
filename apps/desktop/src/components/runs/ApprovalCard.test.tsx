import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, mock } from 'bun:test';

import { ApprovalCard } from './ApprovalCard';

describe('ApprovalCard — composing a deny reason', () => {
  // The pre-reskin version removed the option row entirely while the reason box was open; the
  // rebuilt-on-primitive version keeps the row but must disable it for the same reason — a
  // stray click on "Approve once" while the human is mid-explanation must not fire a real
  // approval underneath them.
  it('disables the other options while denying, so a stray click cannot approve', () => {
    const onDecide = mock(() => Promise.resolve());
    render(
      <ApprovalCard
        toolName="Bash"
        toolInput={{ command: 'rm -rf /' }}
        onDecide={onDecide}
      />
    );

    fireEvent.click(
      screen.getByRole('radio', { name: /deny and tell it why/i })
    );

    const approveOnce = screen.getByRole('radio', { name: /approve once/i });
    const allowForRun = screen.getByRole('radio', {
      name: /allow bash for this run/i,
    });
    expect(approveOnce.hasAttribute('disabled')).toBe(true);
    expect(allowForRun.hasAttribute('disabled')).toBe(true);

    fireEvent.click(approveOnce);
    fireEvent.click(allowForRun);
    expect(onDecide).not.toHaveBeenCalled();
  });

  // Cancelling the reason box re-enables the options — denying is not a one-way door.
  it('re-enables the options once the reason box is cancelled', () => {
    const onDecide = mock(() => Promise.resolve());
    render(
      <ApprovalCard toolName="Bash" toolInput={undefined} onDecide={onDecide} />
    );

    fireEvent.click(
      screen.getByRole('radio', { name: /deny and tell it why/i })
    );
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    const approveOnce = screen.getByRole('radio', { name: /approve once/i });
    expect(approveOnce.hasAttribute('disabled')).toBe(false);

    fireEvent.click(approveOnce);
    expect(onDecide).toHaveBeenCalledWith(true, { scope: 'once' });
  });
});

describe('ApprovalCard — an attached window that cannot decide', () => {
  // Same gate as the scope card: the daemon only takes an approval on the app token, so a
  // window that attached to a daemon it did not start must say so instead of 403ing.
  it('disables every option, explains why, and offers the restart when it is safe', () => {
    const onDecide = mock(() => Promise.resolve());
    const onRestartDaemon = mock(() => Promise.resolve());
    render(
      <ApprovalCard
        toolName="Bash"
        toolInput={{ command: 'ls' }}
        onDecide={onDecide}
        availability={{
          enabled: false,
          notice: 'Restart daemon to enable approvals',
          explanation: 'This window did not start the daemon.',
          restart: { safe: true, blockedReason: null },
        }}
        onRestartDaemon={onRestartDaemon}
      />
    );
    fireEvent.click(screen.getByText('Approve once'));
    expect(onDecide).not.toHaveBeenCalled();
    expect(
      screen.getByText('Restart daemon to enable approvals')
    ).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /restart daemon/i }));
    expect(onRestartDaemon).toHaveBeenCalledTimes(1);
  });
});
