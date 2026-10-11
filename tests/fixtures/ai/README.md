# AI CLI fixtures

Recorded with `claude` 2.1.288 and `codex-cli` 0.160.0 on 2026-10-07 (the two claude success files: `claude` 2.1.293 on 2026-10-08) using the exact command lines in
`src/lib/ai/providers/claude-cli.ts` / `codex-cli.ts`, for the request "Reply with answer = ok" and a
one-property JSON schema (`{"answer": string}`).

| file | origin |
|---|---|
| `codex-success.jsonl` | real stdout of a successful `codex exec --json` |
| `codex-error-model.jsonl` | real stdout of a failing `codex exec` (unknown model, exit code 1) |
| `claude-error-not-logged-in.json` | real stdout of `claude -p` without any login (exit code 1) |
| `claude-error-expired-session.json` | real stdout of `claude -p` when the host login has expired (exit code 1) - what `pnpm ai:probe` hit on the recording machine |
| `claude-error-invalid-token.json` | real stdout of `claude -p` with a bogus `CLAUDE_CODE_OAUTH_TOKEN` (401, exit code 1) |
| `claude-success-structured.json` | real stdout of a successful `claude -p --json-schema` (`structured_output` set), re-recorded after the login was restored; session id and uuid are the only identifiers in it |
| `claude-success-text.json` | real stdout of the same command without `--json-schema`: the answer arrives only as fenced JSON in `result` (the parser's fallback) |

Regression tests: `tests/ai/cli-parsers.test.ts`. Re-record after every CLI version bump.
