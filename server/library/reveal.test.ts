import { describe, expect, it } from 'vitest';
import { extractBytes } from './extract/formats';
import { revealCommand, revealFile } from './fsDirs';

describe('revealCommand', () => {
  it('quotes the path inside the argument on Windows, so commas and spaces survive', () => {
    const cmd = revealCommand('C:\\My Files\\Report, final.pdf', 'win32');
    expect(cmd).toEqual({ command: 'explorer.exe', args: ['/select,"C:\\My Files\\Report, final.pdf"'], verbatim: true });
  });

  it('cannot be broken out of with a quote in the name', () => {
    const cmd = revealCommand('C:\\a" /root,C:\\Windows\\b.txt', 'win32');
    expect(cmd.args).toEqual(['/select,"C:\\a /root,C:\\Windows\\b.txt"']);
  });

  it('passes the path as its own argument on macOS and the folder on Linux', () => {
    expect(revealCommand('/Users/x/My Docs/a b.pdf', 'darwin')).toEqual({ command: 'open', args: ['-R', '/Users/x/My Docs/a b.pdf'], verbatim: false });
    expect(revealCommand('/home/x/My Docs/a b.pdf', 'linux')).toEqual({ command: 'xdg-open', args: ['/home/x/My Docs'], verbatim: false });
  });

  it('hands the spawner the verbatim flag', () => {
    const calls: unknown[][] = [];
    revealFile('C:\\x\\y.pdf', (...args) => calls.push(args), 'win32');
    expect(calls).toEqual([['explorer.exe', ['/select,"C:\\x\\y.pdf"'], true]]);
  });
});

describe('converted documents', () => {
  it('do not carry the Markdown escape after a number', async () => {
    const html = '<h1>Notes</h1><p>Date: 2026-07-21. Chair: Y. Demir. Version 3. Done.</p>';
    const result = await extractBytes(new TextEncoder().encode(html), 'html');
    if (result.status !== 'ok') throw new Error(`expected readable text, got ${result.status}`);
    const text = result.parts.map((p) => p.text).join('\n');
    expect(text).toContain('Date: 2026-07-21. Chair');
    expect(text).not.toContain('\\.');
  });
});
