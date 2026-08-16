import { describe, expect, it } from 'vitest';
import {
  normalizeClientName,
  parsePlanetfone4Hosts,
  resolveClientHost,
} from '../src/client-map';

const markdown = `# Hosts únicos

- \`fixture-client-007.planetarium.com.br\`

### Example Client

- Wiki: [Example Client](http://wiki.example/Example Client)
- \`fixture-client-004.planetarium.com.br\`
- \`fixture-client-005.planetarium.com.br\`
- \`fixture-client-004.planetarium.com.br\`
Texto que não é um host.
- \`192.0.2.10\`

### Example Client B

- Acesso: \`fixture-client-006.planetarium.com.br\`
- \`fixture-client-006.planetarium.com.br\`

### Sem acesso

- Nenhum servidor cadastrado.

### Domínio externo

- \`ssh.example.net\`
`;

describe('Planetfone client inventory', () => {
  it('normalizes case, accents, and repeated whitespace', () => {
    expect(normalizeClientName('  EXAMPLE   client  ')).toBe('example client');
  });

  it('parses client sections while ignoring global hosts, prose, links, IPs, and empty sections', () => {
    expect(parsePlanetfone4Hosts(markdown)).toEqual([
      {
        name: 'Example Client',
        hosts: ['fixture-client-004.planetarium.com.br', 'fixture-client-005.planetarium.com.br'],
      },
      { name: 'Example Client B', hosts: ['fixture-client-006.planetarium.com.br'] },
    ]);
  });

  it('resolves an exact normalized client name to its first host', () => {
    const clients = parsePlanetfone4Hosts(markdown);

    expect(resolveClientHost(clients, 'Example Client')).toEqual({
      clientName: 'Example Client',
      host: 'fixture-client-004.planetarium.com.br',
      hosts: ['fixture-client-004.planetarium.com.br', 'fixture-client-005.planetarium.com.br'],
    });
  });

  it('rejects ambiguous client names after normalization', () => {
    const clients = [
      { name: 'Example Client B', hosts: ['fixture-client-006.planetarium.com.br'] },
      { name: 'Example Client B', hosts: ['fixture-client-008.planetarium.com.br'] },
    ];

    expect(() => resolveClientHost(clients, 'Example Client B')).toThrowError(
      /ambiguous.*Example Client B.*Example Client B/i,
    );
  });

  it('reports a missing client with at most three nearby names and no secrets', () => {
    const clients = [
      { name: 'Example Client Example Client Parts', hosts: ['fixture-client-009.planetarium.com.br'] },
      { name: 'Example Client Example Client Used', hosts: ['fixture-client-010.planetarium.com.br'] },
      { name: 'Example Client Services', hosts: ['fixture-client-011.planetarium.com.br'] },
      { name: 'Example Client B', hosts: ['fixture-client-006.planetarium.com.br'] },
    ];

    let suggestionMessage = '';
    try {
      resolveClientHost(clients, 'Example Client');
    } catch (error) {
      suggestionMessage = String(error);
    }
    expect(suggestionMessage).toMatch(/Example Client.*Example Client/i);
    expect(suggestionMessage).toContain('Example Client Example Client Parts');
    expect(suggestionMessage).toContain('Example Client Example Client Used');
    expect(suggestionMessage).not.toContain('Example Client Services');

    try {
      resolveClientHost(clients, 'missing client');
      throw new Error('expected resolution to fail');
    } catch (error) {
      const message = String(error);
      expect(message).toContain('missing client');
      expect(message).not.toMatch(/senha|password|usuario|user|secret/i);
      expect(message.split(/\n/).filter((line) => line.includes('Example Client B'))).toHaveLength(0);
    }
  });
});
