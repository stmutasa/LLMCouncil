import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Modal stack. Only the topmost dialog handles Escape and keeps focus; everything beneath it
 * (the app and lower dialogs) is made inert, so focus and pointer input cannot reach it. Inert
 * is applied synchronously, so focus can move into (or back to) a dialog in the same tick.
 */
interface StackEntry {
  id: string;
  backdrop: HTMLElement;
}

let stack: StackEntry[] = [];

function applyInert() {
  const root = document.getElementById('root');
  if (root) root.inert = stack.length > 0;
  stack.forEach((entry, i) => {
    entry.backdrop.inert = i !== stack.length - 1;
  });
}

function isTopmost(id: string): boolean {
  return stack[stack.length - 1]?.id === id;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.closest('[inert]') && el.getClientRects().length > 0,
  );
}

interface DialogProps {
  /** Called on Escape or a backdrop click; the owner decides whether to close. */
  onRequestClose: () => void;
  /** Id of the element that names the dialog. */
  labelledBy: string;
  describedBy?: string;
  className?: string;
  role?: 'dialog' | 'alertdialog';
  children: ReactNode;
}

/** Mount to open, unmount to close. Focus returns to whatever was focused before it opened. */
export function Dialog({ onRequestClose, labelledBy, describedBy, className, role = 'dialog', children }: DialogProps) {
  const id = useId();
  const backdropRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onRequestClose);
  closeRef.current = onRequestClose;

  useLayoutEffect(() => {
    const backdrop = backdropRef.current;
    const panel = panelRef.current;
    if (!backdrop || !panel) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    stack = [...stack, { id, backdrop }];
    applyInert();
    const preferred = panel.querySelector<HTMLElement>('[data-autofocus]');
    (preferred ?? panel).focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (!isTopmost(id)) return;
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables(panel);
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      const inside = active instanceof Node && panel.contains(active);
      if (e.shiftKey && (active === first || !inside || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      stack = stack.filter((entry) => entry.id !== id);
      applyInert();
      if (previous && previous.isConnected) previous.focus();
    };
  }, [id]);

  return createPortal(
    <div
      ref={backdropRef}
      className="dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && isTopmost(id)) closeRef.current();
      }}
    >
      <div
        ref={panelRef}
        className={className ? `dialog ${className}` : 'dialog'}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

interface ConfirmDialogProps {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  pending?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancel',
  danger = false,
  pending = false,
  error = null,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId();
  const bodyId = useId();
  return (
    <Dialog onRequestClose={pending ? () => undefined : onCancel} labelledBy={titleId} describedBy={bodyId} className="confirm-dialog" role="alertdialog">
      <h2 id={titleId} className="dialog-title">
        {title}
      </h2>
      <div id={bodyId} className="confirm-body">
        {message}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="button" onClick={onCancel} disabled={pending} data-autofocus>
          {cancelLabel}
        </button>
        <button type="button" className={danger ? 'button danger' : 'button primary'} onClick={onConfirm} disabled={pending}>
          {pending ? `${confirmLabel}…` : confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
