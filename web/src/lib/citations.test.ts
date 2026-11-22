import { createElement, type ComponentPropsWithoutRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { describe, expect, it } from 'vitest';
import { CITATION_ATTRIBUTE, CITATION_ELEMENT, EMPTY_LOOKUP, buildCitationLookups, remarkCitations, splitCitations } from './citations';
import { attachment, excerpt, library } from './testFixtures';

describe('splitCitations', () => {
  it('returns plain text untouched', () => {
    expect(splitCitations('no citations here')).toEqual([{ type: 'text', value: 'no citations here' }]);
    expect(splitCitations('[x] and [S] and [S1a] and [s1]')).toEqual([{ type: 'text', value: '[x] and [S] and [S1a] and [s1]' }]);
  });

  it('finds single and grouped citations', () => {
    expect(splitCitations('Revenue grew [S3], see [D1].')).toEqual([
      { type: 'text', value: 'Revenue grew ' },
      { type: 'cite', ids: ['S3'], raw: '[S3]' },
      { type: 'text', value: ', see ' },
      { type: 'cite', ids: ['D1'], raw: '[D1]' },
      { type: 'text', value: '.' },
    ]);
    expect(splitCitations('[S1, S12; D2]')).toEqual([{ type: 'cite', ids: ['S1', 'S12', 'D2'], raw: '[S1, S12; D2]' }]);
    expect(splitCitations('[S1][S2]')).toEqual([
      { type: 'cite', ids: ['S1'], raw: '[S1]' },
      { type: 'cite', ids: ['S2'], raw: '[S2]' },
    ]);
  });

  it('does not match partial groups', () => {
    expect(splitCitations('[S1, see below]')).toEqual([{ type: 'text', value: '[S1, see below]' }]);
  });
});

/** Renders Markdown through the plugin, showing citations as <cite data-citation="…">. */
function render(markdown: string): string {
  const components: Components = {
    [CITATION_ELEMENT]: (props: ComponentPropsWithoutRef<'cite'>) =>
      createElement('mark', { 'data-ids': String((props as Record<string, unknown>)[CITATION_ATTRIBUTE]) }, props.children),
  };
  return renderToStaticMarkup(
    createElement(ReactMarkdown, {
      remarkPlugins: [remarkGfm, [remarkMath, { singleDollarTextMath: false }], remarkCitations],
      components,
      children: markdown,
    }),
  );
}

describe('remarkCitations', () => {
  it('turns citations in prose into citation elements', () => {
    expect(render('Growth was 12% [S3].')).toBe('<p>Growth was 12% <mark data-ids="S3">[S3]</mark>.</p>');
    expect(render('Both [S1, D2] agree.')).toBe('<p>Both <mark data-ids="S1 D2">[S1, D2]</mark> agree.</p>');
  });

  it('works inside emphasis, lists, headings and tables', () => {
    expect(render('*see [S1]*')).toBe('<p><em>see <mark data-ids="S1">[S1]</mark></em></p>');
    expect(render('- one [S2]\n- two')).toContain('<li>one <mark data-ids="S2">[S2]</mark></li>');
    expect(render('## Terms [D1]')).toBe('<h2>Terms <mark data-ids="D1">[D1]</mark></h2>');
    expect(render('| a | b |\n|---|---|\n| x [S4] | y |')).toContain('<td>x <mark data-ids="S4">[S4]</mark></td>');
  });

  it('never touches code spans, fenced code or math', () => {
    expect(render('Use `arr[S1]` here')).toBe('<p>Use <code>arr[S1]</code> here</p>');
    const fenced = render('```js\nconst x = y[S1];\n```');
    expect(fenced).not.toContain('<mark');
    expect(fenced).toContain('y[S1]');
    expect(render('    indented [S1]')).not.toContain('<mark');
    expect(render('$$x[S1]$$')).not.toContain('<mark');
  });

  it('leaves link text and real links alone', () => {
    expect(render('[S1](https://example.com)')).toBe('<p><a href="https://example.com">S1</a></p>');
    expect(render('[see [S1]](https://example.com)')).not.toContain('<mark');
  });

  it('keeps text that only looks similar', () => {
    expect(render('Array [1] and [S] and [x]')).toBe('<p>Array [1] and [S] and [x]</p>');
  });
});

describe('buildCitationLookups', () => {
  it('resolves ids from the turn first, then from earlier turns', () => {
    const lookups = buildCitationLookups([
      { turnId: 't1', library: library({ excerpts: [excerpt('S1', 'a', { title: 'Old title' }), excerpt('S2', 'b')], attachments: [attachment('D1', 'x')] }) },
      { turnId: 't2', library: null },
      { turnId: 't3', library: library({ excerpts: [excerpt('S1', 'a', { title: 'Acme MSA.pdf', part: 'p. 4' }), excerpt('S3', 'c')] }) },
    ]);
    const t1 = lookups.get('t1')!;
    expect(t1.get('S1')).toMatchObject({ turnId: 't1', title: 'Old title', kind: 'passage' });
    expect(t1.get('D1')).toMatchObject({ turnId: 't1', kind: 'document', where: 'Drive' });
    expect(t1.has('S3')).toBe(false);

    const t2 = lookups.get('t2')!;
    expect(t2.get('S2')?.turnId).toBe('t1');
    expect(t2.has('S3')).toBe(false);

    const t3 = lookups.get('t3')!;
    expect(t3.get('S1')).toMatchObject({ turnId: 't3', title: 'Acme MSA.pdf', where: 'Drive · Contracts · p. 4' });
    expect(t3.get('S2')?.turnId).toBe('t1');
    expect(t3.get('D1')?.turnId).toBe('t1');
  });

  it('shares one empty lookup when nothing was cited', () => {
    const lookups = buildCitationLookups([
      { turnId: 't1', library: null },
      { turnId: 't2', library: library() },
    ]);
    expect(lookups.get('t1')).toBe(EMPTY_LOOKUP);
    expect(lookups.get('t2')).toBe(EMPTY_LOOKUP);
  });
});
