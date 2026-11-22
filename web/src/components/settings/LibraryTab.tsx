import { FolderPlus, Search } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { LibraryStatus, SourceExcerpt } from '../../../../shared/types';
import { api, errorMessage } from '../../api';
import { useNow } from '../../hooks/useNow';
import { LIMITS } from '../../../../shared/defaults';
import { count } from '../../lib/format';
import { approxTokens, groupExcerpts, joinNames, syncAnnouncements, untestedBrowseProviders, whereText } from '../../lib/library';
import { errorKey } from '../../lib/settings';
import { useStore } from '../../store';
import { Spinner } from '../icons';
import { ClampedText } from '../SourcesBlock';
import { AddFolderDialog } from '../library/AddFolderDialog';
import { DocumentBrowser } from '../library/DocumentBrowser';
import { NotionSection } from '../library/NotionSection';
import { SourceCard } from '../library/SourceCard';
import { EffortSelect, Field, ModelInput, NumberInput, ProviderSelect, Switch } from './fields';
import type { TabProps } from './SettingsDialog';

/**
 * Sources (and Notion) are live: they show and change the saved settings directly. The section
 * "How questions use the library" edits the dialog's draft and is saved with Save.
 */
export function LibraryTab({ draft, update, errors }: TabProps) {
  const live = useStore((s) => s.settings);
  const status = useStore((s) => s.library.status);
  const statusError = useStore((s) => s.library.error);
  const now = useNow(true, 30_000);
  const [adding, setAdding] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const sourcesHeading = useId();

  if (!live) return null;
  const sources = live.library.sources;

  return (
    <div className="settings-section library-tab">
      <div className="section-intro">
        <h3 className="section-title">Library</h3>
        <p className="section-text">
          The library is a searchable copy of the text of your documents, kept on this computer. Passages from it are sent to every
          model that answers a question.
        </p>
      </div>

      <section className="library-section" aria-labelledby={sourcesHeading}>
        <div className="section-title-row">
          <h4 className="subsection-title" id={sourcesHeading}>
            Sources
          </h4>
          <div className="section-actions">
            {sources.length > 0 && (
              <button type="button" className="link-button" onClick={() => setBrowsing(true)} aria-haspopup="dialog">
                Browse documents
              </button>
            )}
            <button
              type="button"
              className="button small"
              onClick={() => setAdding(true)}
              disabled={sources.length >= LIMITS.maxLibrarySources}
              aria-haspopup="dialog"
            >
              <FolderPlus size={14} aria-hidden="true" />
              Add folder
            </button>
          </div>
        </div>
        <p className="field-hint">Changes to sources are saved as you make them.</p>
        {statusError && (
          <p className="small source-line-text" role="status">
            <span className="muted">Could not check the library: {statusError} Trying again…</span>
          </p>
        )}
        {sources.length === 0 ? (
          <p className="empty-note">No sources yet. Add a folder from this computer, including one synced by Google Drive for Desktop, or connect Notion below.</p>
        ) : (
          <ul className="card-list">
            {sources.map((src) => (
              <li key={src.id}>
                <SourceCard
                  source={src}
                  status={status?.sources.find((s) => s.source.id === src.id) ?? null}
                  sources={sources}
                  supportedTypes={status?.supportedTypes ?? []}
                  now={now}
                />
              </li>
            ))}
          </ul>
        )}
        {sources.length >= LIMITS.maxLibrarySources && (
          <p className="field-hint">The library has the maximum of {LIMITS.maxLibrarySources} sources.</p>
        )}
        <SyncAnnouncer status={status} />
      </section>

      <NotionSection live={live} />

      <UsageSection draft={draft} update={update} errors={errors} />

      {sources.length > 0 && <TrySearch />}

      {adding && <AddFolderDialog sources={sources} onClose={() => setAdding(false)} />}
      {browsing && <DocumentBrowser sources={sources} onClose={() => setBrowsing(false)} />}
    </div>
  );
}

