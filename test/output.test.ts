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
});
