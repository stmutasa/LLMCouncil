import { useEffect, useId, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Modal stack. Only the topmost dialog handles Escape and keeps focus; everything beneath it
 * (the app and lower dialogs) is made inert, so focus and pointer input cannot reach it.
 */
let stack: string[] = [];
const listeners = new Set<() => void>();

function emit() {
  const root = document.getElementById('root');
  if (root) root.inert = stack.length > 0;
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getStack = () => stack;

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
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onRequestClose);
  closeRef.current = onRequestClose;
  const currentStack = useSyncExternalStore(subscribe, getStack);
  const isTop = currentStack[currentStack.length - 1] === id;

  useLayoutEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    stack = [...stack, id];
    emit();
    const panel = panelRef.current;
    if (panel) {
      const preferred = panel.querySelector<HTMLElement>('[data-autofocus]');
      (preferred ?? panel).focus();
    }
    return () => {
      stack = stack.filter((s) => s !== id);
      emit();
      if (previous && previous.isConnected) previous.focus();
    };
  }, [id]);

  useEffect(() => {
    if (!isTop) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const items = focusables(panelRef.current);
      if (items.length === 0) {
        e.preventDefault();
        panelRef.current.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      const inside = active instanceof Node && panelRef.current.contains(active);
      if (e.shiftKey && (active === first || !inside || active === panelRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isTop]);

  return createPortal(
    <div
      className="dialog-backdrop"
      inert={!isTop}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeRef.current();
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
