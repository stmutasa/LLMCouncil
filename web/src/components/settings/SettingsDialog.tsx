import { X } from 'lucide-react';
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Settings } from '../../../../shared/types';
import { closeSettings, saveSettingsDraft } from '../../actions';
import { NARROW_QUERY, useMediaQuery } from '../../hooks/useMediaQuery';
import { errorMessage } from '../../api';
import { settingsEqual, tabForErrorKey, validateSettings } from '../../lib/settings';
import { useStore, type SettingsTab } from '../../store';
import { ConfirmDialog, Dialog } from '../Dialog';
import { ArbiterTab } from './ArbiterTab';
import { CouncilTab } from './CouncilTab';
import { GeneralTab } from './GeneralTab';
import { ProtocolTab } from './ProtocolTab';
import { ProvidersTab } from './ProvidersTab';

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'council', label: 'Council' },
  { id: 'protocol', label: 'Protocol' },
  { id: 'arbiter', label: 'Arbiter' },
  { id: 'providers', label: 'Providers' },
  { id: 'general', label: 'General' },
];

export type UpdateDraft = (fn: (draft: Settings) => Settings) => void;

/**
 * Edits a private draft of the settings, captured when the dialog opens. Nothing reaches the
 * store or the server until Save; changes made elsewhere meanwhile never overwrite the draft.
 */
export function SettingsDialog() {
  const initialTab = useStore((s) => s.settingsDialog.tab);
  const settings = useStore((s) => s.settings);
  const providers = useStore((s) => s.providers.list);
  const [baseline] = useState(() => settings);
  const [draft, setDraft] = useState<Settings | null>(() => (settings ? structuredClone(settings) : null));
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const titleId = useId();
  const narrow = useMediaQuery(NARROW_QUERY);
  const tabRefs = useRef<Map<SettingsTab, HTMLButtonElement>>(new Map());

  const providerIds = useMemo(() => (providers ? new Set(providers.map((p) => p.id)) : null), [providers]);
  const errors = useMemo(() => (draft ? validateSettings(draft, providerIds) : {}), [draft, providerIds]);
  const errorCount = Object.keys(errors).length;
  const tabsWithErrors = useMemo(() => new Set(Object.keys(errors).map(tabForErrorKey)), [errors]);
  const dirty = draft !== null && baseline !== null && !settingsEqual(draft, baseline);

  if (!draft || !baseline) return null;

  const update: UpdateDraft = (fn) => {
    setServerError(null);
    setDraft((d) => (d ? fn(d) : d));
  };

  const requestClose = () => {
    if (saving) return;
    if (dirty) setConfirmDiscard(true);
    else closeSettings();
  };

  const save = async () => {
    if (!dirty || errorCount > 0 || saving) return;
    setSaving(true);
    setServerError(null);
    try {
      await saveSettingsDraft(draft);
      closeSettings();
    } catch (err) {
      setServerError(errorMessage(err));
      setSaving(false);
    }
  };

  const onTabKeyDown = (e: KeyboardEvent, index: number) => {
    const forward = e.key === 'ArrowDown' || e.key === 'ArrowRight';
    const back = e.key === 'ArrowUp' || e.key === 'ArrowLeft';
    let next = -1;
    if (forward) next = (index + 1) % TABS.length;
    else if (back) next = (index - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    if (next === -1) return;
    e.preventDefault();
    const id = TABS[next]!.id;
    setTab(id);
    tabRefs.current.get(id)?.focus();
  };

  const panelId = `${titleId}-panel`;
  const tabId = (id: SettingsTab) => `${titleId}-tab-${id}`;

  return (
    <Dialog onRequestClose={requestClose} labelledBy={titleId} className="settings-dialog">
      <header className="settings-header">
        <h2 id={titleId} className="dialog-title">
          Settings
        </h2>
        <button type="button" className="icon-button" onClick={requestClose} aria-label="Close settings" title="Close">
          <X size={18} aria-hidden="true" />
        </button>
      </header>
      <div className="settings-layout">
        <div className="settings-tabs" role="tablist" aria-label="Settings sections" aria-orientation={narrow ? 'horizontal' : 'vertical'}>
          {TABS.map((t, i) => (
            <button
              key={t.id}
              ref={(el) => {
                if (el) tabRefs.current.set(t.id, el);
                else tabRefs.current.delete(t.id);
              }}
              type="button"
              role="tab"
              id={tabId(t.id)}
              aria-selected={tab === t.id}
              aria-controls={panelId}
              tabIndex={tab === t.id ? 0 : -1}
              className={`settings-tab${tab === t.id ? ' selected' : ''}`}
              onClick={() => setTab(t.id)}
              onKeyDown={(e) => onTabKeyDown(e, i)}
            >
              <span>{t.label}</span>
              {tabsWithErrors.has(t.id) && (
                <span className="tab-error-dot" role="img" aria-label="has errors" />
              )}
            </button>
          ))}
        </div>
        <div className="settings-panel" role="tabpanel" id={panelId} aria-labelledby={tabId(tab)} tabIndex={-1}>
          {tab === 'council' && <CouncilTab draft={draft} update={update} errors={errors} />}
          {tab === 'protocol' && <ProtocolTab draft={draft} update={update} errors={errors} />}
          {tab === 'arbiter' && <ArbiterTab draft={draft} update={update} errors={errors} />}
          {tab === 'providers' && <ProvidersTab draft={draft} saved={baseline} update={update} errors={errors} />}
          {tab === 'general' && <GeneralTab draft={draft} update={update} errors={errors} />}
        </div>
      </div>
      <footer className="settings-footer">
        <div className="settings-footer-message" aria-live="polite">
          {serverError ? (
            <p className="form-error" role="alert">
              {serverError}
            </p>
          ) : errorCount > 0 ? (
            <p className="form-error">
              {errorCount === 1 ? 'Fix the highlighted field before saving.' : `Fix the ${errorCount} highlighted fields before saving.`}
            </p>
          ) : dirty ? (
            <p className="muted small">Unsaved changes</p>
          ) : null}
        </div>
        <div className="dialog-actions">
          <button type="button" className="button" onClick={requestClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="button primary" onClick={() => void save()} disabled={!dirty || errorCount > 0 || saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </footer>
      {confirmDiscard && (
        <ConfirmDialog
          title="Discard unsaved changes?"
          message={<p>Your changes to the settings have not been saved.</p>}
          confirmLabel="Discard changes"
          cancelLabel="Keep editing"
          danger
          onConfirm={() => {
            setConfirmDiscard(false);
            closeSettings();
          }}
          onCancel={() => setConfirmDiscard(false)}
        />
      )}
    </Dialog>
  );
}

export interface TabProps {
  draft: Settings;
  update: UpdateDraft;
  errors: Record<string, string>;
}
