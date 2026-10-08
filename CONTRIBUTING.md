# Contributing to Echo Notes

Thanks for helping improve Echo Notes. This repository is a DeepSeek Harness
plugin with an optional stdio MCP adapter.

## Development setup

Requirements: Node.js 20+ and pnpm. Runtime dependencies are supplied by the
Harness profile; package-local dev dependencies are pinned for reproducible
schema and storage tests.

```sh
pnpm install
pnpm check
pnpm test
```

Tests use Node's built-in test runner. They cover crypto primitives, note/store
behavior, reminder scheduling, Harness tool and HTTP integration, MCP JSON-RPC,
and client component rendering.

## Change guidelines

- Add tests for behavior before changing implementation.
- Keep note storage behind `NoteStore` and route UI/MCP/native-tool calls through
  the shared action dispatcher and `src/agent-contract.js`.
- Never accept a vault passphrase through an Agent tool, MCP tool, URL, or log.
- Preserve standard JSON Schema in model-facing tool definitions.
- Do not claim cross-host compatibility unless an adapter and tests exist.
- Document any plaintext metadata exposure and security behavior changes.

## Security reports

Do not file exploitable security details in a public issue. Contact the
maintainers privately through the security contact configured in the published
GitHub repository. Before the first public release, add a `SECURITY.md` with the
maintainers' monitored contact address.

## Pull requests

Include a concise problem statement, behavior change, test evidence, and any
migration or privacy implications. Keep unrelated formatting changes out of the
PR.
