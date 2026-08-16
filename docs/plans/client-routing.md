# Planetfone 4 Client SSH Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Alter the global SSH MCP so `exec` and enabled `sudo-exec` accept a Planetfone client name, resolve its primary host from `client-map.md`, and connect with `SSH_MCP_USER` and `SSH_MCP_PASSWORD`.

**Architecture:** Add a focused Markdown inventory module that parses client headings and `.planetarium.com.br` host bullets, normalizes client names, and returns the first host after exact normalized matching. Keep SSH connection construction in `src/index.ts`, but replace the singleton manager with a per-destination cache; each tool call resolves a client before obtaining its manager. The wrapper supplies the inventory path and starts the server without a fixed host, while the source uses the generic `SSH_MCP_USER` and `SSH_MCP_PASSWORD` process variables.

**Tech Stack:** TypeScript 5.9, Node.js 20+, `ssh2`, Zod, MCP SDK v2, Vitest, Bash wrapper.

## Global Constraints

- The official inventory is `./config/client-map.md`.
- `SSH_MCP_CLIENT_MAP` may override the inventory path.
- `SSH_MCP_USER` is the SSH username and `SSH_MCP_PASSWORD` is the SSH password.
- The first host listed for a matched client is the primary host; there is no implicit failover.
- Client matching is exact after trimming, lowercasing, removing diacritics, and compacting whitespace.
- Credentials must not be written to source, Markdown, CLI arguments, cache keys, or logs.
- Host-key verification remains enabled by default through `known_hosts` or a configured fingerprint.
- The wrapper must no longer require `SSH_MCP_HOST` or `SSH_MCP_USER`.
- `exec` and enabled `sudo-exec` require a `client` field in addition to `command`.
- Existing command sanitization, output limits, timeouts, sudo disabling, and persistent-shell behavior remain intact.

---

## File Map

- Create `src/client-map.ts`: parse the Planetfone 4 Markdown inventory, normalize names, resolve clients, and produce non-secret error suggestions.
- Create `test/client-map.test.ts`: unit tests for parsing, normalization, primary-host selection, duplicate removal, and missing-client errors.
- Modify `src/index.ts:1-110`: read the inventory path and lower-case credentials, and validate only static CLI settings at startup.
- Modify `src/index.ts:548-719`: route both MCP tools by client and cache `SSHConnectionManager` instances per host/port/user.
- Modify `src/index.ts:909-951`: close every cached manager during shutdown.
- Modify `test/description.test.ts`, `test/sudo-exec.test.ts`, and any other integration helpers that call the tools: provide a fixture inventory and `client` field rather than a fixed host.
- Create `test/fixtures/client-map.md`: small non-secret inventory used by integration tests.
- Modify `README.md:43-150`: document client-driven calls, inventory configuration, `SSH_MCP_USER`, and `SSH_MCP_PASSWORD`.
- Modify `ssh-mcp`: set the default inventory path and remove fixed-host requirements while preserving the default sudo-disabled behavior.

### Task 1: Add the inventory parser and resolver

**Files:**
- Create: `src/client-map.ts`
- Create: `test/client-map.test.ts`

**Interfaces:**
- Produces `PlanetfoneClient`, `ClientResolution`, `normalizeClientName`, `parsePlanetfone4Hosts`, `loadPlanetfone4Hosts`, and `resolveClientHost` for `src/index.ts`.

- [ ] **Step 1: Write failing parser and normalization tests**

Create a fixture string in `test/client-map.test.ts` with the current shape: a global unique-host section, `###` client headings, wiki bullets, multiple host bullets, a duplicate host, an accented client name, and a heading with no host. Assert the following API:

```ts
const clients = parsePlanetfone4Hosts(markdown);
expect(clients).toEqual([
  { name: 'Example Client', hosts: ['fixture-client-004.planetarium.com.br', 'fixture-client-005.planetarium.com.br'] },
  { name: 'Example Client B', hosts: ['fixture-client-006.planetarium.com.br'] },
]);
expect(normalizeClientName('  EXAMPLE   client  ')).toBe('example client');
```

Add tests that `resolveClientHost(clients, 'Example Client')` returns `{ clientName: 'Example Client', host: 'fixture-client-004.planetarium.com.br', hosts: [...] }`, and that an unknown client throws an error containing the requested name and a nearby client suggestion without exposing credentials.

