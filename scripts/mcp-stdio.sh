#!/bin/sh
# Starts the MCP server over stdio from any working directory (docs/mcp.md).
# An MCP client launches its servers from wherever it likes, and corepack picks the pnpm version by
# the current directory, so go to the project first. stdout carries the protocol: nothing else may print there.
cd "$(dirname "$0")/.." || exit 1
exec pnpm --silent mcp:serve "$@"