/** A polite, quiet live region: announces syncs starting and finishing, never every count. */
function SyncAnnouncer({ status }: { status: LibraryStatus | null }) {
  const previous = useRef<LibraryStatus | null>(status);
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (!status || status === previous.current) return;
    const lines = syncAnnouncements(previous.current, status);
    previous.current = status;
    if (lines.length > 0) setMessage(lines.join(' '));
  }, [status]);
  return (
    <p className="visually-hidden" aria-live="polite">
      {message}
    </p>
  );
}

function UsageSection({ draft, update, errors }: TabProps) {
  const headingId = useId();
  const providers = useStore((s) => s.providers.list);
  const lib = draft.library;
  const planner = lib.planner;
  const untested = providers ? untestedBrowseProviders(draft, providers) : [];
  const plannerProvider = providers?.find((p) => p.id === planner.provider);
  const setLib = (patch: Partial<typeof lib>) => update((d) => ({ ...d, library: { ...d.library, ...patch } }));
  const setPlanner = (patch: Partial<typeof planner>) =>
    update((d) => ({ ...d, library: { ...d.library, planner: { ...d.library.planner, ...patch } } }));
  const tokens = (n: number) => (Number.isFinite(n) && n > 0 ? `${approxTokens(n)}. ` : '');

  return (
    <section className="library-section" aria-labelledby={headingId}>
      <h4 className="subsection-title" id={headingId}>
        How questions use the library
      </h4>
      <p className="field-hint">Saved with the Save button below.</p>
      <div className="card">
        <div className="card-grid">
          <Field
            label="Passage budget (characters)"
            hint={`${tokens(lib.excerptChars)}How much of the library's passages goes into each question. It is sent with every model call of a question.`}
            error={errors[errorKey.excerptChars]}
          >
            {({ id, describedBy, invalid }) => (
              <NumberInput id={id} value={lib.excerptChars} describedBy={describedBy} invalid={invalid} onChange={(excerptChars) => setLib({ excerptChars })} />
            )}
          </Field>
          <Field
            label="Attachment budget (characters)"
            hint={`${tokens(lib.attachmentChars)}Shared by the documents attached to a question. It is sent with every model call of a question.`}
            error={errors[errorKey.attachmentChars]}
          >
            {({ id, describedBy, invalid }) => (
              <NumberInput
                id={id}
                value={lib.attachmentChars}
                describedBy={describedBy}
                invalid={invalid}
                onChange={(attachmentChars) => setLib({ attachmentChars })}
              />
            )}
          </Field>
          <div className="span-2">
            <Switch
              checked={planner.enabled}
              onChange={(enabled) => setPlanner({ enabled })}
              label="Plan the searches with a model"
              description="Before the library is searched, one quick model call turns the question into keyword searches, finding passages that use different words from the question."
            />
          </div>
          <div className={`span-2 planner-fields${planner.enabled ? '' : ' off'}`}>
            <div className="card-grid three">
              <Field label="Planner provider" error={errors[errorKey.plannerProvider]}>
                {({ id, describedBy, invalid }) => (
                  <ProviderSelect
                    id={id}
                    value={planner.provider}
                    providers={providers}
                    describedBy={describedBy}
                    invalid={invalid}
                    onChange={(next) => {
                      const nextProvider = providers?.find((p) => p.id === next);
                      setPlanner({ provider: next, model: '', effort: nextProvider?.effortLevels.includes(planner.effort) ? planner.effort : '' });
                    }}
                  />
                )}
              </Field>
              <Field label="Planner model">
                {({ id, describedBy }) => (
                  <ModelInput id={id} value={planner.model} provider={plannerProvider} describedBy={describedBy} onChange={(model) => setPlanner({ model })} />
                )}
              </Field>
              <Field label="Planner effort">
                {({ id }) => <EffortSelect id={id} value={planner.effort} provider={plannerProvider} onChange={(effort) => setPlanner({ effort })} />}
              </Field>
            </div>
          </div>
          {untested.length > 0 && (
            <div className="span-2">
              <Switch
                checked={lib.browseUntested}
                onChange={(browseUntested) => setLib({ browseUntested })}
                label={`Also let ${joinNames(untested)} open the library`}
                description={`Applies when models may browse. ${joinNames(untested)} can read files, but ${untested.length === 1 ? 'its command-line tool has' : 'their command-line tools have'} not been shown to stay inside the library folder: a document with hidden instructions could lead ${untested.length === 1 ? 'it' : 'them'} to read other files on this computer. Claude has been checked and cannot read outside the folder. Off: ${untested.length === 1 ? 'it gets' : 'they get'} passages only.`}
              />
            </div>
          )}
          <Field
            label="Check for changes every (minutes)"
            hint="0 checks only when you click Check now. Otherwise 5 to 1,440."
            error={errors[errorKey.autoSync]}
          >
            {({ id, describedBy, invalid }) => (
              <NumberInput
                id={id}
                value={lib.autoSyncMinutes}
                describedBy={describedBy}
                invalid={invalid}
                onChange={(autoSyncMinutes) => setLib({ autoSyncMinutes })}
              />
            )}
          </Field>
        </div>
      </div>
    </section>
  );
}

