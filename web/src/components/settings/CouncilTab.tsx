import { Copy, Plus, Trash } from 'lucide-react';
import { useId } from 'react';
import { LIMITS, MEMBER_COLORS, ROLES, roleById } from '../../../../shared/defaults';
import { mentionHandle } from '../../../../shared/mentions';
import type { MemberConfig, ProviderInfo } from '../../../../shared/types';
import { duplicateMember, errorKey, newMember } from '../../lib/settings';
import { useStore } from '../../store';
import { MemberDot } from '../icons';
import { EffortSelect, Field, ModelInput, ProviderSelect, Switch } from './fields';
import type { TabProps } from './SettingsDialog';

/** Names for MEMBER_COLORS, in the same order, for accessible labels. */
const COLOR_NAMES = ['Clay', 'Green', 'Blue', 'Violet', 'Amber', 'Pink', 'Teal', 'Orange'];

export function CouncilTab({ draft, update, errors }: TabProps) {
  const providers = useStore((s) => s.providers.list);
  const members = draft.members;
  const canAdd = members.length < LIMITS.maxMembers;

  const setMember = (id: string, patch: Partial<MemberConfig>) =>
    update((d) => ({ ...d, members: d.members.map((m) => (m.id === id ? { ...m, ...patch } : m)) }));

  const addMember = () =>
    update((d) => {
      if (d.members.length >= LIMITS.maxMembers) return d;
      const provider = providers?.find((p) => p.installed)?.id ?? d.members[0]?.provider ?? 'claude';
      return { ...d, members: [...d.members, newMember(d.members, provider)] };
    });

  const duplicate = (m: MemberConfig) =>
    update((d) => {
      if (d.members.length >= LIMITS.maxMembers) return d;
      const index = d.members.findIndex((x) => x.id === m.id);
      const copy = duplicateMember(d.members, m);
      const next = d.members.slice();
      next.splice(index + 1, 0, copy);
      return { ...d, members: next };
    });

  const remove = (id: string) =>
    update((d) => (d.members.length <= 1 ? d : { ...d, members: d.members.filter((m) => m.id !== id) }));

  const enabledCount = members.filter((m) => m.enabled).length;

  return (
    <div className="settings-section">
      <div className="section-intro">
        <h3 className="section-title">Council members</h3>
        <p className="section-text">
          Every enabled member answers each question. With exactly one enabled member, it answers directly, without
          rounds or an arbiter. Type <code>@name</code> in a message to ask specific members, including disabled ones.
        </p>
        {enabledCount === 0 && <p className="field-error">No member is enabled: messages will be rejected unless they @mention a member.</p>}
        {errors[errorKey.members] && <p className="field-error">{errors[errorKey.members]}</p>}
      </div>
      <ol className="card-list">
        {members.map((m, i) => (
          <li key={m.id}>
            <MemberCard
              member={m}
              index={i}
              providers={providers}
              errors={errors}
              onChange={(patch) => setMember(m.id, patch)}
              onDuplicate={canAdd ? () => duplicate(m) : null}
              onRemove={members.length > 1 ? () => remove(m.id) : null}
            />
          </li>
        ))}
      </ol>
      <button type="button" className="button" onClick={addMember} disabled={!canAdd}>
        <Plus size={15} aria-hidden="true" />
        {canAdd ? 'Add member' : `Maximum of ${LIMITS.maxMembers} members`}
      </button>
    </div>
  );
}

interface MemberCardProps {
  member: MemberConfig;
  index: number;
  providers: ProviderInfo[] | null;
  errors: Record<string, string>;
  onChange: (patch: Partial<MemberConfig>) => void;
  onDuplicate: (() => void) | null;
  onRemove: (() => void) | null;
}

function MemberCard({ member, index, providers, errors, onChange, onDuplicate, onRemove }: MemberCardProps) {
  const headingId = useId();
  const provider = providers?.find((p) => p.id === member.provider);
  const role = roleById(member.roleId);
  const handle = mentionHandle(member.name);
  const displayName = member.name.trim() || `Member ${index + 1}`;

  return (
    <section className={`card member-card${member.enabled ? '' : ' disabled'}`} aria-labelledby={headingId}>
      <div className="card-header">
        <MemberDot color={member.color} size={10} />
        <h4 className="card-title" id={headingId}>
          {displayName}
        </h4>
        {handle && <span className="handle">@{handle}</span>}
        <div className="card-header-actions">
          <Switch checked={member.enabled} onChange={(enabled) => onChange({ enabled })} label={`${displayName} takes part`} compact />
          <button
            type="button"
            className="icon-button small"
            onClick={onDuplicate ?? undefined}
            disabled={!onDuplicate}
            aria-label={`Duplicate ${displayName}`}
            title="Duplicate"
          >
            <Copy size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button small"
            onClick={onRemove ?? undefined}
            disabled={!onRemove}
            aria-label={`Remove ${displayName}`}
            title={onRemove ? 'Remove' : 'The council needs at least one member'}
          >
            <Trash size={15} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="card-grid">
        <Field label="Name" error={errors[errorKey.memberName(member.id)]}>
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              className="input"
              value={member.name}
              maxLength={LIMITS.maxNameChars + 10}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              onChange={(e) => onChange({ name: e.target.value })}
            />
          )}
        </Field>

        <fieldset className="field color-field">
          <legend className="field-label">Colour</legend>
          <div className="swatches">
            {MEMBER_COLORS.map((c, i) => (
              <button
                key={c}
                type="button"
                aria-pressed={member.color.toLowerCase() === c.toLowerCase()}
                aria-label={COLOR_NAMES[i] ?? c}
                title={COLOR_NAMES[i] ?? c}
                className="swatch"
                style={{ background: c }}
                onClick={() => onChange({ color: c })}
              />
            ))}
          </div>
        </fieldset>

        <Field label="Provider" error={errors[errorKey.memberProvider(member.id)]}>
          {({ id, describedBy, invalid }) => (
            <ProviderSelect
              id={id}
              value={member.provider}
              providers={providers}
              describedBy={describedBy}
              invalid={invalid}
              onChange={(next) => {
                // Models and effort levels are provider-specific; carry them over only when valid.
                const nextProvider = providers?.find((p) => p.id === next);
                onChange({
                  provider: next,
                  model: '',
                  effort: nextProvider?.effortLevels.includes(member.effort) ? member.effort : '',
                });
              }}
            />
          )}
        </Field>

        <Field label="Model">
          {({ id, describedBy }) => (
            <ModelInput id={id} value={member.model} provider={provider} describedBy={describedBy} onChange={(model) => onChange({ model })} />
          )}
        </Field>

        <Field label="Effort">
          {({ id }) => <EffortSelect id={id} value={member.effort} provider={provider} onChange={(effort) => onChange({ effort })} />}
        </Field>

        <Field label="Role" hint={member.roleId === 'custom' ? undefined : role?.description}>
          {({ id, describedBy }) => (
            <select
              id={id}
              className="input select"
              value={role ? member.roleId : 'none'}
              aria-describedby={describedBy}
              onChange={(e) => onChange({ roleId: e.target.value })}
            >
              {ROLES.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          )}
        </Field>

        {member.roleId === 'custom' && (
          <Field label="Custom role" className="span-2" error={errors[errorKey.memberRole(member.id)]} hint="Describe how this member should approach every question.">
            {({ id, describedBy, invalid }) => (
              <textarea
                id={id}
                className="input textarea"
                rows={3}
                value={member.customRole}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                onChange={(e) => onChange({ customRole: e.target.value })}
              />
            )}
          </Field>
        )}
      </div>
    </section>
  );
}
