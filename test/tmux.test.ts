import { describe, it, expect } from 'vitest';
import {
  assertSessionName,
  assertToken,
  buildRunScript,
  buildInterruptScript,
  DEFAULT_TMUX_SESSION,
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

  it('bootstraps the session idempotently', () => {
    const s = buildRunScript(base);
    expect(s).toContain('tmux has-session -t ssh-mcp 2>/dev/null || tmux new-session -d -s ssh-mcp');
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
    expect(s).toContain('exit 78');
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
    expect(s).not.toContain('while [ ! -f "$D/rc.$T" ]');
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
    expect(s).toContain("date +%s > '$D/start.$T'");
    expect(s).toContain('; } &');
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
});
