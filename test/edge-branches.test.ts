// The last uncovered branches in the otherwise-complete modules: UTF-8
// boundary handling in the truncator, and the single-line paths in the tmux
// parsers.
import { describe, it, expect } from 'vitest';
import { truncateMiddle } from '../src/output';
import { parseProbeOutput, parseJobStatus, JOB_MARKER } from '../src/tmux';

describe('truncateMiddle boundaries', () => {
  it('never splits a multi-byte character', () => {
    // Each emoji is 4 bytes; a naive byte cut would emit a lone surrogate.
    const out = truncateMiddle('🔥'.repeat(400), 200);
    expect(out).not.toContain('�');
    expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out);
  });

  it('keeps accented text intact on both sides of the cut', () => {
    const out = truncateMiddle(('ação çé ' + 'x'.repeat(60) + '\n').repeat(50), 300);
    expect(out).toContain('ação');
    expect(out).not.toContain('�');
  });

  it('truncates as soon as the text exceeds the budget by a single byte', () => {
    // The overlap guard at src/output.ts:38 cannot fire: after the early
    // return len > maxBytes, so tailStart - headEnd = len - maxBytes > 0, and
    // from there headEnd only moves back while tailStart only moves forward.
    // One byte over the budget still truncates rather than returning as-is.
    const out = truncateMiddle('abcdefghij', 9);
    expect(out).not.toBe('abcdefghij');
    expect(out).toContain('omitted');
  });

  it('reports how much it dropped', () => {
    const out = truncateMiddle('linha\n'.repeat(2000), 400);
    expect(out).toMatch(/\[… .* \/ \d+ lines omitted …\]/);
  });
});

describe('tmux parsers on single-line input', () => {
  it('reads a package manager even when tmux is absent', () => {
    expect(parseProbeOutput('tmux=\npm=pacman\n')).toEqual({ tmux: null, pm: 'pacman' });
  });

  it('treats an empty pm value as no package manager found', () => {
    expect(parseProbeOutput('tmux=\npm=\n')).toEqual({ tmux: null, pm: null });
  });

  it('parses a job marker that arrives with no trailing newline', () => {
    const r = parseJobStatus(`${JOB_MARKER} running 3`, '');
    expect(r.state).toBe('running');
    expect(r.elapsedSeconds).toBe(3);
    expect(r.stdout).toBe('');
  });

  it('parses a done marker with no output after it', () => {
    const r = parseJobStatus(`${JOB_MARKER} done 0`, '');
    expect(r.state).toBe('done');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
  });
});
