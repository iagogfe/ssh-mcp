import { describe, expect, it, vi } from 'vitest';
import { resolveCredential, shouldLoadPrivateKey, validateConfig } from '../src/index.js';

describe('client-driven configuration', () => {
  it('prefers the official credential environment variable over the legacy one', () => {
    expect(resolveCredential(undefined, 'fallback-user', 'configured-user')).toBe('configured-user');
    expect(resolveCredential(undefined, 'fallback-pass', 'configured-pass')).toBe('configured-pass');
    expect(resolveCredential(undefined, 'legacy-user', undefined)).toBe('legacy-user');
  });

  it('accepts client mode without a fixed host', () => {
    expect(() => validateConfig({ clientMap: '/tmp/client-map.md' })).not.toThrow();
  });

  it('accepts single-host mode without a client inventory', () => {
    expect(() => validateConfig({ host: '10.0.0.1' })).not.toThrow();
  });

  // A server with neither a host nor an inventory can never resolve a target,
  // so every tool call would fail at runtime. Failing at startup names the
  // problem while the operator is still looking at the configuration.
  it('rejects a configuration with no target at all', () => {
    vi.stubEnv('SSH_MCP_HOST', '');
    vi.stubEnv('SSH_MCP_CLIENT_MAP', '');
    try {
      expect(() => validateConfig({})).toThrow(/Missing target/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('still rejects a non-numeric port', () => {
    expect(() => validateConfig({ host: '10.0.0.1', port: 'not-a-port' })).toThrow(/Invalid --port/);
  });

  it('does not select a private key when password authentication has precedence', () => {
    expect(shouldLoadPrivateKey('test-password', '/not/a-real-key')).toBe(false);
    expect(shouldLoadPrivateKey(undefined, '/not/a-real-key')).toBe(true);
  });
});
