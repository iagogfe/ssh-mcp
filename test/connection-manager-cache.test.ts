import { describe, expect, it } from 'vitest';
import { DestinationManagerCache } from '../src/connection-manager-cache';

class TestManager {
  closed = false;

  close(): void {
    this.closed = true;
  }
}

const make = async () => new TestManager();

describe('destination manager cache', () => {
  it('reuses a manager only for the same host, port, and username', async () => {
    const cache = new DestinationManagerCache<TestManager>();

    const first = await cache.getOrCreateAsync('pfone.example', 22, 'support', make);

    expect(await cache.getOrCreateAsync('pfone.example', 22, 'support', make)).toBe(first);
    expect(await cache.getOrCreateAsync('pftwo.example', 22, 'support', make)).not.toBe(first);
    expect(await cache.getOrCreateAsync('pfone.example', 2222, 'support', make)).not.toBe(first);
    expect(await cache.getOrCreateAsync('pfone.example', 22, 'other-user', make)).not.toBe(first);
  });

  it('closes every manager and clears cached destinations', async () => {
    const cache = new DestinationManagerCache<TestManager>();
    const first = await cache.getOrCreateAsync('pfone.example', 22, 'support', make);
    const second = await cache.getOrCreateAsync('pftwo.example', 22, 'support', make);

    cache.closeAll();

    expect(first.closed).toBe(true);
    expect(second.closed).toBe(true);
    expect(await cache.getOrCreateAsync('pfone.example', 22, 'support', make)).not.toBe(first);
  });

  it('continues closing and clears destinations when a manager close throws', async () => {
    class ThrowingManager extends TestManager {
      close(): void {
        super.close();
        throw new Error('close failed');
      }
    }

    const cache = new DestinationManagerCache<TestManager>();
    const throwing = await cache.getOrCreateAsync('pfone.example', 22, 'support', async () => new ThrowingManager());
    const second = await cache.getOrCreateAsync('pftwo.example', 22, 'support', make);

    expect(() => cache.closeAll()).toThrow('close failed');
    expect(throwing.closed).toBe(true);
    expect(second.closed).toBe(true);
    expect(await cache.getOrCreateAsync('pfone.example', 22, 'support', make)).not.toBe(throwing);
  });

  it('skips deferred private-key loading when a destination is already cached', async () => {
    const cache = new DestinationManagerCache<TestManager>();
    const first = await cache.getOrCreateAsync('pfone.example', 22, 'support', make);
    let keyLoads = 0;

    const cached = await cache.getOrCreateAsync('pfone.example', 22, 'support', async () => {
      keyLoads += 1;
      return new TestManager();
    });

    expect(cached).toBe(first);
    expect(keyLoads).toBe(0);
  });
});
