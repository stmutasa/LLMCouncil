import { createContext, Fragment, useContext, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react';
import { createPortal } from 'react-dom';
import { focusCitation } from '../actions';
import { CITATION_ATTRIBUTE, EMPTY_LOOKUP, type CitationInfo, type CitationLookup } from '../lib/citations';

/** The citation ids a turn's Markdown may resolve: its own library and earlier turns'. */
export const CitationContext = createContext<CitationLookup>(EMPTY_LOOKUP);

/**
 * Renders a citation group found by the Markdown plugin. Known ids become chips; unknown ones
 * stay as the text the model wrote, so nothing is lost when an id cannot be resolved.
 */
export function CitationGroup({ children, node: _node, ...rest }: ComponentPropsWithoutRef<'cite'> & { node?: unknown }) {
  const lookup = useContext(CitationContext);
  const raw = (rest as Record<string, unknown>)[CITATION_ATTRIBUTE];
  const ids = typeof raw === 'string' ? raw.split(' ').filter(Boolean) : [];
  const known = ids.map((id) => lookup.get(id) ?? null);
  if (known.every((k) => k === null)) return <>{children}</>;
  return (
    <span className="citation-group">
      {ids.map((id, i) => {
        const info = known[i];
        return <Fragment key={`${id}-${i}`}>{info ? <CitationChip info={info} /> : `[${id}]`}</Fragment>;
      })}
    </span>
  );
}

function CitationChip({ info }: { info: CitationInfo }) {
  const ref = useRef<HTMLButtonElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  // Positioned in viewport coordinates (portalled, so no scroll container or table clips it),
  // above the chip when there is room, clamped to the window.
  useLayoutEffect(() => {
    if (!open) return;
    const chip = ref.current;
    const tip = tipRef.current;
    if (!chip || !tip) return;
    const rect = chip.getBoundingClientRect();
    const width = tip.offsetWidth;
    const height = tip.offsetHeight;
    const margin = 8;
    const left = Math.max(margin, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - margin));
    const above = rect.top - height - 6 >= margin;
    tip.style.left = `${left}px`;
    tip.style.top = `${above ? rect.top - height - 6 : rect.bottom + 6}px`;
    tip.style.visibility = 'visible';
    // A fixed tooltip would drift away from its chip when anything scrolls; hide it instead.
    const hide = () => setOpen(false);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [open]);

  const kind = info.kind === 'passage' ? 'Passage' : 'Attached document';
  const label = `${kind} ${info.id}: ${info.title}${info.where ? `, ${info.where}` : ''}. Show it in Sources.`;
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="citation"
        aria-label={label}
        onClick={() => {
          setOpen(false);
          focusCitation(info.turnId, info.id);
        }}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={(e) => setOpen(e.currentTarget.matches(':focus-visible'))}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && open) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
      >
        {info.id}
      </button>
      {open &&
        createPortal(
          <div ref={tipRef} className="citation-tip" style={{ visibility: 'hidden' }} aria-hidden="true">
            <span className="citation-tip-title">{info.title}</span>
            {info.where && <span className="citation-tip-where">{info.where}</span>}
          </div>,
          document.body,
        )}
    </>
  );
}
