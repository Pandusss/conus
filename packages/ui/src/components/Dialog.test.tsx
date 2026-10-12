import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { ConfirmDialog, PromptDialog, ReasonDialog } from './Dialog';

afterEach(() => vi.restoreAllMocks());

/** A trigger button that opens a ConfirmDialog, so focus handling can be checked. */
function ConfirmHarness({ onConfirm }: { onConfirm: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Открыть</button>
      <ConfirmDialog
        open={open} title="Точно?" message="Это нельзя отменить." confirmLabel="Да"
        onConfirm={() => { onConfirm(); setOpen(false); }} onCancel={() => setOpen(false)}
      />
    </>
  );
}

describe('ConfirmDialog', () => {
  it('moves focus in, confirms, and gives focus back to the trigger', async () => {
    const onConfirm = vi.fn();
    render(<ConfirmHarness onConfirm={onConfirm} />);
    const trigger = screen.getByRole('button', { name: 'Открыть' });
    await userEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Точно?' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(within(dialog).getByText('Это нельзя отменить.')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Да' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes without confirming on Cancel, Esc, ✕ and a click on the overlay', async () => {
    const onConfirm = vi.fn();
    render(<ConfirmHarness onConfirm={onConfirm} />);
    const trigger = screen.getByRole('button', { name: 'Открыть' });
    const closers: (() => Promise<unknown>)[] = [
      () => userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Отмена' })),
      () => userEvent.keyboard('{Escape}'),
      () => userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Закрыть' })),
      () => userEvent.click(screen.getByRole('dialog').parentElement!),
    ];
    for (const close of closers) {
      await userEvent.click(trigger);
      expect(screen.getByRole('dialog')).toBeTruthy();
      await close();
      expect(screen.queryByRole('dialog')).toBeNull();
    }
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('keeps Tab inside the dialog', async () => {
    render(<ConfirmHarness onConfirm={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Открыть' }));
    const dialog = screen.getByRole('dialog');
    for (let i = 0; i < 5; i++) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });
});

describe('ReasonDialog', () => {
  it('cannot be confirmed empty when the reason is required, and passes the trimmed text', async () => {
    const onConfirm = vi.fn();
    render(<ReasonDialog open title="Блокировка" label="Что мешает?" required confirmLabel="Заблокировать" onConfirm={onConfirm} onCancel={() => {}} />);
    const confirm = screen.getByRole('button', { name: 'Заблокировать' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(document.activeElement).toBe(screen.getByLabelText('Что мешает?'));
    await userEvent.type(screen.getByLabelText('Что мешает?'), '  ждём ключи  ');
    await userEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith('ждём ключи');
  });

  it('passes undefined for an empty optional reason; Cancel does not confirm', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ReasonDialog open title="Отклонить WB-1" confirmLabel="Отклонить" onConfirm={onConfirm} onCancel={onCancel} />);
    await userEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Отклонить' }));
    expect(onConfirm).toHaveBeenCalledWith(undefined);
  });
});

describe('PromptDialog', () => {
  it('starts from the current value and confirms the trimmed new one', async () => {
    const onConfirm = vi.fn();
    render(<PromptDialog open title="Переименовать" label="Название" initial="Старое" onConfirm={onConfirm} onCancel={() => {}} />);
    const input = screen.getByLabelText('Название') as HTMLInputElement;
    expect(input.value).toBe('Старое');
    await userEvent.clear(input);
    expect((screen.getByRole('button', { name: 'Сохранить' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(input, ' Новое {Enter}');
    expect(onConfirm).toHaveBeenCalledWith('Новое');
  });
});
