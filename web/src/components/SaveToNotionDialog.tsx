import { ExternalLink } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { SaveToNotionResponse, Turn } from '../../../shared/types';
import { openSettings } from '../actions';
import { api, errorMessage } from '../api';
import { useStore } from '../store';
import { Dialog } from './Dialog';
import { Spinner, WarningIcon } from './icons';

interface SaveToNotionDialogProps {
  turn: Turn;
  conversationId: string;
  onClose: () => void;
}

/** Saves one answer as a new Notion page under the chosen parent page. */
export function SaveToNotionDialog({ turn, conversationId, onClose }: SaveToNotionDialogProps) {
  const titleId = useId();
  const checkboxId = useId();
  const parent = useStore((s) => s.settings?.library.notionSaveParent ?? null);
  const [includeDeliberation, setIncludeDeliberation] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SaveToNotionResponse | null>(null);
  const council = turn.mode === 'council';
  const resultLinkRef = useRef<HTMLAnchorElement>(null);

  // The Save button disappears with the result; move focus to the new page's link.
  useEffect(() => {
    if (result) resultLinkRef.current?.focus();
  }, [result]);

  const save = async () => {
    setPending(true);
    setError(null);
    try {
      setResult(await api.saveToNotion(conversationId, turn.id, { includeDeliberation: council && includeDeliberation }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  const chooseLocation = () => {
    onClose();
    openSettings('library');
  };

  return (
    <Dialog onRequestClose={pending ? () => undefined : onClose} labelledBy={titleId} className="confirm-dialog notion-save-dialog">
      <h2 id={titleId} className="dialog-title">
        Save to Notion
      </h2>
      {result ? (
        <div className="notion-save-result" role="status">
          <p>The answer was saved as a new page.</p>
          <a ref={resultLinkRef} className="button notion-save-link" href={result.url} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={15} aria-hidden="true" />
            Open “{result.title}” in Notion
          </a>
        </div>
      ) : parent ? (
        <div className="confirm-body notion-save-body">
          <p>
            A new page with the question and the answer{turn.library && (turn.library.excerpts.length > 0 || turn.library.attachments.length > 0) ? ', and the sources it cites,' : ''} is
            created under <strong>{parent.title || 'the chosen page'}</strong>.
          </p>
          {council && (
            <label className="checkbox-row" htmlFor={checkboxId}>
              <input
                id={checkboxId}
                type="checkbox"
                checked={includeDeliberation}
                onChange={(e) => setIncludeDeliberation(e.target.checked)}
                disabled={pending}
              />
              <span>
                Include the deliberation
                <span className="field-hint">The council analysis and every member's answers, round by round.</span>
              </span>
            </label>
          )}
        </div>
      ) : (
        <div className="confirm-body">
          <p>Choose the Notion page that answers are saved under first. You can do this in Settings → Library.</p>
        </div>
      )}
      {error && (
        <div className="error-card" role="alert">
          <WarningIcon size={15} />
          <p className="pre-wrap">{error}</p>
        </div>
      )}
      <div className="dialog-actions">
        {result ? (
          <button type="button" className="button" onClick={onClose}>
            Done
          </button>
        ) : parent ? (
          <>
            <button type="button" className="button" onClick={onClose} disabled={pending} data-autofocus>
              Cancel
            </button>
            <button type="button" className="button primary" onClick={() => void save()} disabled={pending}>
              {pending && <Spinner size={14} />}
              {pending ? 'Saving…' : 'Save'}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="button" onClick={onClose} data-autofocus>
              Cancel
            </button>
            <button type="button" className="button primary" onClick={chooseLocation}>
              Open library settings
            </button>
          </>
        )}
      </div>
    </Dialog>
  );
}
