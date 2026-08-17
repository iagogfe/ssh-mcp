import { describe, it, expect } from 'vitest';
import {
  assertSessionName,
  assertToken,
  buildRunScript,
  buildInterruptScript,
  DEFAULT_TMUX_SESSION,
  buildProbeScript,
  parseProbeOutput,
  installHint,
} from '../src/tmux';

describe('assertSessionName', () => {
  it('accepts plain names', () => {
    expect(() => assertSessionName('ssh-mcp')).not.toThrow();
    expect(() => assertSessionName('deploy_1')).not.toThrow();
  });

  it('rejects anything that could break out of the tmux argument', () => {
    for (const bad of ['a b', "a'b", 'a;b', 'a$b', 'a:b', 'a.b', '', '../x']) {
      expect(() => assertSessionName(bad)).toThrow(/session name/i);
    }
  });
});

describe('assertToken', () => {
  it('accepts the manager token format', () => {
    expect(() => assertToken('k1z')).not.toThrow();
    expect(() => assertToken('k2mz')).not.toThrow();
  });

  it('rejects non-alphanumeric tokens', () => {
    for (const bad of ['k1 z', "k1'z", 'k1;z', '', 'k1.z']) {
      expect(() => assertToken(bad)).toThrow(/token/i);
    }
  });
});

