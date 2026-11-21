import { TriangleExclamationPoint } from 'lucide-react';
import { loadProviders, openSettings } from '../actions';
import { providerProblems, setupSummary } from '../lib/settings';
import { useStore } from '../store';
import { Composer } from './Composer';
import { HintText } from './HintText';
import { Spinner } from './icons';

export function EmptyState() {
  const settings = useStore((s) => s.settings);
  return (
    <div className="empty-state">
      <div className="empty-inner">
        <h2 className="empty-heading">What should the council decide?</h2>
        <Composer convKey="" runningTurn={null} ready autoFocus />
        {settings && (
          <button type="button" className="setup-row" onClick={() => openSettings('council')}>
            {setupSummary(settings)}
          </button>
        )}
        <ProviderNotice />
      </div>
    </div>
  );
}

function ProviderNotice() {
  const settings = useStore((s) => s.settings);
  const providers = useStore((s) => s.providers);
  if (!settings) return null;

  if (!providers.list) {
    if (providers.loading) {
      return (
        <p className="provider-checking" role="status">
          <Spinner size={13} /> Checking the model CLIs…
        </p>
      );
    }
    if (providers.error) {
      return (
        <div className="notice-card" role="status">
          <p className="notice-title">Could not check the model CLIs</p>
          <p className="notice-text">{providers.error}</p>
          <div className="notice-actions">
            <button type="button" className="button small" onClick={() => void loadProviders(true)}>
              Try again
            </button>
          </div>
        </div>
      );
    }
    return null;
  }

  const problems = providerProblems(settings, providers.list);
  if (problems.length === 0) return null;
  return (
    <div className="notice-card" role="status">
      <p className="notice-title">
        <TriangleExclamationPoint size={15} aria-hidden="true" className="status-warning" />
        {problems.length === 1 ? 'One provider needs attention' : `${problems.length} providers need attention`}
      </p>
      <ul className="notice-list">
        {problems.map((p) => (
          <li key={p.providerId}>
            <p className="notice-item-title">
              {p.title} <span className="muted">· used by {p.usedBy.join(', ')}</span>
            </p>
            <p className="notice-text">
              <HintText text={p.fix} />
            </p>
          </li>
        ))}
      </ul>
      <div className="notice-actions">
        <button type="button" className="button small" onClick={() => openSettings('providers')}>
          Open provider settings
        </button>
        <button type="button" className="button small ghost" onClick={() => void loadProviders(true)} disabled={providers.loading}>
          {providers.loading ? 'Checking…' : 'Re-check'}
        </button>
      </div>
    </div>
  );
}
