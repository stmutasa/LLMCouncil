/**
 * The arbiter writes its analysis as one "**Label:** text" entry per line, with single line
 * breaks between them. Markdown would join those lines into one paragraph, so give each
 * labelled entry its own paragraph. Other text is left as written.
 */
export function separateAnalysisEntries(text: string): string {
  return text.replace(/([^\n])\n(?=[ \t]*(?:\*\*|__)[^*_\n]{1,60}:(?:\*\*|__))/g, '$1\n\n');
}