describe('buildRunScript', () => {
  const base = { session: DEFAULT_TMUX_SESSION, token: 'k1z', kind: 'exec' as const };

  it('bootstraps the session idempotently, attempting creation before checking', () => {
    const s = buildRunScript(base);
    // Attempt creation first, not has-session-then-create: the latter is a
    // check-then-act race between two concurrent cold calls (see src/tmux.ts).
    // The successful-creation branch is the one that must run has-session as
    // its fallback (not the other way around), so a genuine tmux failure
    // still aborts under `set -e`.
    expect(s).toContain('if tmux new-session -d -s ssh-mcp 2>/dev/null; then');
    expect(s).toContain('else\n  tmux has-session -t ssh-mcp\nfi');
  });

  it('warns on stderr only when it actually created a fresh session, not on every call', () => {
    const s = buildRunScript(base);
    const createLine = 'if tmux new-session -d -s ssh-mcp 2>/dev/null; then';
    const warnLine = 'echo "ssh-mcp: started a fresh tmux session; any previous shell state is gone" >&2';
    const idx = s.indexOf(warnLine);
    expect(idx).toBeGreaterThan(-1);
    // The warning must be the `then` branch's body, i.e. only reached when
    // new-session itself succeeded -- not printed unconditionally, and not
    // printed from the `else` (already-exists) branch.
    expect(s.indexOf(createLine)).toBeLessThan(idx);
    expect(idx).toBeLessThan(s.indexOf('else'));
  });

  it('recovers the workdir from the tmux environment before creating one', () => {
    const s = buildRunScript(base);
    expect(s).toContain('tmux show-environment -t ssh-mcp SSH_MCP_DIR');
    expect(s).toContain('mktemp -d');
    expect(s).toContain('tmux set-environment -t ssh-mcp SSH_MCP_DIR');
    expect(s.indexOf('show-environment')).toBeLessThan(s.indexOf('mktemp -d'));
  });

  it('rejects a workdir path containing quotes or spaces', () => {
    const s = buildRunScript(base);
    // Assert the actual guard -- a case pattern matching a single quote,
    // double quote or space -- not just that the script contains "exit 78"
    // SOMEWHERE. A bare `toContain('exit 78')` stays green even if the case
    // pattern is replaced with something that matches nothing (e.g. *foo*):
    // the exit code is still emitted, on an unreachable branch, and the test
    // would never notice the guard stopped guarding anything.
    expect(s).toContain('case "$D" in *[\\\'\\"\\ ]*) echo "ssh-mcp: unsafe workdir path: $D" >&2; exit 78;; esac');
  });

  it('guards the workdir before persisting it, so a bad path is never recovered from a later call', () => {
    const s = buildRunScript(base);
    expect(s.indexOf('exit 78')).toBeLessThan(s.indexOf('tmux set-environment -t ssh-mcp SSH_MCP_DIR'));
  });

  // The per-workdir prune only ever scans the live session's own directory, so a
  // workdir left behind by a session that died is never reclaimed -- 60 of them
  // had accumulated in /tmp on one host. Sweeping sibling ssh-mcp.* directories
  // happens only when a new workdir is created, which is both rare and the same
  // event that produces the litter; doing it per command would scan /tmp on the
  // latency-critical path for no gain.
  it('sweeps stale sibling workdirs when creating a new one', () => {
    const s = buildRunScript({ session: 'ssh-mcp', token: 'k1z', kind: 'exec' });
    expect(s).toMatch(/-maxdepth 1 -type d -name .ssh-mcp\.\*./);
    expect(s).toContain('-mtime +7');
    // Inside the creation branch, not on every command.
    const sweep = s.indexOf('-maxdepth 1');
    const creation = s.indexOf('mktemp -d');
    const fi = s.indexOf('\nfi', creation);
    expect(sweep).toBeGreaterThan(creation);
    expect(sweep).toBeLessThan(fi);
  });

  it('prunes stale files', () => {
    expect(buildRunScript(base)).toContain("find \"$D\" -type f -mtime +7 -delete");
  });

  it('reads the command from stdin instead of interpolating it', () => {
    const s = buildRunScript(base);
    expect(s).toContain('cat > "$D/cmd.$T"');
  });

  it('sources the command file so cd and export mutate the session shell', () => {
    const s = buildRunScript(base);
    expect(s).toContain(". '$D/cmd.$T'");
    expect(s).not.toContain('source ');
  });

  it('keeps $? unexpanded so the tmux shell evaluates it', () => {
    expect(buildRunScript(base)).toContain('echo \\$? >');
  });

  it('waits on a non-empty rc file, not mere existence', () => {
    const s = buildRunScript(base);
    expect(s).toContain('while [ ! -s "$D/rc.$T" ]');
    // Adaptive cadence: tight while the command is likely short, backing off to
    // the old 0.1 s so a long job does not fork `sleep` hundreds of times.
    expect(s).toContain('sleep 0.002');
    expect(s).toContain('sleep 0.01');
    expect(s).toContain('sleep 0.1');
    expect(s).not.toContain('while [ ! -f "$D/rc.$T" ]');
  });

  // The wait loop's only exit used to be the rc file appearing. Nothing writes
  // it once the tmux session is gone, and the SSH channel the loop runs on has
  // already been abandoned by the timed-out caller -- so the loop spun forever.
  // Verified live: `exec cmd`, `tmux kill-session` on its own session, and
  // deleting the workdir each left a poller at ppid=1 still running minutes
  // later. Ctrl-C recovery cannot help, because it writes rc into the very
  // session/workdir that is gone.
  it('gives up when the workdir disappears', () => {
    const s = buildRunScript({ session: 'ssh-mcp', token: 'k1z', kind: 'exec' });
    expect(s).toContain('if [ ! -d "$D" ]; then');
    expect(s).toMatch(/workdir.*(disappear|gone|vanish)/i);
  });

  it('gives up when the tmux session disappears', () => {
    const s = buildRunScript({ session: 'ssh-mcp', token: 'k1z', kind: 'exec' });
    // The preamble already contains one has-session; asserting its mere
    // presence would pass without the fix. The wait loop adds a second.
    expect(s.match(/tmux has-session -t ssh-mcp/g)?.length).toBe(2);
    expect(s).toMatch(/session.*(disappear|gone|vanish)/i);
  });

  it('checks session liveness periodically, not on every iteration', () => {
    const s = buildRunScript({ session: 'ssh-mcp', token: 'k1z', kind: 'exec' });
    // A has-session fork on every pass would cost more than the poll it guards.
    expect(s).toMatch(/\$\(\(n % \d+\)\)/);
  });

  it('does not add liveness checks to the detached script, which has no wait loop', () => {
    const s = buildRunScript({ session: 'ssh-mcp', token: 'k1z', kind: 'exec', detach: true });
    // The preamble's own has-session stays; what must NOT appear is the second
    // one the wait loop adds, nor the workdir guard.
    expect(s.match(/tmux has-session -t ssh-mcp/g)?.length).toBe(1);
    expect(s).not.toContain('if [ ! -d "$D" ]; then');
  });

  it('returns stdout, stderr and the exit code through the channel', () => {
    const s = buildRunScript(base);
    expect(s).toContain('cat "$D/out.$T"');
    expect(s).toContain('cat "$D/err.$T" >&2');
    expect(s).toContain('exit "$RC"');
  });

  it('runs sudo as a subprocess so root cannot mutate session state', () => {
    const s = buildRunScript({ ...base, kind: 'sudo' });
    expect(s).toContain("sudo -n sh '$D/cmd.$T'");
    expect(s).not.toContain(". '$D/cmd.$T'");
  });

  it('detach backgrounds the subshell and records a start time', () => {
    const s = buildRunScript({ ...base, detach: true });
    expect(s).toContain("date +%s > '$D/start.$T.tmp'");
    expect(s).toContain('; } &');
  });

  it('writes the start timestamp atomically via a temp file and rename, never a direct redirect', () => {
    const s = buildRunScript({ ...base, detach: true });
    expect(s).toContain("date +%s > '$D/start.$T.tmp' && mv '$D/start.$T.tmp' '$D/start.$T'");
    // A bare `>` redirect straight onto start.$T is exactly the non-atomic
    // write this guards against: it would let a poll observe the file after
    // creation but before `date` has written into it.
    expect(s).not.toMatch(/date \+%s > '\$D\/start\.\$T';/);
  });

  it('detach omits the collect block so it returns immediately', () => {
    const s = buildRunScript({ ...base, detach: true });
    expect(s).not.toContain('while [ ! -s "$D/rc.$T" ]');
    expect(s).not.toContain('exit "$RC"');
  });

  it('produces different scripts for different tokens', () => {
    expect(buildRunScript(base)).not.toEqual(buildRunScript({ ...base, token: 'k2z' }));
  });

  it('validates its inputs', () => {
    expect(() => buildRunScript({ ...base, session: 'a;b' })).toThrow();
    expect(() => buildRunScript({ ...base, token: "a'b" })).toThrow();
  });
});

