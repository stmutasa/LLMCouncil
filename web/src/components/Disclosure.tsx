import { ChevronRight } from 'lucide-react';
import { useId, type ReactNode } from 'react';

interface DisclosureProps {
  open: boolean;
  onToggle: () => void;
  summary: ReactNode;
  /** Shown at the end of the header row, outside the button (e.g. a status chip). */
  className?: string;
  children: ReactNode;
}

/** A button that shows and hides the region below it (WAI-ARIA disclosure pattern). */
export function Disclosure({ open, onToggle, summary, className, children }: DisclosureProps) {
  const id = useId();
  return (
    <div className={`disclosure${open ? ' open' : ''}${className ? ` ${className}` : ''}`}>
      <button type="button" className="disclosure-toggle" aria-expanded={open} aria-controls={id} onClick={onToggle}>
        <ChevronRight size={14} className="disclosure-chevron" aria-hidden="true" />
        <span className="disclosure-summary">{summary}</span>
      </button>
      <div id={id} className="disclosure-body" hidden={!open}>
        {open ? children : null}
      </div>
    </div>
  );
}
