import { describe, expect, it } from 'vitest';
import { ARBITER_MARKER, splitArbiterOutput } from './arbiter';

describe('splitArbiterOutput', () => {
  it('treats everything as the final answer when analysis is off', () => {
    expect(splitArbiterOutput('  The answer.\n', false, false)).toEqual({ analysis: '', final: 'The answer.', hasMarker: false });
    expect(splitArbiterOutput(`a\n${ARBITER_MARKER}\nb`, false, true).final).toBe(`a\n${ARBITER_MARKER}\nb`);
  });

  it('splits on the marker and strips the analysis heading', () => {
    const raw = `## Council analysis\n\n**Consensus:** yes\n\n${ARBITER_MARKER}\n\n# Final\nBody`;
    expect(splitArbiterOutput(raw, true, true)).toEqual({
      analysis: '**Consensus:** yes',
      final: '# Final\nBody',
      hasMarker: true,
    });
    expect(splitArbiterOutput('### council ANALYSIS\nx\n===FINAL ANSWER===\ny', true, false).analysis).toBe('x');
  });

  it.each([
    '===FINAL ANSWER===',
    '=== FINAL ANSWER ===',
    '=====final answer=====',
    '**===FINAL ANSWER===**',
    '`===FINAL   ANSWER===`',
    '  ===FINAL ANSWER===  ',
  ])('accepts the marker variant %j', (marker) => {
    expect(splitArbiterOutput(`analysis\n${marker}\nfinal`, true, true)).toEqual({
      analysis: 'analysis',
      final: 'final',
      hasMarker: true,
    });
  });

  it('does not accept a marker that is not on its own line', () => {
    const raw = 'analysis mentions ===FINAL ANSWER=== inline\nmore';
    expect(splitArbiterOutput(raw, true, true)).toEqual({ analysis: '', final: raw, hasMarker: false });
  });

  it('hides a partly written marker while streaming', () => {
    expect(splitArbiterOutput('analysis so far\n===FIN', true, false)).toEqual({
      analysis: 'analysis so far',
      final: '',
      hasMarker: false,
    });
    expect(splitArbiterOutput('analysis\n==', true, false).analysis).toBe('analysis');
    expect(splitArbiterOutput('analysis\n**===FINAL AN', true, false).analysis).toBe('analysis');
    expect(splitArbiterOutput('analysis\n=== not a marker', true, false).analysis).toBe('analysis\n=== not a marker');
  });

  it('shows streaming analysis with no final text before the marker', () => {
    expect(splitArbiterOutput('## Council analysis\n**Consensus:** forming', true, false)).toEqual({
      analysis: '**Consensus:** forming',
      final: '',
      hasMarker: false,
    });
  });

  it('treats complete output without a marker as the final answer', () => {
    expect(splitArbiterOutput('Just an answer.', true, true)).toEqual({ analysis: '', final: 'Just an answer.', hasMarker: false });
  });

  it('streams the final answer once the marker has been seen', () => {
    expect(splitArbiterOutput(`a\n${ARBITER_MARKER}\nThe fin`, true, false)).toEqual({ analysis: 'a', final: 'The fin', hasMarker: true });
  });
});
