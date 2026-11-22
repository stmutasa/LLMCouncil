import { X } from 'lucide-react';
import { useId } from 'react';
import type { LibrarySource } from '../../../../shared/types';
import { useDocumentQuery } from '../../hooks/useDocumentQuery';
import { whereText, type ProblemCount } from '../../lib/library';
import { Dialog } from '../Dialog';
import { DocumentLink } from '../SourcesBlock';
import { DocumentListView } from './DocumentListView';

interface ProblemListDialogProps {
  source: LibrarySource;
  problem: ProblemCount;
  supportedTypes: string[];
  onClose: () => void;
}

function explanation(problem: ProblemCount, source: LibrarySource, supportedTypes: string[]): string {
  switch (problem.status) {
    case 'stub':
      return 'These are links to Google Docs, Sheets or Slides: their content is stored only in Google Drive, not on this computer. To include one, open it in Google Drive and download it as Word, Excel, PowerPoint or PDF into this folder.';
    case 'error':
      return source.kind === 'notion'
        ? 'Notion did not return these pages. They are tried again at the next check.'
        : 'Reading these files failed. They are tried again at the next check; files that are still downloading from the cloud often work then.';
    case 'empty':
      return 'These documents contain no text that can be read. Scanned PDFs are images of pages and need text recognition (OCR) in another app first.';
    case 'unsupported':
      return supportedTypes.length > 0
        ? `Files of these types are listed but not read. Readable types: ${supportedTypes.join(', ')}.`
        : 'Files of these types are listed but not read.';
    case 'too-large':
      return 'Files above the size limit are not read.';
  }
}

/** The documents of one source with one problem status, a page at a time. */
export function ProblemListDialog({ source, problem, supportedTypes, onClose }: ProblemListDialogProps) {
  const titleId = useId();
  const descId = useId();
  const query = useDocumentQuery({ sourceId: source.id, status: [problem.status] });
  return (
    <Dialog onRequestClose={onClose} labelledBy={titleId} describedBy={descId} className="library-dialog">
      <header className="library-dialog-header">
        <div>
          <h2 id={titleId} className="dialog-title">
            {problem.title}
          </h2>
          <p className="muted small">{source.name}</p>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close" title="Close" data-autofocus>
          <X size={18} aria-hidden="true" />
        </button>
      </header>
      <div className="library-dialog-body">
        <p id={descId} className="section-text small">
          {explanation(problem, source, supportedTypes)}
        </p>
        <DocumentListView
          query={query}
          label={problem.title}
          emptyText="None left: they may have been fixed since the last check."
          renderItem={(doc) => (
            <li key={doc.id} className="doc-row">
              <div className="doc-row-main">
                <span className="doc-row-title">{doc.title}</span>
                {whereText([doc.location]) && <span className="doc-row-where">{doc.location}</span>}
                {/* Every link file has the same detail, already explained above. */}
                {doc.detail && problem.status !== 'stub' && <span className="doc-row-detail">{doc.detail}</span>}
              </div>
              <div className="doc-row-actions">
                <DocumentLink documentId={doc.id} url={doc.url} />
              </div>
            </li>
          )}
        />
      </div>
    </Dialog>
  );
}