describe('buildInterruptScript', () => {
  it('sends Ctrl-C to the session', () => {
    expect(buildInterruptScript('ssh-mcp')).toContain('tmux send-keys -t ssh-mcp C-c');
  });

  it('validates the session name', () => {
    expect(() => buildInterruptScript('a b')).toThrow();
  });

  it('is unchanged -- a single line, no marker -- when no token is given', () => {
    expect(buildInterruptScript('ssh-mcp')).toBe('tmux send-keys -t ssh-mcp C-c 2>/dev/null || true\n');
  });

  it('plants a synthetic completion marker for the timed-out token, guarded against overwriting a real one', () => {
    const s = buildInterruptScript('ssh-mcp', 'k1z');
    expect(s).toContain('[ ! -s "$D/rc.k1z" ]');
    expect(s).toContain('printf \'130\' > "$D/rc.k1z.tmp"');
    expect(s).toContain('mv "$D/rc.k1z.tmp" "$D/rc.k1z"');
  });

  it('validates the token when one is given', () => {
    expect(() => buildInterruptScript('ssh-mcp', "a'b")).toThrow();
  });
});

describe('buildProbeScript', () => {
  it('checks tmux and falls back to detecting a package manager', () => {
    const s = buildProbeScript();
    expect(s).toContain('command -v tmux');
    for (const pm of ['apt-get', 'apk', 'dnf', 'yum', 'pacman', 'zypper']) {
      expect(s).toContain(pm);
    }
  });

  it('emits a leading newline as its first executable statement', () => {
    const s = buildProbeScript();
    const lines = s.split('\n').filter(line => line.trim().length > 0);
    expect(lines[0]).toBe("printf '\\n'");
  });
});

describe('parseProbeOutput', () => {
  it('reads the tmux version when present', () => {
    expect(parseProbeOutput('tmux=tmux 3.4\n')).toEqual({ tmux: 'tmux 3.4', pm: null });
  });

  it('reads the package manager when tmux is missing', () => {
    expect(parseProbeOutput('tmux=\npm=apt-get\n')).toEqual({ tmux: null, pm: 'apt-get' });
  });

  it('treats a missing tmux with no package manager as both null', () => {
    expect(parseProbeOutput('tmux=\n')).toEqual({ tmux: null, pm: null });
  });

  it('ignores unrelated noise on the channel', () => {
    expect(parseProbeOutput('motd banner\ntmux=tmux 2.8\n')).toEqual({ tmux: 'tmux 2.8', pm: null });
  });

  it('reports tmux absent when the marker is glued to preamble, which the probe script\'s leading newline prevents', () => {
    // This documents why the script-side fix is necessary: the parser cannot recover
    // from glued input, so the script must ensure markers always start on a fresh line.
    expect(parseProbeOutput('Warning: unsupported locale tmux=tmux 3.4\n')).toEqual({ tmux: null, pm: null });
  });

  it('treats empty output as tmux absent', () => {
    expect(parseProbeOutput('')).toEqual({ tmux: null, pm: null });
  });
});

