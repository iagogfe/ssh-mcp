#!/usr/bin/env bash
# Cobertura sobre os testes que nao precisam de fixture SSH.
set -uo pipefail
cd "$(dirname "$0")"
SSH_MCP_DISABLE_MAIN=1 npx vitest --run --coverage \
  --coverage.provider=v8 --coverage.reporter=json-summary --coverage.reporter=json --coverage.reporter=text \
  --coverage.include='src/**' \
  test/tmux.test.ts test/output.test.ts test/config.test.ts test/tmux-mode.test.ts \
  test/security.test.ts test/client-map.test.ts test/client-protocol.test.ts \
  test/connection-manager-cache.test.ts test/channel-cap.test.ts test/su-shell.test.ts test/index-units.test.ts test/tmux-runner.test.ts test/config-units.test.ts test/edge-branches.test.ts \
  "$@" 2>&1 | tail -25
