import { ArrowDown, ArrowUp, Copy, Plus, Trash } from 'lucide-react';
import { useId } from 'react';
import { DEFAULT_PROTOCOL_ID, LIMITS, ROUND_TYPE_META, roundTitle } from '../../../../shared/defaults';
import type { Protocol, RoundConfig, RoundType } from '../../../../shared/types';
import { plural } from '../../lib/format';
import { activeProtocol, duplicateProtocol, errorKey, moveRound, newRound } from '../../lib/settings';
import { Field, Switch } from './fields';
import type { TabProps } from './SettingsDialog';

export function ProtocolTab({ draft, update, errors }: TabProps) {
  const groupName = useId();
  const active = activeProtocol(draft);

  const setProtocol = (id: string, fn: (p: Protocol) => Protocol) =>
    update((d) => ({ ...d, protocols: d.protocols.map((p) => (p.id === id && !p.builtin ? fn(p) : p)) }));

  const duplicate = (source: Protocol) =>
    update((d) => {
      const copy = duplicateProtocol(d.protocols, source);
      return { ...d, protocols: [...d.protocols, copy], activeProtocolId: copy.id };
    });

  const remove = (id: string) =>
    update((d) => {
      const protocols = d.protocols.filter((p) => p.id !== id || p.builtin);
      return { ...d, protocols, activeProtocolId: d.activeProtocolId === id ? DEFAULT_PROTOCOL_ID : d.activeProtocolId };
    });

  return (
    <div className="settings-section">
      <div className="section-intro">
        <h3 className="section-title">Protocol</h3>
        <p className="section-text">
          A protocol is the sequence of rounds the council works through before the arbiter writes the final answer.
        </p>
      </div>

      <fieldset className="protocol-list">
        <legend className="visually-hidden">Active protocol</legend>
        {draft.protocols.map((p) => (
          <label key={p.id} className={`protocol-option${p.id === active?.id ? ' selected' : ''}`}>
            <input
              type="radio"
              name={groupName}
              checked={p.id === active?.id}
              onChange={() => update((d) => ({ ...d, activeProtocolId: p.id }))}
            />
            <span className="protocol-option-body">
              <span className="protocol-option-name">
                {p.name.trim() || 'Untitled protocol'}
                {p.builtin && <span className="badge">Built-in</span>}
                {(errors[errorKey.protocolName(p.id)] || errors[errorKey.protocolRounds(p.id)]) && (
                  <span className="badge danger">Needs attention</span>
                )}
              </span>
              <span className="protocol-option-description">
                {p.description ? `${p.description} · ` : ''}
                {plural(p.rounds.length, 'round')}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      {active &&
        (active.builtin ? (
          <BuiltinProtocol protocol={active} onDuplicate={() => duplicate(active)} />
        ) : (
          <CustomProtocol
            protocol={active}
            errors={errors}
            onChange={(fn) => setProtocol(active.id, fn)}
            onDuplicate={() => duplicate(active)}
            onDelete={() => remove(active.id)}
          />
        ))}

      <div className="council-rules">
        <Field
          label="Council rules"
          hint="Applied to every member in every round, for example a required answer format or audience."
          error={errors[errorKey.councilRules]}
        >
          {({ id, describedBy, invalid }) => (
            <textarea
              id={id}
              className="input textarea"
              rows={4}
              value={draft.councilRules}
              placeholder="None"
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              onChange={(e) => update((d) => ({ ...d, councilRules: e.target.value }))}
            />
          )}
        </Field>
      </div>
    </div>
  );
}

function BuiltinProtocol({ protocol, onDuplicate }: { protocol: Protocol; onDuplicate: () => void }) {
  return (
    <section className="card" aria-label={`${protocol.name} rounds`}>
      <div className="card-header">
        <h4 className="card-title">{protocol.name}</h4>
        <div className="card-header-actions">
          <button type="button" className="button small" onClick={onDuplicate}>
            <Copy size={14} aria-hidden="true" />
            Duplicate to customise
          </button>
        </div>
      </div>
      <p className="field-hint">Built-in protocols are read-only.</p>
      <ol className="round-summary-list">
        {protocol.rounds.map((r, i) => (
          <li key={r.id}>
            <span className="round-summary-title">
              Round {i + 1} · {roundTitle(r)}
            </span>
            <span className="round-summary-text">
              {ROUND_TYPE_META[r.type].description}
              {r.type !== 'answer' && r.anonymize ? ' Authors are hidden.' : ''}
              {r.type === 'review' && r.includeSelf ? ' Members also review their own answer.' : ''}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

interface CustomProtocolProps {
  protocol: Protocol;
  errors: Record<string, string>;
  onChange: (fn: (p: Protocol) => Protocol) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

function CustomProtocol({ protocol, errors, onChange, onDuplicate, onDelete }: CustomProtocolProps) {
  const canAdd = protocol.rounds.length < LIMITS.maxRounds;
  const setRound = (id: string, patch: Partial<RoundConfig>) =>
    onChange((p) => ({ ...p, rounds: p.rounds.map((r) => (r.id === id ? { ...r, ...patch } : r)) }));

  return (
    <section className="card" aria-label="Edit protocol">
      <div className="card-header">
        <h4 className="card-title">{protocol.name.trim() || 'Untitled protocol'}</h4>
        <div className="card-header-actions">
          <button type="button" className="button small" onClick={onDuplicate}>
            <Copy size={14} aria-hidden="true" />
            Duplicate
          </button>
          <button type="button" className="button small danger-outline" onClick={onDelete}>
            <Trash size={14} aria-hidden="true" />
            Delete protocol
          </button>
        </div>
      </div>
      <div className="card-grid">
        <Field label="Name" error={errors[errorKey.protocolName(protocol.id)]}>
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              className="input"
              value={protocol.name}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              onChange={(e) => onChange((p) => ({ ...p, name: e.target.value }))}
            />
          )}
        </Field>
        <Field label="Description">
          {({ id }) => (
            <input
              id={id}
              className="input"
              value={protocol.description}
              placeholder="Optional"
              onChange={(e) => onChange((p) => ({ ...p, description: e.target.value }))}
            />
          )}
        </Field>
      </div>

      <h5 className="subsection-title">Rounds</h5>
      {errors[errorKey.protocolRounds(protocol.id)] && <p className="field-error">{errors[errorKey.protocolRounds(protocol.id)]}</p>}
      <ol className="card-list rounds-editor">
        {protocol.rounds.map((r, i) => (
          <li key={r.id}>
            <RoundEditor
              round={r}
              index={i}
              count={protocol.rounds.length}
              error={errors[errorKey.roundInstructions(r.id)]}
              onChange={(patch) => setRound(r.id, patch)}
              onMove={(delta) => onChange((p) => ({ ...p, rounds: moveRound(p.rounds, i, delta) }))}
              onRemove={() => onChange((p) => ({ ...p, rounds: p.rounds.filter((x) => x.id !== r.id) }))}
            />
          </li>
        ))}
      </ol>
      <button
        type="button"
        className="button"
        disabled={!canAdd}
        onClick={() => onChange((p) => (p.rounds.length >= LIMITS.maxRounds ? p : { ...p, rounds: [...p.rounds, newRound('review')] }))}
      >
        <Plus size={15} aria-hidden="true" />
        {canAdd ? 'Add round' : `Maximum of ${LIMITS.maxRounds} rounds`}
      </button>
    </section>
  );
}

interface RoundEditorProps {
  round: RoundConfig;
  index: number;
  count: number;
  error: string | undefined;
  onChange: (patch: Partial<RoundConfig>) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}

function RoundEditor({ round, index, count, error, onChange, onMove, onRemove }: RoundEditorProps) {
  const first = index === 0;
  const label = `Round ${index + 1}`;
  return (
    <div className="round-editor">
      <div className="round-editor-header">
        <span className="round-editor-title">{label}</span>
        {!first && (
          <div className="card-header-actions">
            <button type="button" className="icon-button small" onClick={() => onMove(-1)} disabled={index <= 1} aria-label={`Move ${label} up`} title="Move up">
              <ArrowUp size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="icon-button small"
              onClick={() => onMove(1)}
              disabled={index >= count - 1}
              aria-label={`Move ${label} down`}
              title="Move down"
            >
              <ArrowDown size={15} aria-hidden="true" />
            </button>
            <button type="button" className="icon-button small" onClick={onRemove} aria-label={`Remove ${label}`} title="Remove">
              <Trash size={15} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
      <div className="card-grid">
        <Field label="Type" hint={ROUND_TYPE_META[round.type].description}>
          {({ id, describedBy }) =>
            first ? (
              <input id={id} className="input" value={ROUND_TYPE_META.answer.title} readOnly aria-describedby={describedBy} />
            ) : (
              <select
                id={id}
                className="input select"
                value={round.type}
                aria-describedby={describedBy}
                onChange={(e) => {
                  const type = e.target.value as RoundType;
                  onChange({ type, includeSelf: type === 'review' ? round.includeSelf : false });
                }}
              >
                <option value="review">{ROUND_TYPE_META.review.title}</option>
                <option value="revise">{ROUND_TYPE_META.revise.title}</option>
              </select>
            )
          }
        </Field>
        <Field label="Title">
          {({ id }) => (
            <input
              id={id}
              className="input"
              value={round.title}
              placeholder={ROUND_TYPE_META[round.type].title}
              onChange={(e) => onChange({ title: e.target.value })}
            />
          )}
        </Field>
        {!first && (
          <div className="span-2 switch-stack">
            <Switch
              checked={round.anonymize}
              onChange={(anonymize) => onChange({ anonymize })}
              label="Hide authors"
              description="Members see the other answers under labels such as “Response A”, without names."
            />
            {round.type === 'review' && (
              <Switch
                checked={round.includeSelf}
                onChange={(includeSelf) => onChange({ includeSelf })}
                label="Members also review their own answer"
                description="Each reviewer ranks its own answer alongside the others."
              />
            )}
          </div>
        )}
        <Field label="Rules for this round" className="span-2" error={error} hint="Optional. Added to every member's instructions in this round.">
          {({ id, describedBy, invalid }) => (
            <textarea
              id={id}
              className="input textarea"
              rows={2}
              value={round.instructions}
              placeholder="None"
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              onChange={(e) => onChange({ instructions: e.target.value })}
            />
          )}
        </Field>
      </div>
    </div>
  );
}
