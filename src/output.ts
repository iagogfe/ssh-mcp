// Human-readable byte size: 512 -> "512 B", 12700 -> "12.4 KB".
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

// Truncate keeping the head and tail, omitting the middle with a marker.
// Measured in UTF-8 bytes; never splits a code point. maxBytes <= 0 disables.
export function truncateMiddle(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return text;
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;

  let headEnd = Math.ceil(maxBytes * 0.6);
  let tailStart = buf.length - (maxBytes - headEnd);

  // Snap head end back to a UTF-8 boundary, preferring the end of a line.
  while (headEnd > 0 && (buf[headEnd] & 0xc0) === 0x80) headEnd--;
  const lastNl = buf.lastIndexOf(0x0a, headEnd - 1);
  if (lastNl > 0) headEnd = lastNl + 1;

  // Snap tail start forward to a UTF-8 boundary, preferring the start of a line.
  while (tailStart < buf.length && (buf[tailStart] & 0xc0) === 0x80) tailStart++;
  const firstNl = buf.indexOf(0x0a, tailStart);
  // Only snap to the next line when the newline is within the first half of the
  // tail region, so the snap is a small alignment step, not a large jump that
  // would collapse the tail to a tiny slice.
  const tailRegion = buf.length - tailStart;
  if (firstNl !== -1 && firstNl < buf.length - 1 && (firstNl - tailStart) * 2 < tailRegion) tailStart = firstNl + 1;

  if (tailStart <= headEnd) return text; // budgets overlap; nothing to omit

  const omitted = buf.subarray(headEnd, tailStart);
  let omittedLines = 0;
  for (const b of omitted) if (b === 0x0a) omittedLines++;

  const head = buf.subarray(0, headEnd).toString('utf8');
  const tail = buf.subarray(tailStart).toString('utf8');
  const sep = head.endsWith('\n') ? '' : '\n';
  return `${head}${sep}[… ${formatBytes(omitted.length)} / ${omittedLines} linhas omitidos …]\n${tail}`;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: string | null;
}

export function formatCommandResult(
  result: CommandResult,
  maxBytes: number,
): { content: { type: 'text'; text: string }[]; isError?: boolean } {
  const { stdout, stderr, exitCode, signal } = result;
  const outText = truncateMiddle(stdout, maxBytes);
  const hasStderr = stderr.trim().length > 0;
  const killedBySignal = (exitCode === null || exitCode === undefined) && !!signal;

  if (exitCode === 0 && !hasStderr) {
    return { content: [{ type: 'text', text: outText }] };
  }

  const lines: string[] = [];
  if (outText.length > 0) lines.push(outText);
  lines.push('---');
  lines.push(killedBySignal ? `[killed by SIG${signal}]` : `[exit ${exitCode}]`);
  if (hasStderr) {
    lines.push('stderr:');
    lines.push(truncateMiddle(stderr, maxBytes));
  }

  const out: { content: { type: 'text'; text: string }[]; isError?: boolean } = {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
  if ((exitCode !== 0 && exitCode !== null && exitCode !== undefined) || killedBySignal) {
    out.isError = true;
  }
  return out;
}
