export interface ClosableConnectionManager {
  close(): void;
}

/**
 * Keeps SSH connection managers isolated by their destination identity.
 * Credentials are deliberately excluded from the key.
 */
export class DestinationManagerCache<T extends ClosableConnectionManager> {
  private readonly managers = new Map<string, T>();

  private destinationKey(host: string, port: number, username: string): string {
    return `${host}:${port}:${username}`;
  }

  get(host: string, port: number, username: string): T | undefined {
    return this.managers.get(this.destinationKey(host, port, username));
  }

  getOrCreate(host: string, port: number, username: string, create: () => T): T {
    const key = this.destinationKey(host, port, username);
    const existing = this.managers.get(key);
    if (existing) {
      return existing;
    }

    const manager = create();
    this.managers.set(key, manager);
    return manager;
  }

  async getOrCreateAsync(
    host: string,
    port: number,
    username: string,
    create: () => Promise<T>,
  ): Promise<T> {
    const existing = this.get(host, port, username);
    if (existing) {
      return existing;
    }

    const manager = await create();
    const concurrentManager = this.get(host, port, username);
    if (concurrentManager) {
      manager.close();
      return concurrentManager;
    }

    this.managers.set(this.destinationKey(host, port, username), manager);
    return manager;
  }

  closeAll(): void {
    let firstCloseError: unknown;
    let hasCloseError = false;
    for (const manager of this.managers.values()) {
      try {
        manager.close();
      } catch (error) {
        if (!hasCloseError) {
          firstCloseError = error;
          hasCloseError = true;
        }
      }
    }
    this.managers.clear();
    if (hasCloseError) {
      throw firstCloseError;
    }
  }
}
