import { useEffect, useId, useState, type ReactNode } from 'react';
import type { ProviderInfo } from '../../../../shared/types';
import { api, errorMessage } from '../../api';
import { Spinner } from '../icons';

interface FieldProps {
  label: string;
  /** Renders the label visually hidden (the context already names the field). */
  hideLabel?: boolean;
  hint?: ReactNode;
  error?: string;
  className?: string;
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}

/** Label, control, hint and inline error, wired together with ids for assistive technology. */
export function Field({ label, hideLabel = false, hint, error, className, children }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : '', error ? errorId : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`field${error ? ' has-error' : ''}${className ? ` ${className}` : ''}`}>
      <label htmlFor={id} className={hideLabel ? 'visually-hidden' : 'field-label'}>
        {label}
      </label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {hint && (
        <p className="field-hint" id={hintId}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field-error" id={errorId}>
          {error}
        </p>
      )}
    </div>
  );
}

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: ReactNode;
  disabled?: boolean;
  /** Hide the visible label (for compact rows that are labelled by their context). */
  compact?: boolean;
}

export function Switch({ checked, onChange, label, description, disabled = false, compact = false }: SwitchProps) {
  const id = useId();
  return (
    <div className={`switch-row${compact ? ' compact' : ''}`}>
      <button
        type="button"
        role="switch"
        id={id}
        aria-checked={checked}
        aria-label={compact ? label : undefined}
        aria-describedby={description ? `${id}-desc` : undefined}
        className="switch"
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span className="switch-thumb" aria-hidden="true" />
      </button>
      {!compact && (
        <div className="switch-text">
          <label htmlFor={id} className="switch-label">
            {label}
          </label>
          {description && (
            <p className="field-hint" id={`${id}-desc`}>
              {description}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A whole-number input that keeps the typed text while it is being edited, so clearing the
 * field or typing a partial value does not snap back. Invalid text is reported to the draft as
 * NaN, which validation then flags.
 */
export function NumberInput({
  id,
  value,
  onChange,
  describedBy,
  invalid,
  min,
  max,
}: {
  id: string;
  value: number;
  onChange: (value: number) => void;
  describedBy?: string;
  invalid?: boolean;
  min?: number;
  max?: number;
}) {
  const [text, setText] = useState(Number.isFinite(value) ? String(value) : '');
  useEffect(() => {
    // Follow outside changes (e.g. a reset) without fighting the user's own typing.
    setText((current) => (Number(current) === value && current.trim() !== '' ? current : Number.isFinite(value) ? String(value) : current));
  }, [value]);
  return (
    <input
      id={id}
      className="input number"
      inputMode="numeric"
      value={text}
      min={min}
      max={max}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      onChange={(e) => {
        const next = e.target.value;
        setText(next);
        onChange(/^\s*\d+\s*$/.test(next) ? Number(next) : Number.NaN);
      }}
    />
  );
}

export function ProviderSelect({
  id,
  value,
  onChange,
  providers,
  describedBy,
  invalid,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  providers: ProviderInfo[] | null;
  describedBy?: string;
  invalid?: boolean;
}) {
  const list = providers ?? [];
  const known = list.some((p) => p.id === value);
  return (
    <div className="provider-select">
      <span className={`provider-status-dot ${providerStatus(list.find((p) => p.id === value))}`} aria-hidden="true" />
      <select
        id={id}
        className="input select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
      >
        {!known && <option value={value}>{providers ? `${value} (not available)` : value}</option>}
        {list.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label} — {providerStatusText(p)}
          </option>
        ))}
      </select>
    </div>
  );
}

export function providerStatus(p: ProviderInfo | undefined): 'ok' | 'warn' | 'bad' | 'unknown' {
  if (!p) return 'unknown';
  if (!p.installed) return 'bad';
  if (p.auth === 'missing') return 'bad';
  if (p.auth === 'unknown' || p.billing === 'api-key' || p.warnings.length > 0) return 'warn';
  return 'ok';
}

export function providerStatusText(p: ProviderInfo): string {
  if (!p.installed) return 'not installed';
  if (p.auth === 'missing') return 'not signed in';
  if (p.auth === 'unknown') return 'sign-in not checked';
  return 'ready';
}

/** Model text input with suggestions; can ask the CLI for its live model list. */
export function ModelInput({
  id,
  value,
  onChange,
  provider,
  describedBy,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  provider: ProviderInfo | undefined;
  describedBy?: string;
}) {
  const listId = `${id}-models`;
  const [loaded, setLoaded] = useState<{ provider: string; models: string[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const extra = loaded && provider && loaded.provider === provider.id ? loaded.models : [];
  const options = Array.from(new Set([...(provider?.modelSuggestions ?? []), ...extra]));

  const load = async () => {
    if (!provider) return;
    setLoading(true);
    setError(null);
    setNote(null);
    try {
      const result = await api.providerModels(provider.id);
      setLoaded({ provider: provider.id, models: result.models });
      if (result.error) setError(`Could not read the live list: ${result.error}`);
      else setNote(`${result.models.length} models available${result.source === 'static' ? ' (built-in list)' : ''}.`);
    } catch (err) {
      setError(`Could not load models: ${errorMessage(err)}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="model-input">
      <div className="model-input-row">
        <input
          id={id}
          className="input"
          value={value}
          placeholder="CLI default"
          list={listId}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={[describedBy, error || note ? `${id}-status` : ''].filter(Boolean).join(' ') || undefined}
          onChange={(e) => onChange(e.target.value.trim() === '' ? '' : e.target.value)}
        />
        {provider?.canListModels && (
          <button type="button" className="button small" onClick={() => void load()} disabled={loading}>
            {loading ? <Spinner size={13} /> : null}
            {loading ? 'Loading…' : 'Load models'}
          </button>
        )}
      </div>
      <datalist id={listId}>
        {options.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      {(error || note) && (
        <p className={error ? 'field-error' : 'field-hint'} id={`${id}-status`} role={error ? 'alert' : 'status'}>
          {error ?? note}
        </p>
      )}
    </div>
  );
}

export function EffortSelect({
  id,
  value,
  onChange,
  provider,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  provider: ProviderInfo | undefined;
}) {
  const levels = provider?.effortLevels ?? [];
  return (
    <select id={id} className="input select" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Default</option>
      {value && !levels.includes(value) && <option value={value}>{value} (not offered by this provider)</option>}
      {levels.map((l) => (
        <option key={l} value={l}>
          {l}
        </option>
      ))}
    </select>
  );
}
