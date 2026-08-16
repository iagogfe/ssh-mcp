import { describe, expect, it } from 'vitest';
import { DestinationManagerCache } from '../src/connection-manager-cache';

class TestManager {
  closed = false;

  close(): void {
    this.closed = true;
  }
}

describe('destination manager cache', () => {
  it('reuses a manager only for the same host, port, and username', () => {
    const cache = new DestinationManagerCache<TestManager>();
    const create = () => new TestManager();

    const first = cache.getOrCreate('pfone.example', 22, 'support', create);

    expect(cache.getOrCreate('pfone.example', 22, 'support', create)).toBe(first);
    expect(cache.getOrCreate('pftwo.example', 22, 'support', create)).not.toBe(first);
    expect(cache.getOrCreate('pfone.example', 2222, 'support', create)).not.toBe(first);
    expect(cache.getOrCreate('pfone.example', 22, 'other-user', create)).not.toBe(first);
  });

  it('closes every manager and clears cached destinations', () => {
    const cache = new DestinationManagerCache<TestManager>();
    const first = cache.getOrCreate('pfone.example', 22, 'support', () => new TestManager());
    const second = cache.getOrCreate('pftwo.example', 22, 'support', () => new TestManager());

    cache.closeAll();

    expect(first.closed).toBe(true);
    expect(second.closed).toBe(true);
    expect(
      cache.getOrCreate('pfone.example', 22, 'support', () => new TestManager()),
    ).not.toBe(first);
  });

  it('continues closing and clears destinations when a manager close throws', () => {
    class ThrowingManager extends TestManager {
      close(): void {
        super.close();
        throw new Error('close failed');
      }
    }

    const cache = new DestinationManagerCache<TestManager>();
    const throwing = cache.getOrCreate('pfone.example', 22, 'support', () => new ThrowingManager());
    const second = cache.getOrCreate('pftwo.example', 22, 'support', () => new TestManager());

    expect(() => cache.closeAll()).toThrow('close failed');
    expect(throwing.closed).toBe(true);
    expect(second.closed).toBe(true);
    expect(
      cache.getOrCreate('pfone.example', 22, 'support', () => new TestManager()),
    ).not.toBe(throwing);
  });

  it('skips deferred private-key loading when a destination is already cached', async () => {
    const cache = new DestinationManagerCache<TestManager>();
    const first = cache.getOrCreate('pfone.example', 22, 'support', () => new TestManager());
    let keyLoads = 0;

    const cached = await cache.getOrCreateAsync('pfone.example', 22, 'support', async () => {
      keyLoads += 1;
      return new TestManager();
    });

    expect(cached).toBe(first);
    expect(keyLoads).toBe(0);
  });
});
