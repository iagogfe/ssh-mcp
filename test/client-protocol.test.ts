import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { resolveClientForProtocol } from '../src/client-protocol';

const clients = [
  { name: 'Local Example Client', hosts: ['fixture-client-012.example.com'] },
];

const ambiguousClients = [
  { name: 'Example Client B', hosts: ['fixture-client-013.example.com'] },
  { name: 'Example Client B', hosts: ['fixture-client-014.example.com'] },
];

describe('client resolution protocol errors', () => {
  it.each(['', 'Missing Client'])(
    'classifies an invalid client query as InvalidParams: %j',
    (query) => {
      try {
        resolveClientForProtocol(clients, query);
        throw new Error('expected client resolution to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(ProtocolError);
        expect((error as ProtocolError).code).toBe(ProtocolErrorCode.InvalidParams);
      }
    },
  );

  it('classifies a normalized client-name collision as InvalidParams', () => {
    try {
      resolveClientForProtocol(ambiguousClients, 'Example Client B');
      throw new Error('expected ambiguous client resolution to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.InvalidParams);
    }
  });
});
