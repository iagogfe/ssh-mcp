import { describe, expect, it } from 'vitest';
import { resolveCredential, shouldLoadPrivateKey, validateConfig } from '../src/index.js';

describe('client-driven configuration', () => {
  it('prefers the official credential environment variable over the legacy one', () => {
    expect(resolveCredential(undefined, 'fallback-user', 'configured-user')).toBe('configured-user');
    expect(resolveCredential(undefined, 'fallback-pass', 'configured-pass')).toBe('configured-pass');
    expect(resolveCredential(undefined, 'legacy-user', undefined)).toBe('legacy-user');
  });

  it('accepts client mode without fixed host or user startup arguments', () => {
    expect(() => validateConfig({})).not.toThrow();
  });

  it('still rejects a non-numeric port', () => {
    expect(() => validateConfig({ port: 'not-a-port' })).toThrow(/Invalid --port/);
  });

  it('does not select a private key when password authentication has precedence', () => {
    expect(shouldLoadPrivateKey('test-password', '/not/a-real-key')).toBe(false);
    expect(shouldLoadPrivateKey(undefined, '/not/a-real-key')).toBe(true);
  });
});
