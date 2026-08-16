import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import {
  ClientResolutionError,
  resolveClientHost,
  type ClientResolution,
  type PlanetfoneClient,
} from './client-map.js';

export function resolveClientForProtocol(
  clients: readonly PlanetfoneClient[],
  query: string,
): ClientResolution {
  try {
    return resolveClientHost(clients, query);
  } catch (error) {
    if (error instanceof ClientResolutionError) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, error.message);
    }
    throw error;
  }
}
