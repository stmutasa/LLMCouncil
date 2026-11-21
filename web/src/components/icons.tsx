import { Check, Minus, CircleStop, CircleX, LoaderCircle, TriangleExclamationPoint } from 'lucide-react';
import type { CallStatus } from '../../../shared/types';

export function Spinner({ size = 16, label }: { size?: number; label?: string }) {
  return (
    <LoaderCircle
      className="spin"
      size={size}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
    />
  );
}

/** The app's own mark: three seats around a table, drawn as plain strokes. */
export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className="logo-mark">
      <circle cx="12" cy="12" r="4.25" stroke="currentColor" strokeWidth="1.75" />
      <circle cx="12" cy="3.5" r="1.75" fill="currentColor" />
      <circle cx="4.64" cy="16.25" r="1.75" fill="currentColor" />
      <circle cx="19.36" cy="16.25" r="1.75" fill="currentColor" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="wordmark">
      <LogoMark />
      <span className="wordmark-text">LLM Council</span>
    </span>
  );
}

export const CALL_STATUS_LABEL: Record<CallStatus, string> = {
  pending: 'Waiting',
  running: 'Working',
  done: 'Done',
  error: 'Failed',
  skipped: 'Skipped',
};

/** Small per-call status marker used in member tabs. */
export function CallStatusIcon({ status, size = 14 }: { status: CallStatus; size?: number }) {
  const label = CALL_STATUS_LABEL[status];
  switch (status) {
    case 'running':
      return <Spinner size={size} label={label} />;
    case 'done':
      return <Check className="status-done" size={size} aria-label={label} role="img" />;
    case 'error':
      return <CircleX className="status-error" size={size} aria-label={label} role="img" />;
    case 'skipped':
      return <Minus className="status-skipped" size={size} aria-label={label} role="img" />;
    default:
      return <span className="status-pending-dot" role="img" aria-label={label} />;
  }
}

export function WarningIcon({ size = 16 }: { size?: number }) {
  return <TriangleExclamationPoint size={size} aria-hidden="true" className="status-warning" />;
}

export function StoppedIcon({ size = 16 }: { size?: number }) {
  return <CircleStop size={size} aria-hidden="true" className="status-stopped" />;
}

export function MemberDot({ color, size = 8 }: { color: string; size?: number }) {
  return <span className="member-dot" style={{ background: color, width: size, height: size }} aria-hidden="true" />;
}
