import { Search, X } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { LIMITS } from '../../../../shared/defaults';
import type { LibraryDocument, LibrarySource } from '../../../../shared/types';
import { setAttachments } from '../../actions';
import { useDocumentQuery } from '../../hooks/useDocumentQuery';
import { formatNumber } from '../../lib/format';
import { attachedSize, attachmentBudget, formatChars, whereText, type AttachedDocument } from '../../lib/library';
import { useStore, type ConversationKey } from '../../store';
import { Dialog } from '../Dialog';
import { WarningIcon } from '../icons';
import { DocumentListView } from './DocumentListView';

const NONE: AttachedDocument[] = [];
const NO_SOURCES: LibrarySource[] = [];

interface AttachmentPickerProps {
  convKey: ConversationKey;
  onClose: () => void;
}

/**
 * Chooses documents for the models to read in full. Edits a selection that is applied on
 * "Attach"; the budget is shown as it would be shared, with a warning (never a block) when the
 * documents do not all fit.
 */
export function AttachmentPicker({ convKey, onClose }: AttachmentPickerProps) {
  const titleId = useId();
  const searchId = useId();
  const budgetId = useId();
  const initial = useStore((s) => s.attachments[convKey] ?? NONE);
  const sources = useStore((s) => s.settings?.library.sources ?? NO_SOURCES);
  const budget = useStore((s) => s.settings?.library.attachmentChars ?? 0);
  const [selected, setSelected] = useState<AttachedDocument[]>(initial);
  const [q, setQ] = useState('');
  const query = useDocumentQuery({ status: ['ok'], q });

  const sourceName = (id: string) => sources.find((s) => s.id === id)?.name ?? '';
  const sourceEnabled = (id: string) => sources.find((s) => s.id === id)?.enabled ?? false;
  const isSelected = (id: string) => selected.some((d) => d.id === id);
  const full = selected.length >= LIMITS.maxAttachments;

  const plan = useMemo(() => attachmentBudget(selected, budget), [selected, budget]);
  const planById = new Map(plan.items.map((i) => [i.id, i]));

  const toggle = (doc: LibraryDocument) => {
    setSelected((current) => {
      if (current.some((d) => d.id === doc.id)) return current.filter((d) => d.id !== doc.id);
      if (current.length >= LIMITS.maxAttachments) return current;
      return [
        ...current,
        { id: doc.id, title: doc.title, location: doc.location, sourceName: sourceName(doc.sourceId), chars: doc.chars, atLeast: false, problem: '' },
      ];
    });
  };

  // Sizes remembered from an earlier question can be lower bounds; take exact ones when seen.
  const exact = useMemo(() => new Map(query.documents.map((d) => [d.id, d])), [query.documents]);
  const apply = () => {
    setAttachments(
      convKey,
      selected.map((d) => {
        const doc = exact.get(d.id);
        return doc ? { ...d, title: doc.title, location: doc.location, chars: doc.chars, atLeast: false } : d;
      }),
    );
    onClose();
  };

  return (
    <Dialog onRequestClose={onClose} labelledBy={titleId} className="library-dialog picker-dialog">
      <header className="library-dialog-header">
        <h2 id={titleId} className="dialog-title">
          Attach documents
        </h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close" title="Close">
          <X size={18} aria-hidden="true" />
        </button>
      </header>
      <div className="library-dialog-body">
        <p className="muted small">Every model reads attached documents in full. They stay attached for later questions in this conversation.</p>
        <div className="search-field">
          <Search size={15} aria-hidden="true" className="search-field-icon" />
          <label htmlFor={searchId} className="visually-hidden">
            Search documents by title or folder
          </label>
          <input
            id={searchId}
            type="search"
            className="input"
            placeholder="Search by title or folder"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            data-autofocus
          />
        </div>
        <DocumentListView
          query={query}
          label="Documents"
          emptyText={q.trim() ? 'No readable document matches this search.' : 'The library has no readable documents yet.'}
          renderItem={(doc) => {
            const checked = isSelected(doc.id);
            const off = !sourceEnabled(doc.sourceId);
            const disabled = !checked && (full || off);
            return (
              <li key={doc.id}>
                <label className={`pick-row${disabled ? ' disabled' : ''}${checked ? ' checked' : ''}`}>
                  <input type="checkbox" checked={checked} disabled={disabled} onChange={() => toggle(doc)} />
                  <span className="pick-main">
                    <span className="pick-title">{doc.title}</span>
                    <span className="pick-where">
                      {whereText([sourceName(doc.sourceId), doc.location])}
                      {off && ' · source turned off'}
                    </span>
                    {doc.detail && <span className="doc-note">{doc.detail}</span>}
                  </span>
                  <span className="pick-size">{formatChars(doc.chars)}</span>
                </label>
              </li>
            );
          }}
        />
      </div>
      <footer className="library-dialog-footer picker-footer">
        {selected.length > 0 && (
          <ul className="attachment-chips in-picker" aria-label="Selected documents">
            {selected.map((d) => {
              const item = planById.get(d.id);
              const note = item?.leftOut ? 'will not fit' : item?.cut ? 'will be cut' : '';
              return (
                <li key={d.id} className={`attachment-chip${note ? ' over' : ''}`}>
                  <span className="attachment-chip-title" title={d.title}>
                    {d.title}
                  </span>
                  <span className="attachment-chip-size">{note || attachedSize(d)}</span>
                  <button
                    type="button"
                    className="attachment-chip-remove"
                    onClick={() => setSelected((current) => current.filter((x) => x.id !== d.id))}
                    aria-label={`Remove ${d.title}`}
                    title="Remove"
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="budget" id={budgetId}>
          <div className="budget-text">
            <span>
              {selected.length === 0
                ? 'Nothing selected'
                : `${formatNumber(selected.length)} selected · ${selected.some((d) => d.atLeast) ? 'at least ' : ''}${formatNumber(plan.total)} of ${formatNumber(plan.budget)} characters`}
            </span>
            {full && <span className="muted"> · at most {LIMITS.maxAttachments} documents</span>}
          </div>
          <div
            className={`meter${plan.over > 0 ? ' over' : ''}`}
            role="meter"
            aria-label="Attachment budget used"
            aria-valuemin={0}
            aria-valuemax={plan.budget || 1}
            aria-valuenow={Math.min(plan.total, plan.budget)}
            aria-valuetext={`${formatNumber(plan.total)} of ${formatNumber(plan.budget)} characters`}
          >
            <span style={{ width: `${plan.budget > 0 ? Math.min(100, (plan.total / plan.budget) * 100) : 0}%` }} />
          </div>
          {plan.over > 0 && (
            <p className="budget-warning">
              <WarningIcon size={13} />
              <span>{overBudgetText(plan.over, plan.items)}</span>
            </p>
          )}
        </div>
        <div className="dialog-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button primary" onClick={apply}>
            {selected.length === 0 && initial.length > 0 ? 'Remove all' : 'Attach'}
          </button>
        </div>
      </footer>
    </Dialog>
  );
}

function overBudgetText(over: number, items: { cut: boolean; leftOut: boolean }[]): string {
  const cut = items.filter((i) => i.cut).length;
  const leftOut = items.filter((i) => i.leftOut).length;
  const effects = [cut ? `${cut === 1 ? 'one document' : `${cut} documents`} will be cut` : '', leftOut ? `${leftOut === 1 ? 'one' : leftOut} left out` : '']
    .filter(Boolean)
    .join(' and ');
  return `${formatNumber(over)} characters over the attachment budget: ${effects}. You can still attach them, or raise the budget in Settings → Library.`;
}
