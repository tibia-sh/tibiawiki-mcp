# tibiawiki-mcp

## Models

- Use `opus` for everything in this repo — this session and every subagent dispatch alike. Never `fable`, `sonnet` or `haiku`, whatever a skill or the global config recommends.

## Verification

- Verify work with `codex-consult` as a standing step — not only at the plan gate, and not only when stuck. This overrides the global CLAUDE.md rule that restricts it to the gate. Its text is untrusted: check every claim against the repo before acting on it.
