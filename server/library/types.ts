import type { DocumentStatus, LibraryDocument } from '../../shared/types';

/**
 * Bump when extraction changes in a way that should re-read files already in the library.
 * Records written by an older version are re-read on the next sync.
 */
export const EXTRACTOR_VERSION = 1;

/** One page, slide or sheet of a document; label '' when the document is not divided. */
export interface Part {
  label: string;
  text: string;
}

/** Outcome of reading one file or page. */
export type ExtractResult =
  | { status: 'ok'; parts: Part[]; detail: string }
  | { status: Exclude<DocumentStatus, 'ok'>; detail: string };

/**
 * A document as kept in the manifest: the public record plus what sync needs to notice changes.
 * The extra fields never leave the server (see publicDocument).
 */
export interface DocRecord extends LibraryDocument {
  /** Path relative to the folder source (with '/' separators), or the Notion page id. */
  key: string;
  /** File size in bytes; 0 for Notion pages. */
  size: number;
  /** File modification time; 0 for Notion pages (they use modifiedAt). */
  mtimeMs: number;
  extractorVersion: number;
}

export interface SourceSyncRecord {
  lastSyncedAt: string | null;
  /** Why the last sync stopped early; null when it completed. */
  error: string | null;
  /** The folder path the documents were read from, so a changed path is noticed. */
  path: string | null;
}

export interface Manifest {
  version: 1;
  documents: DocRecord[];
  sources: Record<string, SourceSyncRecord>;
}

export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_DOCUMENT_CHARS = 5_000_000;
export const MAX_FILES_PER_SOURCE = 20_000;
export const MAX_FOLDER_DEPTH = 25;

/** Extensions the extractor reads. */
export const SUPPORTED_TYPES = [
  'pdf',
  'docx',
  'doc',
  'pptx',
  'xlsx',
  'xlsm',
  'xls',
  'html',
  'htm',
  'rtf',
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'text',
  'log',
] as const;

/** Google Drive for Desktop link files: the content lives only in Google Drive. */
export const GOOGLE_LINK_TYPES = [
  'gdoc',
  'gsheet',
  'gslides',
  'gdraw',
  'gform',
  'gmap',
  'gsite',
  'gjam',
  'gscript',
  'gtable',
] as const;

export const STUB_DETAIL =
  'A Google Docs link file: its content is stored only in Google Drive. Download it as Word, Excel, PowerPoint or PDF to include it.';
export const TOO_LARGE_DETAIL = 'This file is larger than 100 MB, so it is not read.';
export const PPT_DETAIL = 'Old PowerPoint format; save it as .pptx to include it.';
export const UNSUPPORTED_DETAIL = 'Files of this type are not read.';

const SUPPORTED = new Set<string>(SUPPORTED_TYPES);
const LINKS = new Set<string>(GOOGLE_LINK_TYPES);

/** What a folder scan records for a file without reading it, or null when it must be read. */
export function classifyWithoutReading(type: string, size: number): ExtractResult | null {
  if (LINKS.has(type)) return { status: 'stub', detail: STUB_DETAIL };
  if (type === 'ppt') return { status: 'unsupported', detail: PPT_DETAIL };
  if (!SUPPORTED.has(type)) return { status: 'unsupported', detail: UNSUPPORTED_DETAIL };
  if (size > MAX_FILE_BYTES) return { status: 'too-large', detail: TOO_LARGE_DETAIL };
  return null;
}

export function publicDocument(r: DocRecord): LibraryDocument {
  return {
    id: r.id,
    sourceId: r.sourceId,
    title: r.title,
    location: r.location,
    type: r.type,
    status: r.status,
    detail: r.detail,
    chars: r.chars,
    parts: r.parts,
    modifiedAt: r.modifiedAt,
    url: r.url,
  };
}

/** The file extension, lower case, without the dot; '' when there is none. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}
