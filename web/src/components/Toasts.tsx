import { X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { dismissToast } from '../actions';
import { useStore } from '../store';

/** Background failures (settings saves from the composer, list refreshes). Portalled so they stay usable while a dialog is open. */
export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return createPortal(
    <div className="toasts" role="region" aria-label="Notifications">
      <div aria-live="assertive" aria-relevant="additions">
        {toasts.map((t) => (
          <div key={t.id} className="toast" role="alert">
            <p>{t.message}</p>
            <button type="button" className="icon-button small" onClick={() => dismissToast(t.id)} aria-label="Dismiss notification">
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}