/** Shows what the library returns for a query: exactly what the models would be given (without the planner). */
function TrySearch() {
  const headingId = useId();
  const inputId = useId();
  const [q, setQ] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ query: string; excerpts: SourceExcerpt[] } | null>(null);
  const seq = useRef(0);

  const run = async () => {
    const query = q.trim();
    if (!query) return;
    const mine = ++seq.current;
    setPending(true);
    setError(null);
    try {
      const res = await api.searchLibrary(query);
      if (mine === seq.current) setResult({ query, excerpts: res.excerpts });
    } catch (err) {
      if (mine === seq.current) setError(errorMessage(err));
    } finally {
      if (mine === seq.current) setPending(false);
    }
  };

  const groups = result ? groupExcerpts(result.excerpts) : [];
  return (
    <section className="library-section" aria-labelledby={headingId}>
      <h4 className="subsection-title" id={headingId}>
        Try a search
      </h4>
      <p className="field-hint">See the passages the library would give the models for a question. The search planner is not used here.</p>
      <form
        className="token-row"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <label htmlFor={inputId} className="visually-hidden">
          Search the library
        </label>
        <input
          id={inputId}
          type="search"
          className="input"
          value={q}
          placeholder="For example: Acme contract renewal terms"
          onChange={(e) => setQ(e.target.value)}
          autoComplete="off"
        />
        <button type="submit" className="button small" disabled={!q.trim() || pending}>
          {pending ? <Spinner size={13} /> : <Search size={13} aria-hidden="true" />}
          {pending ? 'Searching…' : 'Search'}
        </button>
      </form>
      <div aria-live="polite">
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        {result && !error && (
          <p className="small muted">
            {result.excerpts.length === 0
              ? `Nothing relevant found for “${result.query}”.`
              : `${count(result.excerpts.length, 'passage')} from ${count(groups.length, 'document')} for “${result.query}”.`}
          </p>
        )}
      </div>
      {result && result.excerpts.length > 0 && (
        <ul className="try-results">
          {result.excerpts.map((e) => (
            <TryResult key={e.id} excerpt={e} />
          ))}
        </ul>
      )}
    </section>
  );
}

function TryResult({ excerpt: e }: { excerpt: SourceExcerpt }) {
  const where = whereText([e.sourceName, e.location, e.part]);
  return (
    <li className="passage try-result">
      <div className="passage-head">
        <span className="cite-id">{e.id}</span>
        <span className="source-title">{e.title}</span>
      </div>
      {where && <p className="source-where">{where}</p>}
      <ClampedText text={e.text} />
    </li>
  );
}
