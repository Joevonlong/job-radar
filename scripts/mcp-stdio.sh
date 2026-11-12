#!/bin/sh
# Starts the MCP server over stdio from any working directory (docs/mcp.md).
# An MCP client launches its servers from wherever it likes, and corepack picks the pnpm version by
# the current directory, so go to the project first. stdout carries the protocol: nothing else may print there.
set -eu

# Follow symlinks so a link such as ~/bin/job-radar-mcp still finds the project.
resolved=$0
while [ -h "$resolved" ]; do
  target=$(readlink "$resolved")
  case $target in
    /*) resolved=$target ;;
    *) resolved=$(dirname -- "$resolved")/$target ;;
  esac
done

# CDPATH= keeps `cd` from printing the path on stdout.
CDPATH= cd -- "$(dirname -- "$resolved")/.." || exit 1

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm was not found on PATH. Put the folders of pnpm and node into the client's PATH (see docs/mcp.md, Claude Desktop)." >&2
  exit 127
fi

exec pnpm --silent mcp:serve "$@"
