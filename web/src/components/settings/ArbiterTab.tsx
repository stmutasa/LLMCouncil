import { LIMITS } from '../../../../shared/defaults';
import type { ArbiterConfig } from '../../../../shared/types';
import { arbiterFromMember, arbiterMatchesMember, enabledMembers, errorKey } from '../../lib/settings';
import { useStore } from '../../store';
import { MemberDot } from '../icons';
import { EffortSelect, Field, ModelInput, ProviderSelect, Switch } from './fields';
import type { TabProps } from './SettingsDialog';

export function ArbiterTab({ draft, update, errors }: TabProps) {
  const providers = useStore((s) => s.providers.list);
  const arbiter = draft.arbiter;
  const provider = providers?.find((p) => p.id === arbiter.provider);
  const set = (patch: Partial<ArbiterConfig>) => update((d) => ({ ...d, arbiter: { ...d.arbiter, ...patch } }));
  const direct = enabledMembers(draft).length === 1;

  return (
    <div className="settings-section">
      <div className="section-intro">
        <h3 className="section-title">Arbiter</h3>
        <p className="section-text">
          After the last round the arbiter reads the council's work and writes the final answer. It is a separate seat and
          can use any provider and model.
        </p>
        {direct && <p className="field-hint">Only one member is enabled, so questions are answered directly and the arbiter is not used.</p>}
      </div>

      <div className="quick-picks" role="group" aria-label="Use a council member">
        <span className="field-label">Use a council member</span>
        <div className="quick-pick-buttons">
          {draft.members.map((m) => {
            const current = arbiterMatchesMember(arbiter, m);
            return (
              <button
                key={m.id}
                type="button"
                className={`chip-button${current ? ' on' : ''}`}
                aria-pressed={current}
                onClick={() => update((d) => ({ ...d, arbiter: arbiterFromMember(d.arbiter, m) }))}
              >
                <MemberDot color={m.color} />
                <span>{m.name.trim() || 'Unnamed'}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="card">
        <div className="card-grid">
          <Field label="Name" error={errors[errorKey.arbiterName]}>
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                className="input"
                value={arbiter.name}
                maxLength={LIMITS.maxNameChars + 10}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                onChange={(e) => set({ name: e.target.value })}
              />
            )}
          </Field>
          <Field label="Provider" error={errors[errorKey.arbiterProvider]}>
            {({ id, describedBy, invalid }) => (
              <ProviderSelect
                id={id}
                value={arbiter.provider}
                providers={providers}
                describedBy={describedBy}
                invalid={invalid}
                onChange={(next) => {
                  const nextProvider = providers?.find((p) => p.id === next);
                  set({ provider: next, model: '', effort: nextProvider?.effortLevels.includes(arbiter.effort) ? arbiter.effort : '' });
                }}
              />
            )}
          </Field>
          <Field label="Model">
            {({ id, describedBy }) => (
              <ModelInput id={id} value={arbiter.model} provider={provider} describedBy={describedBy} onChange={(model) => set({ model })} />
            )}
          </Field>
          <Field label="Effort">
            {({ id }) => <EffortSelect id={id} value={arbiter.effort} provider={provider} onChange={(effort) => set({ effort })} />}
          </Field>
          <Field
            label="Instructions for the arbiter"
            className="span-2"
            error={errors[errorKey.arbiterInstructions]}
            hint="Optional. For example: “Answer in under 300 words” or “End with a recommendation”."
          >
            {({ id, describedBy, invalid }) => (
              <textarea
                id={id}
                className="input textarea"
                rows={4}
                value={arbiter.instructions}
                placeholder="None"
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                onChange={(e) => set({ instructions: e.target.value })}
              />
            )}
          </Field>
          <div className="span-2">
            <Switch
              checked={arbiter.analysis}
              onChange={(analysis) => set({ analysis })}
              label="Write a council analysis before the final answer"
              description="A short summary of consensus, contradictions, unique insights and blind spots, shown in its own collapsible section."
            />
          </div>
        </div>
      </div>
    </div>
  );
}
