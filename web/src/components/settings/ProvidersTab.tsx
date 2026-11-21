import { ExternalLink, RefreshCw } from 'lucide-react';
import { useId, useState } from 'react';
import type { ProviderInfo, ProviderSettings, ProviderTestResult, Settings } from '../../../../shared/types';
import { loadProviders } from '../../actions';
import { api, errorMessage } from '../../api';
import { formatDuration } from '../../lib/format';
import { errorKey, providerSettingsFor } from '../../lib/settings';
import { useStore } from '../../store';
import { BillingBadge } from '../BillingBadge';
import { Disclosure } from '../Disclosure';
import { HintText } from '../HintText';
import { Spinner, WarningIcon } from '../icons';
import { Field, NumberInput, providerStatus, providerStatusText } from './fields';
import type { TabProps } from './SettingsDialog';

export function ProvidersTab({ draft, saved, update, errors }: TabProps & { saved: Settings }) {
  const { list, loading, error } = useStore((s) => s.providers);

  const setProvider = (id: string, patch: Partial<ProviderSettings>) =>
    update((d) => ({ ...d, providers: { ...d.providers, [id]: { ...providerSettingsFor(d, id), ...patch } } }));

  return (
    <div className="settings-section">
      <div className="section-intro">
        <div className="section-title-row">
          <h3 className="section-title">Providers</h3>
          <button type="button" className="button small" onClick={() => void loadProviders(true)} disabled={loading}>
            {loading ? <Spinner size={13} /> : <RefreshCw size={14} aria-hidden="true" />}
            {loading ? 'Checking…' : 'Re-check'}
          </button>
        </div>
        <p className="section-text">
          Every call goes through the vendor's official command-line tool, signed in with your own subscription. API-key
          environment variables are removed from these calls unless you turn that off under General.
        </p>
        {error && (
          <p className="field-error" role="alert">
            Could not check the providers: {error}
          </p>
        )}
      </div>
      {!list && loading && (
        <p className="muted small" role="status">
          <Spinner size={13} /> Checking the installed CLIs…
        </p>
      )}
      <ul className="card-list">
        {(list ?? []).map((info) => (
          <li key={info.id}>
            <ProviderCard
              info={info}
              value={providerSettingsFor(draft, info.id)}
              savedValue={providerSettingsFor(saved, info.id)}
              timeoutError={errors[errorKey.providerTimeout(info.id)]}
              onChange={(patch) => setProvider(info.id, patch)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

const STATUS_LABEL: Record<ReturnType<typeof providerStatus>, string> = {
  ok: 'Ready',
  warn: 'Check',
  bad: 'Not ready',
  unknown: 'Unknown',
};

interface ProviderCardProps {
  info: ProviderInfo;
  value: ProviderSettings;
  savedValue: ProviderSettings;
  timeoutError: string | undefined;
  onChange: (patch: Partial<ProviderSettings>) => void;
}

function ProviderCard({ info, value, savedValue, timeoutError, onChange }: ProviderCardProps) {
  const headingId = useId();
  const status = providerStatus(info);
  const editableCommand = info.kind === 'builtin';
  const unsaved = JSON.stringify(value) !== JSON.stringify(savedValue);
  const [argsText, setArgsText] = useState(value.extraArgs.join('\n'));

  return (
    <section className="card provider-card" aria-labelledby={headingId}>
      <div className="card-header">
        <span className={`provider-status-dot ${status}`} aria-hidden="true" />
        <h4 className="card-title" id={headingId}>
          {info.label}
          <span className="muted"> · {info.cliName}</span>
        </h4>
        <div className="card-header-actions">
          <span className={`status-chip provider-${status}`}>{STATUS_LABEL[status]}</span>
          <BillingBadge billing={info.billing} />
        </div>
      </div>

      <dl className="provider-facts">
        <div>
          <dt>Installed</dt>
          <dd>{info.installed ? `Yes${info.version ? ` · ${info.version}` : ''}` : 'No'}</dd>
        </div>
        <div>
          <dt>Sign-in</dt>
          <dd>
            {providerStatusText(info) === 'ready' ? 'Signed in' : info.installed ? capitalise(providerStatusText(info)) : '—'}
            {info.authDetail && <span className="muted"> · {info.authDetail}</span>}
          </dd>
        </div>
        <div>
          <dt>Command</dt>
          <dd>
            <code>{info.command}</code>
          </dd>
        </div>
      </dl>

      {info.warnings.length > 0 && (
        <ul className="provider-warnings">
          {info.warnings.map((w, i) => (
            <li key={i}>
              <WarningIcon size={14} />
              <span>{w}</span>
            </li>
          ))}
        </ul>
      )}
      {!info.installed && info.installHint && (
        <p className="provider-hint">
          <HintText text={info.installHint} />
        </p>
      )}
      {info.installed && info.auth !== 'ok' && info.loginHint && (
        <p className="provider-hint">
          <HintText text={info.loginHint} />
        </p>
      )}
      {info.docsUrl && (
        <p>
          <a className="text-link" href={info.docsUrl} target="_blank" rel="noopener noreferrer">
            Documentation <ExternalLink size={12} aria-hidden="true" />
          </a>
        </p>
      )}

      <div className="card-grid">
        {editableCommand && (
          <Field label="Command" hint="Leave empty to use the default. An absolute path also works.">
            {({ id, describedBy }) => (
              <input
                id={id}
                className="input mono"
                value={value.command}
                placeholder="Default"
                spellCheck={false}
                autoComplete="off"
                aria-describedby={describedBy}
                onChange={(e) => onChange({ command: e.target.value })}
              />
            )}
          </Field>
        )}
        <Field label="Timeout (seconds)" hint="0 uses the default timeout from General." error={timeoutError}>
          {({ id, describedBy, invalid }) => (
            <NumberInput id={id} value={value.timeoutSec} describedBy={describedBy} invalid={invalid} onChange={(timeoutSec) => onChange({ timeoutSec })} />
          )}
        </Field>
        {editableCommand && (
          <Field label="Extra arguments" className="span-2" hint="One argument per line, appended to the built-in ones.">
            {({ id, describedBy }) => (
              <textarea
                id={id}
                className="input textarea mono"
                rows={2}
                value={argsText}
                spellCheck={false}
                aria-describedby={describedBy}
                onChange={(e) => {
                  setArgsText(e.target.value);
                  onChange({
                    extraArgs: e.target.value
                      .split('\n')
                      .map((l) => l.trim())
                      .filter(Boolean),
                  });
                }}
              />
            )}
          </Field>
        )}
        {info.id === 'antigravity' && (
          <Field label="Prompt delivery">
            {({ id }) => (
              <select
                id={id}
                className="input select"
                value={value.promptMode}
                onChange={(e) => onChange({ promptMode: e.target.value === 'arg' ? 'arg' : 'stdin' })}
              >
                <option value="stdin">Standard input stream (default, no length limit)</option>
                <option value="arg">Command-line argument</option>
              </select>
            )}
          </Field>
        )}
      </div>

      <ProviderTest info={info} unsaved={unsaved} />
    </section>
  );
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function ProviderTest({ info, unsaved }: { info: ProviderInfo; unsaved: boolean }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ProviderTestResult | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  const run = async () => {
    setRunning(true);
    setResult(null);
    setRequestError(null);
    setShowDiagnostics(false);
    try {
      setResult(await api.testProvider(info.id, {}));
    } catch (err) {
      setRequestError(errorMessage(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="provider-test">
      <div className="provider-test-row">
        <button type="button" className="button small" onClick={() => void run()} disabled={running}>
          {running && <Spinner size={13} />}
          {running ? 'Testing…' : 'Test'}
        </button>
        <span className="field-hint">
          {running
            ? 'Asking the CLI to reply “OK”. This can take up to a minute.'
            : unsaved
              ? 'Tests use the saved settings. Save first to test your changes.'
              : 'Sends a one-line prompt through the CLI with its default model.'}
        </span>
      </div>
      <div aria-live="polite">
        {requestError && (
          <div className="error-card" role="alert">
            <WarningIcon size={15} />
            <p className="pre-wrap">{requestError}</p>
          </div>
        )}
        {result &&
          (result.ok ? (
            <div className="test-result ok">
              <p>
                Replied “{result.text.trim().slice(0, 200)}” in {formatDuration(result.durationMs)}
                {result.model ? ` · ${result.model}` : ''} <BillingBadge billing={result.billing} />
              </p>
            </div>
          ) : (
            <div className="error-card" role="alert">
              <WarningIcon size={15} />
              <div className="error-card-body">
                <p className="pre-wrap">{result.error || 'The test failed without an error message.'}</p>
                {result.diagnostics.trim() && (
                  <Disclosure open={showDiagnostics} onToggle={() => setShowDiagnostics((v) => !v)} summary="Diagnostics">
                    <pre className="diagnostics">{result.diagnostics}</pre>
                  </Disclosure>
                )}
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}