describe('installHint', () => {
  it('names the host and the exact command', () => {
    const msg = installHint('apt-get', 'db01.example.com');
    expect(msg).toContain('db01.example.com');
    expect(msg).toContain('sudo apt-get install -y tmux');
    expect(msg).toContain('--noTmux');
  });

  it('uses each package manager idiom', () => {
    expect(installHint('apk', 'h')).toContain('sudo apk add tmux');
    expect(installHint('pacman', 'h')).toContain('sudo pacman -S --noconfirm tmux');
    expect(installHint('dnf', 'h')).toContain('sudo dnf install -y tmux');
    expect(installHint('yum', 'h')).toContain('sudo yum install -y tmux');
    expect(installHint('zypper', 'h')).toContain('sudo zypper install -y tmux');
  });

  it('degrades without a command line when no package manager was found', () => {
    const msg = installHint(null, 'h');
    expect(msg).toContain('h');
    expect(msg).not.toContain('install -y');
    expect(msg).toContain('--noTmux');
  });

  // src/ is otherwise all-English (as is the whole README); this was the one
  // user-facing message left in Portuguese.
  it('is in English, not Portuguese', () => {
    const msg = installHint('apt-get', 'db01.example.com');
    expect(msg).toContain('tmux not found on db01.example.com');
    expect(msg).toMatch(/persistent session/i);
    expect(msg).not.toMatch(/não encontrado|sessão persistente|instale tmux|gerenciador de pacotes/i);
  });
});

import { buildJobStatusScript, parseJobStatus, JOB_MARKER, JOB_STDERR_MARKER, jobStderrMarker } from '../src/tmux';

describe('buildJobStatusScript', () => {
  const base = { session: 'ssh-mcp', token: 'k7z' };

  it('fails on an unknown job instead of reporting it as running', () => {
    const s = buildJobStatusScript(base);
    expect(s).toContain('[ -e "$D/start.$T" ]');
    expect(s).toContain('exit 78');
  });

  it('emits the done marker before any user output', () => {
    const s = buildJobStatusScript(base);
    const marker = s.indexOf(`printf 'SSH_MCP_JOB done`);
    const out = s.indexOf('cat "$D/out.$T"');
    expect(marker).toBeGreaterThan(-1);
    expect(out).toBeGreaterThan(marker);
  });

  it('emits the running marker with elapsed seconds and partial output', () => {
    const s = buildJobStatusScript(base);
    expect(s).toContain(`printf 'SSH_MCP_JOB running`);
    expect(s).toContain('tail -c 2000 "$D/out.$T"');
    expect(s).toContain('tail -c 2000 "$D/err.$T"');
  });

  it('delimits the job\'s own stderr with a second marker instead of the script\'s real stderr stream', () => {
    // formatCommandResult reformats ANY exit-0 script that produced real
    // stderr, mislabeling the job's stdout as the script's own stderr and
    // appending a bogus [exit 0]. Both branches must route the job's stderr
    // through the marker on the script's single real stdout instead.
    const s = buildJobStatusScript(base);
    expect(s).not.toContain('cat "$D/err.$T" >&2');
    expect(s).not.toContain('tail -c 2000 "$D/err.$T" >&2');
    expect(s).toContain('cat "$D/err.$T"');
    const markerLine = `printf '\\n${jobStderrMarker(base.token)}\\n'`;
    expect(s.split(markerLine).length - 1).toBe(2); // once per branch (done, running)
  });

  it('scopes the stderr marker to the job\'s own token, not a fixed string', () => {
    // A fixed marker could be echoed by the job's own output; a job cannot
    // predict its own random token (see nextToken()), so a marker scoped to
    // it cannot be forged that way.
    const s = buildJobStatusScript(base);
    expect(s).toContain(jobStderrMarker(base.token));
    expect(buildJobStatusScript({ ...base, token: 'k9y' })).not.toContain(jobStderrMarker(base.token));
  });

  it('guards the elapsed-time arithmetic instead of evaluating it directly on unguarded cat output', () => {
    const s = buildJobStatusScript(base);
    expect(s).toContain('S=$(cat "$D/start.$T" 2>/dev/null || true)');
    expect(s).toContain("case \"$S\" in ''|*[!0-9]*) E=0 ;;");
    // The bug this guards against: arithmetic reading straight from a `cat`
    // that could be empty (a transiently-empty start file) blows up under
    // `set -eu` before the marker is ever printed.
    expect(s).not.toMatch(/\$\(\(\s*\$\(date \+%s\)\s*-\s*\$\(cat "\$D\/start\.\$T"\)\s*\)\)/);
  });

  it('reaps the job files only once done', () => {
    const s = buildJobStatusScript(base);
    const rm = s.indexOf('rm -f');
    const elseIdx = s.indexOf('else');
    expect(rm).toBeGreaterThan(-1);
    expect(rm).toBeLessThan(elseIdx);
  });

  it('always exits 0 so the user exit code cannot collide with the state', () => {
    expect(buildJobStatusScript(base).trimEnd().endsWith('exit 0')).toBe(true);
  });

  it('validates its inputs', () => {
    expect(() => buildJobStatusScript({ session: 'a;b', token: 'k7z' })).toThrow();
    expect(() => buildJobStatusScript({ session: 'ssh-mcp', token: 'k 7' })).toThrow();
  });
});

