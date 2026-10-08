# Security policy

## Reporting a vulnerability

Please use GitHub's **Private vulnerability reporting** feature for the canonical
Echo Notes repository when it is enabled. Do not disclose exploitable details in
a public issue or discussion.

Before the first public release, repository owners must enable private
vulnerability reporting in GitHub settings and verify that maintainers receive
notifications. Do not publish this project until a monitored private reporting
route is available.

## Scope and security notes

- The passphrase must never be sent through an Agent or MCP tool.
- The Harness panel is the only supported vault create/unlock/passphrase-change
  interface.
- Note bodies and revisions use AES-256-GCM; index metadata remains plaintext.
- The local HTTP API is restricted to loopback Host headers and same-origin
  browser POST requests.
- Report suspected crypto, local API, cross-origin, passphrase handling, or
  storage confidentiality issues privately.
