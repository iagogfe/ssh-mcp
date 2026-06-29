import { describe, it, expect } from 'vitest';
import { formatBytes, truncateMiddle } from '../src/output';

describe('formatBytes', () => {
  it('formats bytes, KB and MB', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(12700)).toBe('12.4 KB');
    expect(formatBytes(3_200_000)).toBe('3.1 MB');
  });
});

describe('truncateMiddle', () => {
  it('returns text unchanged when under the limit or limit disabled', () => {
    expect(truncateMiddle('hello', 8192)).toBe('hello');
    const big = 'x'.repeat(10000);
    expect(truncateMiddle(big, 0)).toBe(big);
    expect(truncateMiddle(big, -1)).toBe(big);
  });

  it('keeps head and tail and inserts a marker when over the limit', () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line${i}`).join('\n');
    const out = truncateMiddle(lines, 200);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThan(Buffer.byteLength(lines, 'utf8'));
    expect(out.startsWith('line0')).toBe(true);
    expect(out.endsWith('line999')).toBe(true);
    expect(out).toContain('linhas omitidos');
  });

  it('does not split a multibyte code point (no U+FFFD)', () => {
    const s = 'áé😀'.repeat(2000); // multibyte throughout
    const out = truncateMiddle(s, 300);
    expect(out).not.toContain('�');
    expect(out).toContain('omitidos');
  });

  it('tail line-snap does not collapse tail when newline is near end of buffer', () => {
    // Build input where the only newline in the tail region is very close to end.
    // 2000 'a' chars then '\n' then 5 'b' chars — the newline at index 2000 is near
    // the very end, so old code would snap tailStart past it leaving only "bbbbb".
    const body = 'a'.repeat(2000) + '\n' + 'b'.repeat(5);
    const maxBytes = 100;
    const out = truncateMiddle(body, maxBytes);
    // The tail should carry a meaningful chunk — more than just the 5 'b's.
    const parts = out.split('[…');
    const tail = parts[parts.length - 1].replace(/^[^\]]*\]\n/, '');
    expect(Buffer.byteLength(tail, 'utf8')).toBeGreaterThan(10);
  });

  it('byte length of truncated 1000-line output is bounded by budget plus marker', () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line${i}`).join('\n');
    const maxBytes = 200;
    const out = truncateMiddle(lines, maxBytes);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(maxBytes + 120);
  });

  it('formatBytes edge cases: 0 and exact 1024', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
  });

  it('long single-line (no newlines) is truncated by byte boundary, stays valid UTF-8, contains marker', () => {
    const s = 'x'.repeat(5000);
    const out = truncateMiddle(s, 200);
    expect(out).toContain('omitidos');
    expect(out).not.toContain('�');
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(200 + 120);
  });
});

import { formatCommandResult } from '../src/output';

describe('formatCommandResult', () => {
  const big = 8192;

  it('silent success returns stdout only, no isError', () => {
    const r = formatCommandResult({ stdout: 'ok\n', stderr: '', exitCode: 0 }, big);
    expect(r.content[0].text).toBe('ok\n');
    expect(r.isError).toBeUndefined();
  });

  it('non-zero exit appends an [exit N] footer and marks isError', () => {
    const r = formatCommandResult({ stdout: 'partial', stderr: 'boom', exitCode: 3 }, big);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('partial');
    expect(r.content[0].text).toContain('---');
    expect(r.content[0].text).toContain('[exit 3]');
    expect(r.content[0].text).toContain('boom');
  });

  it('stderr with exit 0 is shown but not an error', () => {
    const r = formatCommandResult({ stdout: 'out', stderr: 'warning', exitCode: 0 }, big);
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain('[exit 0]');
    expect(r.content[0].text).toContain('warning');
  });

  it('signal termination reports [killed by SIG...] and isError', () => {
    const r = formatCommandResult({ stdout: '', stderr: '', exitCode: null, signal: 'TERM' }, big);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('[killed by SIGTERM]');
  });
});
