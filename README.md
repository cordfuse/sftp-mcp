# sftp-mcp

[![CI](https://github.com/cordfuse/sftp-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/cordfuse/sftp-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@cordfuse/sftp-mcp)](https://www.npmjs.com/package/@cordfuse/sftp-mcp)

**SFTP as a browsable, mutable filesystem for AI agents** — list, stat, move,
mkdir, delete, batch, upload, download. Not just upload/download. Node runtime,
served over both **stdio** and **streamable HTTP**, zero required native deps.

> Most SFTP/SSH MCP servers are SSH-first: their file story is upload/download of
> individual files bolted onto remote command execution. `sftp-mcp` treats the
> remote as a **filesystem** — the operations that make it browsable and mutable.

## Tools

| Tool | Purpose |
|------|---------|
| `test_connection` | Validate credentials + reachability. |
| `list_files` | List a directory — glob + type filter, sort, optional recursive. |
| `stat` | Metadata for one path (exists, type, size, mtime, octal perms). |
| `download_file` | Download one file, base64-encoded (size-capped). |
| `download_files` | Batch download by wildcard (optional recursive), each base64. |
| `upload_file` | Upload base64 data; overwrite guard; size-capped. |
| `delete_file` | Delete a file. |
| `delete_dir` | Remove a directory (optional recursive `rm -rf`). |
| `make_directory` | Create a directory (optional recursive `mkdir -p`). |
| `move` | Rename or move; overwrite guard. |
| `chmod` | Change permission bits (octal). |

## Credentials — 100% per-call, zero config

Every tool call names its own target and secret, so an agent can talk to **any
number of SFTP servers, switched call-to-call, with no registration and no
restart.** There is no server-side config.

The secret in a call is **optional**:
- **Inline** — `password`, or `privateKey` (+ optional `passphrase`).
- **Omitted → local SSH fallback** — the server uses your **ssh-agent / default
  `~/.ssh` key**. Keeps private-key material out of the model. (Meaningful for
  **stdio** only — a remote container has no user agent.)

### Security — documented, and it maps to the transport

- **stdio = the safe mode for inline secrets.** The server runs locally as a child
  of your client; the secret never leaves your machine. Use stdio (or the
  ssh-agent fallback) for anything sensitive.
- **⚠️ streamable HTTP behind a public tunnel** — inline secrets transit the
  network and any proxy in front. **Do not put inline passwords through a public
  endpoint.** That is the one combination to avoid.

Built-in safe defaults (not config): a max transfer size (per-call overridable),
no credential logging, and sanitized error messages.

## Install & run

### npm (stdio — for Claude Code, Cursor, local agents)

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

### Docker / GHCR (streamable HTTP — for remote / metamcp wiring)

```bash
docker run -p 3901:3901 ghcr.io/cordfuse/sftp-mcp:latest
# or, from a checkout:
docker compose -f docker/compose.yaml up
```

Serves streamable HTTP at `http://<host>:3901/mcp`, liveness at `/health`.

## Repository layout (monorepo)

```
sftp-mcp/
  packages/
    mcp/          @cordfuse/sftp-mcp  (the server)
  docker/         Dockerfile + compose.yaml (the --http server)
  .github/        CI + release workflows
```

## Development

```bash
npm ci
npm run build -w @cordfuse/sftp-mcp
# tests need a live SFTP server:
docker run -d --name sftp-test -p 2222:22 atmoz/sftp foo:testpass:1001::upload
npm test  -w @cordfuse/sftp-mcp
```

## CI / Release

- **CI** — typecheck + build + test on Node 20 & 22, against an `atmoz/sftp`
  service container.
- **Release** — pushing a `v*` tag publishes the npm package `@cordfuse/sftp-mcp`
  (guards tag == version) and the image `ghcr.io/cordfuse/sftp-mcp:<version>` +
  `:latest`.

Heritage: ports and modernizes
[`steve-krisjanovs/sftp-rest`](https://github.com/steve-krisjanovs/sftp-rest)
(2023) — the SFTP domain logic — onto
[`ssh2-sftp-client`](https://github.com/theophilusx/ssh2-sftp-client) and MCP.

## License

MIT
