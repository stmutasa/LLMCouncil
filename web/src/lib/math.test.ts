import { describe, expect, it } from 'vitest';
import { normalizeMathDelimiters as n } from './math';

describe('normalizeMathDelimiters', () => {
  it('leaves text without delimiters untouched', () => {
    const text = 'Plain text with $5 and $$x$$ already.';
    expect(n(text)).toBe(text);
  });

  it('converts inline \\( \\) to $$ $$', () => {
    expect(n('Area is \\(\\pi r^2\\) here.')).toBe('Area is $$\\pi r^2$$ here.');
    expect(n('trim \\( x \\) it')).toBe('trim $$x$$ it');
  });

  it('turns a \\[ \\] block on its own lines into a display block', () => {
    expect(n('Before:\n\\[\nE = mc^2\n\\]\nAfter')).toBe('Before:\n$$\nE = mc^2\n$$\nAfter');
    expect(n('\\[ a + b \\]')).toBe('$$\na + b\n$$');
  });

  it('keeps list indentation so the block stays in the list item', () => {
    expect(n('- item\n  \\[\n  x^2\n  \\]\n- next')).toBe('- item\n  $$\n  x^2\n  $$\n- next');
    expect(n('1. \\[ y \\]')).toBe('1. $$\n   y\n   $$');
  });

  it('keeps block-quote markers on every line', () => {
    expect(n('> \\[\n> z\n> \\]')).toBe('> $$\n> z\n> $$');
  });

  it('uses inline math when \\[ \\] shares its line with other text', () => {
    expect(n('so \\[x=1\\] holds')).toBe('so $$x=1$$ holds');
  });

  it('does not touch fenced code blocks', () => {
    const fenced = '```latex\n\\[ x \\]\n\\(y\\)\n```';
    expect(n(fenced)).toBe(fenced);
    const tilde = '~~~\n\\(y\\)\n~~~\nthen \\(z\\)';
    expect(n(tilde)).toBe('~~~\n\\(y\\)\n~~~\nthen $$z$$');
  });

  it('treats an unclosed fence as code to the end', () => {
    const text = 'a \\(b\\)\n```\n\\(c\\)';
    expect(n(text)).toBe('a $$b$$\n```\n\\(c\\)');
  });

  it('requires a closing fence of the same character and at least the same length', () => {
    const text = '````\n```\n\\(in code\\)\n````\nout \\(x\\)';
    expect(n(text)).toBe('````\n```\n\\(in code\\)\n````\nout $$x$$');
  });

  it('does not touch inline code spans', () => {
    expect(n('Use `\\(x\\)` for inline math, like \\(x\\).')).toBe('Use `\\(x\\)` for inline math, like $$x$$.');
    expect(n('``code with ` and \\(q\\)`` then \\(r\\)')).toBe('``code with ` and \\(q\\)`` then $$r$$');
  });

  it('copies an unmatched backtick run literally and keeps converting', () => {
    expect(n('a ` b \\(c\\)')).toBe('a ` b $$c$$');
  });

  it('ignores escaped delimiters', () => {
    expect(n('A literal \\\\(not math\\\\) here')).toBe('A literal \\\\(not math\\\\) here');
  });

  it('does not end a block at an escaped closer such as \\\\[2pt]', () => {
    const text = '\\[\n\\begin{aligned} a \\\\[2pt] b \\end{aligned}\n\\]';
    expect(n(text)).toBe('$$\n\\begin{aligned} a \\\\[2pt] b \\end{aligned}\n$$');
  });

  it('leaves unclosed or empty delimiters alone', () => {
    expect(n('open \\( never closed')).toBe('open \\( never closed');
    expect(n('empty \\(  \\) pair')).toBe('empty \\(  \\) pair');
  });

  it('handles several expressions and multi-line inline math', () => {
    expect(n('\\(a\\) and \\(b\\)')).toBe('$$a$$ and $$b$$');
    expect(n('x \\(a +\nb\\) y')).toBe('x $$a +\nb$$ y');
  });
});
