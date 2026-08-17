// Unit coverage for the remaining SSH-free surface: argv parsing, command
// sanitising, inventory loading from disk, and the connection cache's
// concurrent-create branch.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseArgv, sanitizeCommand, SSHConnectionManager } from '../src/index';
import { loadPlanetfone4Hosts } from '../src/client-map';
import { DestinationManagerCache } from '../src/connection-manager-cache';

const dirs: string[] = [];
function tmp(name: string, body: string): string {
  const d = mkdtempSync(join(tmpdir(), 'cfg-'));
  dirs.push(d);
  const p = join(d, name);
  writeFileSync(p, body);
  return p;
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('parseArgv', () => {
  const withArgv = <T>(args: string[], fn: () => T): T => {
    const saved = process.argv;
    process.argv = ['node', 'index.js', ...args];
    try { return fn(); } finally { process.argv = saved; }
  };

  it('reads key=value flags', () => {
    expect(withArgv(['--host=10.0.0.1', '--port=2222'], parseArgv))
      .toMatchObject({ host: '10.0.0.1', port: '2222' });
  });

  it('gives a bare flag the value null, which callers use to mean "present, no value"', () => {
    expect(withArgv(['--disableSudo'], parseArgv)).toMatchObject({ disableSudo: null });
  });

  it('keeps everything after the first = , so a value may contain one', () => {
    expect(withArgv(['--password=a=b=c'], parseArgv)).toMatchObject({ password: 'a=b=c' });
  });

  it('accepts an empty value, distinct from a bare flag', () => {
    expect(withArgv(['--sudoPassword='], parseArgv)).toMatchObject({ sudoPassword: '' });
  });

  it('ignores positional arguments that are not flags', () => {
    expect(withArgv(['solto', '--host=x', 'outro'], parseArgv)).toEqual({ host: 'x' });
  });

  it('lets a later flag win over an earlier one', () => {
    expect(withArgv(['--host=first', '--host=second'], parseArgv)).toMatchObject({ host: 'second' });
  });
});

describe('sanitizeCommand', () => {
  it('trims surrounding whitespace', () => {
    expect(sanitizeCommand('  echo oi \n')).toBe('echo oi');
  });

  it('rejects an empty or whitespace-only command', () => {
    expect(() => sanitizeCommand('')).toThrow(/cannot be empty/i);
    expect(() => sanitizeCommand('   \n\t ')).toThrow(/cannot be empty/i);
  });

  it('rejects a non-string', () => {
    expect(() => sanitizeCommand(undefined as any)).toThrow(/must be a string/i);
    expect(() => sanitizeCommand(42 as any)).toThrow(/must be a string/i);
  });

  it('passes a command at the default length limit and rejects one over it', () => {
    expect(sanitizeCommand('x'.repeat(1000))).toHaveLength(1000);
    expect(() => sanitizeCommand('x'.repeat(1001))).toThrow(/too long/i);
  });
});

describe('loadPlanetfone4Hosts', () => {
  it('reads and parses an inventory from disk', () => {
    const p = tmp('inv.md', '### Cliente A\n\n- `host-a.internal`\n\n### Cliente B\n\n- `host-b.internal`\n');
    expect(loadPlanetfone4Hosts(p)).toEqual([
      { name: 'Cliente A', hosts: ['host-a.internal'] },
      { name: 'Cliente B', hosts: ['host-b.internal'] },
    ]);
  });

  it('names the file as the problem when it cannot be read', () => {
    expect(() => loadPlanetfone4Hosts('/nao/existe/inv.md')).toThrow(/Unable to read/i);
  });

  it('refuses an inventory with no usable client section', () => {
    const p = tmp('vazio.md', '# So um titulo\n\nprosa sem host nenhum\n');
    expect(() => loadPlanetfone4Hosts(p)).toThrow(/no client sections/i);
  });
});

describe('DestinationManagerCache concurrent create', () => {
  class Fake { closed = false; close() { this.closed = true; } }

  it('keeps the first manager and closes the loser when two creates race', async () => {
    const cache = new DestinationManagerCache<Fake>();
    const first = new Fake();
    const second = new Fake();

    // Both callers find the slot empty, then both finish creating. The loser
    // must discard its own manager rather than leak a second connection.
    const a = cache.getOrCreateAsync('h', 22, 'u', async () => first);
    const b = cache.getOrCreateAsync('h', 22, 'u', async () => {
      await new Promise((r) => setTimeout(r, 5));
      return second;
    });

    expect(await a).toBe(first);
    expect(await b).toBe(first);
    expect(second.closed, 'o manager perdedor tem que ser fechado').toBe(true);
    expect(first.closed).toBe(false);
  });

  it('returns the cached manager without creating a second one', async () => {
    const cache = new DestinationManagerCache<Fake>();
    let creates = 0;
    const make = async () => { creates += 1; return new Fake(); };

    const one = await cache.getOrCreateAsync('h', 22, 'u', make);
    const two = await cache.getOrCreateAsync('h', 22, 'u', make);
    expect(two).toBe(one);
    expect(creates).toBe(1);
  });
});

describe('setSuPassword', () => {
  it('drops an existing elevated shell when the password is cleared', async () => {
    const m = new SSHConnectionManager({ host: 'h', port: 22, username: 'u', suPassword: 'r00t' });
    let ended = false;
    (m as any).suShell = { end() { ended = true; } };
    (m as any).isElevated = true;
    expect(m.isRootShell()).toBe(true);

    await m.setSuPassword(undefined);

    expect(ended, 'o shell root tinha que ser encerrado').toBe(true);
    expect(m.isRootShell()).toBe(false);
    expect(m.getSuPassword()).toBeUndefined();
    m.close();
  });
});
