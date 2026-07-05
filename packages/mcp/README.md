# @cordfuse/sftp-mcp

**SFTP as a browsable, mutable filesystem for AI agents** (MCP) — list, stat,
move, mkdir, delete, batch, upload, download. Not just upload/download. Node,
served over **stdio** and **streamable HTTP**, zero required native deps.

## Install

```bash
npx @cordfuse/sftp-mcp          # stdio (default)
npx @cordfuse/sftp-mcp --http   # streamable HTTP on :3901 (PORT to change)
```

MCP client config (stdio):

```json
{
  "mcpServers": {
    "sftp": { "command": "npx", "args": ["-y", "@cordfuse/sftp-mcp"] }
  }
}
```

## Tools

`test_connection` · `list_files` (glob + type filter, sort, recursive) · `stat` ·
`download_file` · `download_files` · `upload_file` · `delete_file` ·
`delete_dir` (recursive) · `make_directory` (recursive) · `move` · `chmod`.

## Credentials — 100% per-call, zero config

Every call names its own target + secret, so one server instance reaches **any
number of SFTP hosts, switched call-to-call**. The secret is **optional**: pass
`password` or `privateKey` (+ `passphrase`) inline, or **omit it** to use the
local ssh-agent / default `~/.ssh` key (stdio only — keeps keys out of the model).

**Security:** stdio is the safe mode for inline secrets (local, private). Do **not**
put inline passwords through a public streamable-HTTP endpoint. Built-in: size
cap, no credential logging, sanitized errors.

## Transports

- **stdio** (default) — Claude Code, Cursor, local agents.
- **streamable HTTP** (`--http`, `PORT`/`--port`) — stateful sessions, `GET /health`.
  Prebuilt image: `ghcr.io/cordfuse/sftp-mcp`.

Source + Docker: https://github.com/cordfuse/sftp-mcp

## License

MIT
