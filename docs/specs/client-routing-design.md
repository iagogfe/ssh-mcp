# Roteamento SSH por cliente Planetfone 4

## Objetivo

Permitir que a ferramenta MCP `exec` receba o nome do cliente e selecione automaticamente o primeiro host Planetfone 4 cadastrado para esse cliente. O usuário poderá solicitar, por exemplo, a execução de um comando para `Cliente de Exemplo` sem informar manualmente o hostname.

O comportamento será aplicado ao MCP SSH instalado globalmente e continuará usando a verificação de chave do host existente.

## Fonte oficial dos clientes

O arquivo oficial será:

`./config/client-map.md`

O caminho poderá ser substituído pela variável `SSH_MCP_CLIENT_MAP`, para facilitar testes e futuras migrações. O wrapper global definirá esse caminho por padrão, pois o processo MCP não deve depender do diretório corrente.

O parser deverá reconhecer a estrutura atual do Markdown:

- títulos `### Nome do cliente`;
- linhas de host no formato ``- `hostname` ``;
- a ordem dos hosts dentro de cada cliente.

Hosts repetidos para o mesmo cliente serão removidos preservando a primeira ocorrência. A primeira entrada restante será o host primário. Não serão incluídos no roteamento os endereços IP de firewall ou outros itens que não estejam no inventário Planetfone 4 como hostname.

## Resolução do cliente

O nome recebido será normalizado para comparação: remoção de espaços nas extremidades, conversão para minúsculas, remoção de acentos e compactação de espaços. A resolução será feita por correspondência exata após essa normalização. Isso permite, por exemplo, que `Example Client A` encontre o mesmo cadastro que `Example Client A`, sem o risco de uma busca parcial selecionar o cliente errado.

Quando houver mais de um host, o primeiro host da lista será escolhido automaticamente e a resposta poderá informar qual hostname foi selecionado. O MCP não fará failover implícito para outro host, pois isso poderia direcionar comandos a uma máquina diferente daquela pretendida.

Quando o cliente não existir, a ferramenta retornará erro sem abrir conexão e incluirá uma lista curta de nomes semelhantes, quando houver. Nomes ambíguos não serão resolvidos silenciosamente.

## Interface MCP

A ferramenta existente `exec` passará a exigir:

```text
client: string       nome do cliente conforme o inventário
command: string      comando remoto
description?: string descrição opcional para confirmação/auditoria
maxBytes?: number    limite opcional da saída
```

O `client` será resolvido antes da conexão. O comando continuará sendo executado pelo mecanismo SSH atual, com os mesmos limites e tratamento de saída.

Quando habilitada, a ferramenta `sudo-exec` também receberá `client` e usará o mesmo resolvedor e a mesma conexão correspondente. A configuração atual que deixa sudo desabilitado por padrão será preservada.

## Autenticação e conexões

As variáveis oficiais de autenticação serão exatamente:

- `SSH_MCP_USER`: usuário SSH;
- `SSH_MCP_PASSWORD`: senha SSH.

Essas variáveis serão lidas diretamente pelo processo MCP, sem gravar seus valores no projeto, na linha de comando ou no arquivo de inventário. O exemplo usa apenas nomes genéricos; valores reais devem permanecer fora do repositório e do histórico de alterações.

O wrapper deixará de exigir um host fixo. Cada chamada resolverá o hostname do cliente. O processo manterá conexões reutilizáveis em um mapa indexado por host, porta e usuário, permitindo alternar entre clientes sem reutilizar uma sessão no servidor errado. A senha não fará parte da chave nem será incluída em logs.

O host continuará sujeito à política atual de `known_hosts`; não haverá habilitação automática de `--insecureHostKey`.

## Alterações previstas

1. Extrair o parser e o resolvedor do inventário para unidades testáveis.
2. Alterar o esquema de `exec` e `sudo-exec` para aceitar `client`.
3. Trocar o gerenciador de conexão único por cache por destino.
4. Ler `SSH_MCP_USER`, `SSH_MCP_PASSWORD` e `SSH_MCP_CLIENT_MAP` no processo global.
5. Atualizar o wrapper `ssh-mcp` para iniciar o modo por cliente sem host fixo.
6. Atualizar README e testes sem registrar credenciais reais.

## Verificação

Serão cobertos por testes:

- parsing de clientes e hosts, incluindo múltiplos hosts e duplicatas;
- normalização de acentos e espaços;
- seleção do primeiro host;
- cliente inexistente e sugestões;
- leitura das variáveis `SSH_MCP_USER` e `SSH_MCP_PASSWORD`;
- troca entre dois clientes e reutilização da conexão do mesmo destino;
- integração da ferramenta MCP com o campo obrigatório `client`.

Após as alterações serão executados a suíte de testes do projeto, o build TypeScript e uma validação sintática do wrapper global. A conclusão só será declarada com os resultados desses comandos disponíveis.

## Fora de escopo

- alterar comandos remotos ou permissões nos servidores dos clientes;
- armazenar senhas no Markdown;
- incluir endereços de firewall no roteamento de hosts Planetfone 4;
- selecionar automaticamente um host secundário após falha do primário;
- mudar a política de verificação de chaves SSH.
