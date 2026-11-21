import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/** Writes text to the clipboard, falling back to a hidden textarea where the API is unavailable. */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('Copying is not available in this browser.');
}

interface CopyButtonProps {
  getText: () => string;
  label: string;
  /** Show the label next to the icon instead of only as an accessible name. */
  showLabel?: boolean;
  className?: string;
}

export function CopyButton({ getText, label, showLabel = false, className = 'icon-button small' }: CopyButtonProps) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  const onClick = async () => {
    try {
      await copyText(getText());
      setState('copied');
    } catch {
      setState('failed');
    }
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 2000);
  };

  const text = state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label;
  return (
    <button type="button" className={className} onClick={onClick} aria-label={showLabel ? undefined : text} title={showLabel ? undefined : text}>
      {state === 'copied' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      {showLabel && <span>{text}</span>}
      <span className="visually-hidden" aria-live="polite">
        {state === 'idle' ? '' : text}
      </span>
    </button>
  );
}
