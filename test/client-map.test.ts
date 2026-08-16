import { describe, expect, it } from 'vitest';
import {
  normalizeClientName,
  parsePlanetfone4Hosts,
  resolveClientHost,
} from '../src/client-map';

const markdown = `# Hosts únicos

- \`fixture-client-007.example.com\`

### Example Client

- Wiki: [Example Client](http://wiki.example/Example Client)
- \`fixture-client-004.example.com\`
- \`fixture-client-005.example.com\`
- \`fixture-client-004.example.com\`
Texto que não é um host.
- \`192.0.2.10\`

### Example Client B

- Acesso: \`fixture-client-006.example.com\`
- \`fixture-client-006.example.com\`

### Sem acesso

- Nenhum servidor cadastrado.

### Domínio externo

- \`ssh.example.net\`
`;

describe('Planetfone client inventory', () => {
  it('normalizes case, accents, and repeated whitespace', () => {
    expect(normalizeClientName('  EXAMPLE   client  ')).toBe('example client');
  });

  // Prose and markdown links are excluded because only backticked spans are
  // read, not because of any domain rule. IPs and hosts on other domains are
  // now kept: they were previously dropped by a hardcoded single-domain suffix
  // check, which made the parser unusable for any other deployment.
  it('parses client sections while ignoring global hosts, prose, links, and empty sections', () => {
    expect(parsePlanetfone4Hosts(markdown)).toEqual([
      {
        name: 'Example Client',
        hosts: [
          'fixture-client-004.example.com',
          'fixture-client-005.example.com',
          '192.0.2.10',
        ],
      },
      { name: 'Example Client B', hosts: ['fixture-client-006.example.com'] },
      { name: 'Domínio externo', hosts: ['ssh.example.net'] },
    ]);
  });

  it('resolves an exact normalized client name to its first host', () => {
    const clients = parsePlanetfone4Hosts(markdown);

    expect(resolveClientHost(clients, 'Example Client')).toEqual({
      clientName: 'Example Client',
      host: 'fixture-client-004.example.com',
      hosts: [
        'fixture-client-004.example.com',
        'fixture-client-005.example.com',
        '192.0.2.10',
      ],
    });
  });

  it('rejects ambiguous client names after normalization', () => {
    const clients = [
      { name: 'Example Client B', hosts: ['fixture-client-006.example.com'] },
      { name: 'Example Client B', hosts: ['fixture-client-008.example.com'] },
    ];

    expect(() => resolveClientHost(clients, 'Example Client B')).toThrowError(
      /ambiguous.*Example Client B.*Example Client B/i,
    );
  });

  it('reports a missing client with at most three nearby names and no secrets', () => {
    const clients = [
      { name: 'Example Client Example Client Parts', hosts: ['fixture-client-009.example.com'] },
      { name: 'Example Client Example Client Used', hosts: ['fixture-client-010.example.com'] },
      { name: 'Example Client Services', hosts: ['fixture-client-011.example.com'] },
      { name: 'Example Client B', hosts: ['fixture-client-006.example.com'] },
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