- [ ] **Step 2: Run only the new tests and verify failure**

Run:

```bash
npx vitest --run test/client-map.test.ts
```

Expected: FAIL because `src/client-map.ts` does not exist yet.

- [ ] **Step 3: Implement the focused parser and resolver**

Implement these exact types and functions:

```ts
export interface PlanetfoneClient {
  name: string;
  hosts: string[];
}

export interface ClientResolution {
  clientName: string;
  host: string;
  hosts: string[];
}

export function normalizeClientName(value: string): string;
export function parsePlanetfone4Hosts(markdown: string): PlanetfoneClient[];
export function loadPlanetfone4Hosts(filePath: string): PlanetfoneClient[];
export function resolveClientHost(clients: readonly PlanetfoneClient[], query: string): ClientResolution;
```

Parse only a heading matching `^###\s+(.+?)\s*$` as a client section. Within that section, accept only backtick bullets containing a DNS hostname; for the official inventory, the resulting values are the expected `*.planetarium.com.br` hosts. Ignore the global unique-host list, wiki links, prose, IPs, and headings without hosts. Deduplicate hosts in insertion order. Normalize with `trim()`, lowercase, Unicode NFD, removal of `\p{Diacritic}`, and whitespace collapse. Resolve exact normalized names only; rank suggestions by normalized prefix or substring and return at most three names in the error.

Use `readFileSync(filePath, 'utf8')` in `loadPlanetfone4Hosts`. Throw a clear error if the file cannot be read, the inventory has no client sections with hosts, the query is empty, or no exact normalized client exists. Do not include file contents or environment values in errors.

- [ ] **Step 4: Run the focused tests and typecheck**

Run:

```bash
npx vitest --run test/client-map.test.ts
npm run build
```

Expected: all new tests pass and TypeScript compilation succeeds.

- [ ] **Step 5: Commit the inventory module**

```bash
git add src/client-map.ts test/client-map.test.ts
git commit -m "feat: add Planetfone client inventory resolver"
```

### Task 2: Convert configuration to client-driven authentication

**Files:**
- Modify: `src/index.ts:30-108`
- Modify: `test/client-map.test.ts` or create `test/config.test.ts` for pure configuration helpers if extraction is useful.

**Interfaces:**
- Consumes `loadPlanetfone4Hosts` and `resolveClientHost` from Task 1.
- Produces module constants for `CLIENT_MAP_PATH`, `USER`, `PASSWORD`, and the existing host-key/timeout settings, with lower-case environment variables taking precedence over legacy names.

- [ ] **Step 1: Add configuration tests for credential precedence and startup validation**

Test the pure helper or exported configuration resolver so the following behavior is explicit:

```ts
expect(resolveCredential(undefined, 'fallback-user', 'configured-user')).toBe('configured-user');
expect(resolveCredential(undefined, 'fallback-pass', 'configured-pass')).toBe('configured-pass');
expect(resolveCredential(undefined, 'legacy-user', undefined)).toBe('legacy-user');
```

Also assert that client mode does not require `--host` or `--user`, while invalid `--port` still fails. The test must not use or assert any real secret.

- [ ] **Step 2: Run the configuration tests and verify failure**

Run:

```bash
npx vitest --run test/config.test.ts
```

Expected: FAIL against the current fixed-host validation and missing lower-case variable support.

- [ ] **Step 3: Implement lower-case credential and inventory-path resolution**

Define precedence as explicit CLI flag, then `SSH_MCP_USER`/`SSH_MCP_PASSWORD`, then `SSH_MCP_USER`/`SSH_MCP_PASSWORD`. Keep `SSH_MCP_KEY_PATH` as the optional key fallback. Set:

```ts
const CLIENT_MAP_PATH = process.env.SSH_MCP_CLIENT_MAP ?? './config/client-map.md';
const USER = argvConfig.user ?? process.env.SSH_MCP_USER ?? process.env.SSH_MCP_USER;
const PASSWORD = resolveSecret(argvConfig.password, process.env.SSH_MCP_PASSWORD ?? process.env.SSH_MCP_PASSWORD) ?? undefined;
```