describe('parseJobStatus', () => {
  const token = 't1abc';

  it('parses a running job and splits its stdout from its stderr at the second marker', () => {
    const r = parseJobStatus(`${JOB_MARKER} running 47\nbuilding step 3\n\n${jobStderrMarker(token)}\nwarn\n`, token);
    expect(r.state).toBe('running');
    expect(r.elapsedSeconds).toBe(47);
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toBe('building step 3\n');
    expect(r.stderr).toBe('warn\n');
  });

  it('parses a finished job with its exit code and no stderr marker present', () => {
    const r = parseJobStatus(`${JOB_MARKER} done 10\nall output\n`, token);
    expect(r.state).toBe('done');
    expect(r.exitCode).toBe(10);
    expect(r.elapsedSeconds).toBeNull();
    expect(r.stdout).toBe('all output\n');
    expect(r.stderr).toBe('');
  });

  it('splits a done job with both stdout and stderr', () => {
    const r = parseJobStatus(`${JOB_MARKER} done 3\nout line\n\n${jobStderrMarker(token)}\nerr line\n`, token);
    expect(r.exitCode).toBe(3);
    expect(r.stdout).toBe('out line\n');
    expect(r.stderr).toBe('err line\n');
  });

  it('handles a job with only stderr, no stdout', () => {
    const r = parseJobStatus(`${JOB_MARKER} done 1\n\n${jobStderrMarker(token)}\nerr only\n`, token);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('err only\n');
  });

  it('does not mistake user output that merely resembles the marker for the real, token-scoped one', () => {
    // Neither a bare (unscoped) marker line nor one scoped to a DIFFERENT
    // token can be forged into the real delimiter -- a job cannot predict
    // its own random token, so it cannot produce a line that matches.
    const stdout =
      `${JOB_MARKER} done 0\n` +
      `first part\n${JOB_STDERR_MARKER}\nstill stdout, not a real marker\n` +
      `${jobStderrMarker('wrongtoken')}\nstill stdout too\n`;
    const r = parseJobStatus(stdout, token);
    expect(r.stdout).toBe(
      `first part\n${JOB_STDERR_MARKER}\nstill stdout, not a real marker\n${jobStderrMarker('wrongtoken')}\nstill stdout too\n`,
    );
    expect(r.stderr).toBe('');
  });

  it('does not mistake user output that looks like the marker', () => {
    const r = parseJobStatus(`${JOB_MARKER} running 5\n${JOB_MARKER} done 0\n`, token);
    expect(r.state).toBe('running');
    expect(r.stdout).toBe(`${JOB_MARKER} done 0\n`);
  });

  it('treats a missing marker as a protocol failure', () => {
    expect(() => parseJobStatus('no marker here\n', token)).toThrow(/marker/i);
  });

  it('handles a job with no output yet', () => {
    const r = parseJobStatus(`${JOB_MARKER} running 0\n`, token);
    expect(r.state).toBe('running');
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });
});
