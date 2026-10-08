# Echo Notes MCP stdio adapter

This adapter lets MCP-capable clients call the same `echo_note` contract used by
the native DeepSeek Harness Agent tool. It does not own a second diary store;
it forwards calls to the running Harness Echo Notes API.

## Requirements

- Node.js 20 or newer
- Echo Notes installed and enabled in DeepSeek Harness
- Harness running with its local Web API reachable at the configured URL
- The vault unlocked in the Harness panel for read/write operations

Set `ECHO_NOTES_API_URL` to the origin plus `/echo-notes/api`. Example for the
default local Web port:

```text
http://127.0.0.1:52730/echo-notes/api
```

## MCP client configuration

Use a stdio MCP client configuration similar to:

```json
{
  "mcpServers": {
    "echo-notes": {
      "command": "node",
      "args": ["/absolute/path/to/echo-notes/mcp/stdio.js"],
      "env": {
        "ECHO_NOTES_API_URL": "http://127.0.0.1:52730/echo-notes/api"
      }
    }
  }
}
```

The same MCP server can be configured in Claude Desktop, Cursor, Continue, and
other clients that support stdio MCP servers. Exact configuration-file location
and environment-variable support are client-specific; consult that client’s MCP
setup documentation.

## Privacy and scope

The MCP adapter never accepts a passphrase. Create/unlock/lock and passphrase
changes remain user actions in the Harness panel. The adapter forwards note
operations to Harness and receives the same locked-vault errors as the native
Agent tool. Keep the adapter local: the Harness endpoint rejects non-loopback
hosts and cross-origin POST requests.

The adapter only works while Harness is running. It does not independently
implement persistence, encryption, scheduled reminders, or the Web UI.