Do not require a host in `validateConfig`. Retain validation for invalid numeric port and any existing static options. Load the inventory lazily on the first tool call so a process that only starts can report configuration errors through MCP and tests can inject a fixture path.

- [ ] **Step 4: Run focused tests and build**

Run:

```bash
npx vitest --run test/config.test.ts test/client-map.test.ts
npm run build
```

Expected: PASS and successful compilation.

- [ ] **Step 5: Commit configuration changes**

```bash
git add src/index.ts test/config.test.ts test/client-map.test.ts
git commit -m "feat: configure Planetfone client authentication"
```

### Task 3: Route `exec` and `sudo-exec` through per-host managers

**Files:**
- Modify: `src/index.ts:548-719`
- Modify: `src/index.ts:909-951`
- Modify: `test/description.test.ts`
- Modify: `test/sudo-exec.test.ts`
- Create: `test/fixtures/client-map.md`

**Interfaces:**
- Consumes `loadPlanetfone4Hosts`/`resolveClientHost`, static credentials, and existing `SSHConnectionManager`/`execSshCommandWithConnection`.
- Produces `getConnectionManager(client: string, includeSudo: boolean): Promise<{ manager: SSHConnectionManager; resolution: ClientResolution }>` or an equivalent private helper used by both tools.

- [ ] **Step 1: Add the non-secret integration fixture and update tool-call helpers**

Create a fixture containing two client names mapped to local DNS names understood by the test SSH endpoint, for example:

```md
### Test Client One
- `localhost`

### Test Client Two
- `localhost`
```

Use the existing SSH test endpoint on port 2222; the fixture is only a non-secret routing input and `localhost` resolves to that endpoint in the test environment. Every MCP call should send `{ client: 'Test Client One', command }`. Set `SSH_MCP_CLIENT_MAP` to the fixture path and set `SSH_MCP_USER`/`SSH_MCP_PASSWORD` only in the spawned child environment with the existing test values. Do not put passwords into the fixture or tool arguments. Test selection of different hosts and primary-host order in `test/client-map.test.ts`, where no network resolution is needed.

- [ ] **Step 2: Add a failing test for required client and client switching**

Add integration assertions that an `exec` call without `client` returns an invalid-params error before connecting, that an unknown client returns a resolution error, and that two calls in one MCP process resolve to the corresponding fixture entries. Keep the existing command-output assertions.

- [ ] **Step 3: Run the targeted integration tests and verify failure**

Run:

```bash
npm run build && npx vitest --run test/description.test.ts test/sudo-exec.test.ts
```

Expected: failures caused by the current schemas/helpers not providing `client` and by the singleton fixed-host connection path.

- [ ] **Step 4: Replace the singleton with a destination cache**

Replace `let connectionManager: SSHConnectionManager | null` with a map keyed by `${host}:${port}:${username}`. The key must contain no password. Implement a helper that loads the inventory, resolves the requested client, builds the existing `SSHConfig` with resolved host, port, username, password/key, sudo/su settings, and host-key settings, then returns the cached manager or creates one. If a manager was previously disconnected, `ensureConnected()` must reconnect it as before.

Keep the connection's credential fields private to the manager; never include them in errors or debug output. Preserve the current `suPassword` elevation wait and sudo-password update semantics for the selected manager.

- [ ] **Step 5: Change both MCP schemas and callbacks**

Add a required Zod field before `command` in both tools:

```ts
client: z.string().describe('Planetfone client name from the configured inventory'),
```

At the start of each callback, resolve `client`, sanitize `command`, obtain the manager, and then execute the existing command path. Use `client` only for routing; do not append it to the remote command. Keep `description`, `maxBytes`, output formatting, and error wrapping unchanged. `sudo-exec` must use the same selected manager and remain absent when `--disableSudo` is set.

- [ ] **Step 6: Close all cached managers during shutdown**

Add a `closeAllConnectionManagers()` helper that iterates the map, calls `close()` on every manager, and clears the map. Call it from SIGINT, SIGTERM, `exit`, and fatal startup handling. It must tolerate an empty map and must not log credentials.

- [ ] **Step 7: Run targeted tests and build**

Run:

```bash
npm run build
npx vitest --run test/client-map.test.ts test/description.test.ts test/sudo-exec.test.ts
```

