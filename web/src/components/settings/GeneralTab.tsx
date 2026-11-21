import { LIMITS } from '../../../../shared/defaults';
import { errorKey } from '../../lib/settings';
import { useStore } from '../../store';
import { Field, NumberInput, Switch } from './fields';
import type { TabProps } from './SettingsDialog';

export function GeneralTab({ draft, update, errors }: TabProps) {
  const meta = useStore((s) => s.meta);
  return (
    <div className="settings-section">
      <div className="section-intro">
        <h3 className="section-title">General</h3>
      </div>
      <div className="card">
        <div className="card-grid">
          <Field
            label="Default timeout (seconds)"
            hint={`How long one model call may take before it is stopped, from ${LIMITS.minTimeoutSec} to ${LIMITS.maxTimeoutSec.toLocaleString('en-US')}. Providers can override it.`}
            error={errors[errorKey.defaultTimeout]}
          >
            {({ id, describedBy, invalid }) => (
              <NumberInput
                id={id}
                value={draft.defaultTimeoutSec}
                describedBy={describedBy}
                invalid={invalid}
                onChange={(defaultTimeoutSec) => update((d) => ({ ...d, defaultTimeoutSec }))}
              />
            )}
          </Field>
          <Field
            label="History budget (characters)"
            hint="How much of the earlier conversation is included in follow-up questions; the oldest turns are dropped first. 0 sends no history."
            error={errors[errorKey.maxHistory]}
          >
            {({ id, describedBy, invalid }) => (
              <NumberInput
                id={id}
                value={draft.maxHistoryChars}
                describedBy={describedBy}
                invalid={invalid}
                onChange={(maxHistoryChars) => update((d) => ({ ...d, maxHistoryChars }))}
              />
            )}
          </Field>
          <div className="span-2">
            <Switch
              checked={draft.stripApiKeys}
              onChange={(stripApiKeys) => update((d) => ({ ...d, stripApiKeys }))}
              label="Remove API-key environment variables from CLI calls"
              description="Variables such as ANTHROPIC_API_KEY or OPENAI_API_KEY would make the CLIs bill an API account instead of your subscription. With this on they are removed from every council call; turn it off only if you want API billing."
            />
          </div>
          <Field label="Data directory" className="span-2" hint="Settings and conversations are stored here. Set it with --data-dir when starting the server.">
            {({ id, describedBy }) => (
              <input id={id} className="input mono" value={meta?.dataDir ?? ''} readOnly aria-describedby={describedBy} />
            )}
          </Field>
        </div>
      </div>
      {meta && <p className="muted small">LLM Council {meta.appVersion}{meta.mock ? ' · demo mode' : ''}</p>}
    </div>
  );
}
