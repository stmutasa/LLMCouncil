import { memo, useDeferredValue, useMemo, useRef, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import ReactMarkdown, { type Components, type Options } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { normalizeMathDelimiters } from '../lib/math';
import { CopyButton } from './CopyButton';

const remarkPlugins: Options['remarkPlugins'] = [remarkGfm, [remarkMath, { singleDollarTextMath: false }]];
const rehypePlugins: Options['rehypePlugins'] = [
  [rehypeKatex, { throwOnError: false, strict: 'ignore' }],
  [rehypeHighlight, { detect: false }],
];

function languageOf(children: ReactNode): string {
  const child = Array.isArray(children) ? children[0] : children;
  if (child && typeof child === 'object' && 'props' in child) {
    const className = (child.props as { className?: unknown }).className;
    if (typeof className === 'string') {
      const match = /(?:^|\s)language-([\w+#.-]+)/.exec(className);
      if (match) return match[1]!;
    }
  }
  return '';
}

function CodeBlock({ children, node: _node, ...rest }: ComponentPropsWithoutRef<'pre'> & { node?: unknown }) {
  const ref = useRef<HTMLPreElement>(null);
  const language = languageOf(children);
  return (
    <div className="code-block">
      <div className="code-block-bar">
        <span className="code-block-lang">{language || 'text'}</span>
        <CopyButton getText={() => ref.current?.textContent ?? ''} label="Copy code" />
      </div>
      <pre ref={ref} {...rest}>
        {children}
      </pre>
    </div>
  );
}

function TableWrap({ node: _node, ...rest }: ComponentPropsWithoutRef<'table'> & { node?: unknown }) {
  return (
    <div className="table-wrap" tabIndex={0} role="region" aria-label="Table">
      <table {...rest} />
    </div>
  );
}

function Link({ node: _node, href, children, ...rest }: ComponentPropsWithoutRef<'a'> & { node?: unknown }) {
  return (
    <a {...rest} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/**
 * Model output is untrusted. Remote images would let a prompt-injected answer load arbitrary
 * URLs (tracking, exfiltration through the query string) the moment it is displayed, so they
 * are shown as links the user can choose to open.
 */
function Image({ src, alt }: ComponentPropsWithoutRef<'img'> & { node?: unknown }) {
  const label = alt?.trim() ? `Image: ${alt.trim()}` : 'Image';
  if (typeof src !== 'string' || !src) return <span className="md-image-link">[{label}]</span>;
  return (
    <a className="md-image-link" href={src} target="_blank" rel="noopener noreferrer">
      [{label}]
    </a>
  );
}

const components: Components = {
  pre: CodeBlock,
  table: TableWrap,
  a: Link,
  img: Image,
};

interface MarkdownProps {
  text: string;
  className?: string;
}

/**
 * The single Markdown renderer. Raw HTML is never interpreted (react-markdown shows it as
 * text without rehype-raw), unsafe URLs are dropped by its default URL transform, and the
 * component is memoised on its text so finished messages do not re-render while others stream.
 */
export const Markdown = memo(function Markdown({ text, className }: MarkdownProps) {
  // Streaming text changes every frame; deferring lets React keep input and scrolling responsive
  // while long documents re-render.
  const deferred = useDeferredValue(text);
  const source = useMemo(() => normalizeMathDelimiters(deferred), [deferred]);
  return (
    <div className={className ? `markdown ${className}` : 'markdown'}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  );
});