Expected: all targeted tests pass, including the missing-client and same-process client-routing cases.

- [ ] **Step 8: Commit routed tools**

```bash
git add src/index.ts test/fixtures/client-map.md test/description.test.ts test/sudo-exec.test.ts
git commit -m "feat: route SSH tools by Planetfone client"
```

### Task 4: Update the global wrapper and user documentation

**Files:**
- Modify: `ssh-mcp`
- Modify: `README.md:43-150`

**Interfaces:**
- Consumes `SSH_MCP_CLIENT_MAP`, `SSH_MCP_USER`, and `SSH_MCP_PASSWORD` from the environment.
- Produces a global MCP process that starts without a fixed host and exposes the client-based tool contract.

- [ ] **Step 1: Update the wrapper without embedding secrets**

Change the wrapper to:

```bash
#!/usr/bin/env bash
set -euo pipefail

export SSH_MCP_CLIENT_MAP="${SSH_MCP_CLIENT_MAP:-./config/client-map.md}"

args=()
if [[ "${SSH_MCP_ENABLE_SUDO:-0}" != "1" ]]; then
  args+=("--disableSudo")
fi

exec node build/index.js "${args[@]}"
```

The wrapper must not echo, interpolate into CLI arguments, or write `SSH_MCP_USER` or `SSH_MCP_PASSWORD`; the MCP source reads them from the inherited environment. Keep it executable.

- [ ] **Step 2: Update README usage and environment table**

Document a tool call using `client` and `command`, the default inventory path, `SSH_MCP_CLIENT_MAP`, and the exact credential variables:

```text
SSH_MCP_USER=<SSH user>
SSH_MCP_PASSWORD=<SSH password>
SSH_MCP_CLIENT_MAP=./config/client-map.md
```

Explain that the first host listed for a client is selected, client matching ignores case/accents/extra spaces, and credentials must stay in the process environment. Keep the host-key verification and sudo notes accurate.

- [ ] **Step 3: Validate wrapper and documentation references**

Run:

```bash
bash -n ssh-mcp
rg -n 'SSH_MCP_HOST|SSH_MCP_USER|SSH_MCP_USER|SSH_MCP_PASSWORD|SSH_MCP_CLIENT_MAP|client' README.md ssh-mcp
```

Expected: wrapper syntax succeeds, documentation contains the new contract, and the wrapper contains no fixed-host requirement.

- [ ] **Step 4: Commit wrapper and documentation**

```bash
git add README.md
git commit -m "docs: document Planetfone client routing"
```

The wrapper is outside the repository and will be verified in place; report that external file separately.

### Task 5: Run the complete verification suite and inspect the final diff

**Files:**
- Verify: `src/client-map.ts`, `src/index.ts`, tests, `README.md`, and `ssh-mcp`.

- [ ] **Step 1: Build and run all tests**

Run:

```bash
npm run build
npm test
```

Expected: TypeScript build succeeds and Vitest reports all tests passing. If a pre-existing environment-dependent SSH test fails, isolate it with the exact test name and do not call the feature complete until the new client-routing tests pass and the failure is documented.

- [ ] **Step 2: Verify the real inventory can be loaded without connecting**

Run a Node smoke check against the built module or a focused test using:

```text
SSH_MCP_CLIENT_MAP=./config/client-map.md
```

Assert that the inventory loads, `Cliente de Exemplo` resolves to `fixture-client-003.planetarium.com.br`, and the returned list contains no passwords, IP addresses, or empty hosts.

- [ ] **Step 3: Check security-sensitive output and diff**

Run:

```bash
git diff --check HEAD~4..HEAD
rg -n 'SSH_MCP_PASSWORD|SSH_MCP_USER|SSH_MCP_PASSWORD|password' src test README.md
git status --short --branch
```

Confirm that only variable names and documentation references appear, no secret values are present, and the wrapper remains executable. Review the final diff for accidental changes to host-key verification, command sanitization, sudo behavior, and output limits.

- [ ] **Step 4: Commit any final test-only correction and report evidence**

If the preceding verification reveals a small issue, fix it with a focused test-first commit. Otherwise leave the verified commits intact and report the exact build, test, and wrapper-check results, plus the configured environment variables the user must provide.
