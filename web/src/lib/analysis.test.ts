import { describe, expect, it } from 'vitest';
import { separateAnalysisEntries } from './analysis';

describe('separateAnalysisEntries', () => {
  it('puts each labelled entry in its own paragraph', () => {
    expect(separateAnalysisEntries('**Consensus:** a\n**Contradictions:** None.\n**Blind spots:** b')).toBe(
      '**Consensus:** a\n\n**Contradictions:** None.\n\n**Blind spots:** b',
    );
  });

  it('accepts underscore emphasis and leaves already separated text alone', () => {
    expect(separateAnalysisEntries('__A:__ x\n__B:__ y')).toBe('__A:__ x\n\n__B:__ y');
    expect(separateAnalysisEntries('**A:** x\n\n**B:** y')).toBe('**A:** x\n\n**B:** y');
  });

  it('does not touch ordinary line breaks or bold text without a label', () => {
    const text = 'first line\nsecond line\n**bold** words';
    expect(separateAnalysisEntries(text)).toBe(text);
  });
});
