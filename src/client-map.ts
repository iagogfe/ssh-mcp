import { readFileSync } from 'node:fs';

export interface PlanetfoneClient {
  name: string;
  hosts: string[];
}

export interface ClientResolution {
  clientName: string;
  host: string;
  hosts: string[];
}

export class ClientResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientResolutionError';
  }
}

export function normalizeClientName(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase('pt-BR')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ');
}

const clientHeading = /^###\s+(.+?)\s*$/;
const anyHeading = /^#{1,6}\s+/;
const hostPattern = /\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\b/gi;

export function parsePlanetfone4Hosts(markdown: string): PlanetfoneClient[] {
  const clients: PlanetfoneClient[] = [];
  let current: PlanetfoneClient | undefined;

  const flush = () => {
    if (current && current.hosts.length > 0) {
      clients.push(current);
    }
    current = undefined;
  };

  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(clientHeading);
    if (heading) {
      flush();
      current = { name: heading[1].trim(), hosts: [] };
      continue;
    }
    if (anyHeading.test(line)) {
      flush();
      continue;
    }
    if (!current || !/^\s*-\s+/.test(line)) {
      continue;
    }

    const code = line.match(/`([^`]+)`/g);
    if (!code) {
      continue;
    }
    for (const segment of code) {
      const hosts = segment.slice(1, -1).match(hostPattern) ?? [];
      for (const candidate of hosts) {
        // Any host is accepted. This used to be filtered to a single hardcoded
        // domain suffix, which silently dropped every entry outside it and made
        // the inventory unusable for anyone else — including the test fixture,
        // which has to point at the local SSH endpoint.
        const host = candidate.toLowerCase();
        if (!current.hosts.includes(host)) {
          current.hosts.push(host);
        }
      }
    }
  }
  flush();

  if (clients.length === 0) {
    throw new Error('Planetfone inventory contains no client sections with hosts');
  }
  return clients;
}

export function loadPlanetfone4Hosts(filePath: string): PlanetfoneClient[] {
  let markdown: string;
  try {
    markdown = readFileSync(filePath, 'utf8');
  } catch {
    throw new Error('Unable to read Planetfone inventory file');
  }
  return parsePlanetfone4Hosts(markdown);
}

export function resolveClientHost(
  clients: readonly PlanetfoneClient[],
  query: string,
): ClientResolution {
  const normalizedQuery = normalizeClientName(query);
  if (!normalizedQuery) {
    throw new ClientResolutionError('Client name cannot be empty');
  }

  const matches = clients.filter((client) => normalizeClientName(client.name) === normalizedQuery);
  if (matches.length > 1) {
    throw new ClientResolutionError(
      `Ambiguous client name: ${query}. Matches: ${matches.map((client) => client.name).join(', ')}`,
    );
  }

  const [match] = matches;
  if (match) {
    const [host] = match.hosts;
    if (host) {
      return { clientName: match.name, host, hosts: [...match.hosts] };
    }
  }

  const suggestions = clients
    .map((client) => {
      const normalizedName = normalizeClientName(client.name);
      let rank = 3;
      if (normalizedName.startsWith(normalizedQuery) || normalizedQuery.startsWith(normalizedName)) {
        rank = 0;
      } else if (normalizedName.includes(normalizedQuery) || normalizedQuery.includes(normalizedName)) {
        rank = 1;
      }
      return { client, rank };
    })
    .filter(({ rank }) => rank < 3)
    .sort((left, right) => left.rank - right.rank || left.client.name.localeCompare(right.client.name))
    .slice(0, 3)
    .map(({ client }) => client.name);

  const suffix = suggestions.length > 0 ? ` Suggestions: ${suggestions.join(', ')}` : '';
  throw new ClientResolutionError(`Client not found: ${query}.${suffix}`);
}
