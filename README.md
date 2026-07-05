# sftp-mcp

[![CI](https://github.com/cordfuse/sftp-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/cordfuse/sftp-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@cordfuse/sftp-mcp)](https://www.npmjs.com/package/@cordfuse/sftp-mcp)

**SFTP as a browsable, mutable filesystem for AI agents** — list, stat, move,
mkdir, delete, batch, upload, download. Not just upload/download. Node runtime,
served over both **stdio** and **streamable HTTP**, zero required native deps.

> Most SFTP/SSH MCP servers are SSH-first: their file story is upload/download of
> individual files bolted onto remote command execution. `sftp-mcp` treats the
> remote as a **filesystem** — the operations that make it browsable and mutable.

- [Quick start](#quick-start)
- [Tool reference](#tool-reference) — [connection params](#connection-parameters-every-tool) · [the 11 tools](#the-tools)
- [Credentials & security](#credentials--100-per-call-zero-config)
- [Responses, limits & errors](#responses-limits--errors)
- [Transports](#transports) · [Docker](#docker--ghcr) · [Development](#development)

---

## Quick start

```bash
npx @cordfuse/sftp-mcp          # stdio (default)
npx @cordfuse/sftp-mcp --http   # streamable HTTP on :3901 (PORT to change)
```

MCP client config (stdio — Claude Code, Cursor, local agents):

```json
{
  "mcpServers": {
    "sftp": { "command": "npx", "args": ["-y", "@cordfuse/sftp-mcp"] }
  }
}
```

Once wired, ask your agent to *"list `/var/www` on sftp.example.com as user
deploy"* and it will call `list_files` with the connection + path.

---

## Tool reference

Eleven tools. Every tool is **self-contained**: each call carries its own
connection details (there is no server-side config — see
[Credentials](#credentials--100-per-call-zero-config)), so a single running
server can address any number of SFTP hosts, switched call-to-call.

### Connection parameters (every tool)

These fields are accepted by **all** tools. They are omitted from the per-tool
tables below to avoid repetition.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `host` | string | **yes** | — | SFTP server hostname or IP. |
| `username` | string | **yes** | — | SSH username. |
| `port` | number | no | `22` | TCP port. |
| `password` | string | no | — | Inline password. |
| `privateKey` | string | no | — | Inline private key (PEM / OpenSSH text). |
| `passphrase` | string | no | — | Passphrase for an encrypted `privateKey`. |
| `timeoutMs` | number | no | `15000` | Connection (ready) timeout in ms. |

**Secret resolution order:** `password` → `privateKey` (+ `passphrase`) → if
neither is given, the local **ssh-agent / default `~/.ssh` key** (stdio only).
See [Credentials](#credentials--100-per-call-zero-config).

`FileType` (used below) is one of: `"file"`, `"directory"`, `"symlink"`,
`"other"`.

---

### The tools

#### `test_connection`
Connect and immediately disconnect — validates credentials and reachability.

*No parameters beyond the connection fields.*

**Returns:** `{ ok: true, message: string }`

```json
{ "host": "sftp.example.com", "username": "deploy" }
```

---

#### `list_files`
List a directory, with optional glob/type filtering, sorting, and recursion.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `path` | string | **yes** | — | Remote directory to list. |
| `wildcard` | string | no | — | Glob on the entry name, e.g. `*.pdf` (`*` and `?`, case-insensitive). |
| `types` | `FileType[]` | no | all | Keep only these entry types. |
| `sortField` | `"name"` \| `"size"` \| `"modifyTime"` | no | — | Field to sort by. |
| `sortDirection` | `"asc"` \| `"desc"` | no | `asc` | Sort direction. |
| `recursive` | boolean | no | `false` | Descend into subdirectories. |
| `limit` | number | no | — | Cap the number of entries returned. |

**Returns:** `FileEntry[]` where `FileEntry = { name, path, type: FileType, size: number, modifyTime: number }` (`modifyTime` is epoch ms).

```json
{
  "host": "sftp.example.com", "username": "deploy",
  "path": "/var/www/releases",
  "wildcard": "*.tar.gz", "types": ["file"],
  "sortField": "modifyTime", "sortDirection": "desc"
}
```

---

#### `stat`
Metadata for a single path. Doubles as an existence check.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | string | **yes** | Remote path to stat. |

**Returns:** `{ exists: boolean, type?: FileType, size?: number, modifyTime?: number, accessTime?: number, mode?: string }` — `mode` is octal permission bits as a string (e.g. `"644"`). When `exists` is `false`, no other fields are present.

```json
{ "host": "sftp.example.com", "username": "deploy", "path": "/var/www/app.tar.gz" }
```

---

#### `download_file`
Download one file, base64-encoded.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `path` | string | **yes** | — | Remote file path. |
| `maxBytes` | number | no | `33554432` (32 MiB) | Refuse files larger than this. |

**Returns:** `{ path: string, base64: string, size: number }`

```json
{ "host": "sftp.example.com", "username": "deploy", "path": "/var/www/config.json" }
```

---

#### `download_files`
Batch-download every **file** in a directory matching an optional wildcard.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `path` | string | **yes** | — | Remote directory. |
| `wildcard` | string | no | — | Glob filter, e.g. `*.csv`. |
| `recursive` | boolean | no | `false` | Include matching files in subdirectories. |
| `maxTotalBytes` | number | no | `33554432` (32 MiB) | Cap on the **combined** size of the selection. |

**Returns:** `{ count: number, files: { path: string, base64: string, size: number }[] }`. Throws (with the offending path) if the running total exceeds `maxTotalBytes` — narrow the wildcard or raise the cap.

```json
{
  "host": "sftp.example.com", "username": "deploy",
  "path": "/exports", "wildcard": "*.csv", "recursive": true
}
```

---

#### `upload_file`
Upload base64 data to a remote path.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `path` | string | **yes** | — | Destination path (including filename). |
| `base64data` | string | **yes** | — | File contents, base64-encoded. |
| `overwrite` | boolean | no | `false` | Replace an existing file. Without it, an existing path is an error. |
| `maxBytes` | number | no | `33554432` (32 MiB) | Refuse payloads larger than this. |

**Returns:** `{ path: string, bytes: number }`

```json
{
  "host": "sftp.example.com", "username": "deploy",
  "path": "/var/www/robots.txt",
  "base64data": "VXNlci1hZ2VudDogKgpEaXNhbGxvdzoK",
  "overwrite": true
}
```

---

#### `delete_file`
Delete a single file.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | string | **yes** | Remote file to delete. |

**Returns:** `{ ok: true, deleted: string }`

---

#### `delete_dir`
Remove a directory.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `path` | string | **yes** | — | Remote directory to remove. |
| `recursive` | boolean | no | `false` | Remove contents too (`rm -rf`). Without it, the directory must be empty. |

**Returns:** `{ ok: true, removed: string, recursive: boolean }`

---

#### `make_directory`
Create a directory.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `path` | string | **yes** | — | Remote directory to create. |
| `recursive` | boolean | no | `false` | Create missing parents (`mkdir -p`); idempotent. |

**Returns:** `{ ok: true, created: string }`

---

#### `move`
Rename or move a file or directory.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `path` | string | **yes** | — | Current path. |
| `newPath` | string | **yes** | — | Destination path. |
| `overwrite` | boolean | no | `false` | Replace an existing destination. Without it, an existing `newPath` is an error. |

**Returns:** `{ ok: true, from: string, to: string }`

```json
{
  "host": "sftp.example.com", "username": "deploy",
  "path": "/staging/build.zip", "newPath": "/releases/build.zip"
}
```

---

#### `chmod`
Change a path's permission bits.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | string | **yes** | Remote path. |
| `mode` | string | **yes** | Octal permission string, e.g. `"644"` or `"755"`. |

**Returns:** `{ ok: true, path: string, mode: string }`

---

### End-to-end example (agent flow)

A typical "pull the latest release, verify, promote" flow chains a few tools:

1. `list_files` — `path:/staging`, `wildcard:*.zip`, `sortField:modifyTime`, `sortDirection:desc` → newest build's `path`.
2. `stat` — that path → confirm `size` / `mode`.
3. `download_file` — that path → inspect the base64 contents.
4. `move` — `/staging/build.zip` → `/releases/build.zip`, `overwrite:true` → promote.

---

## Credentials — 100% per-call, zero config

Every tool call names its own target and secret, so an agent can talk to **any
number of SFTP servers, switched call-to-call, with no registration and no
restart.** There is no server-side config.

The secret in a call is **optional**:
- **Inline** — `password`, or `privateKey` (+ optional `passphrase`).
- **Omitted → local SSH fallback** — the server uses your **ssh-agent / default
  `~/.ssh` key** (tries `id_ed25519`, `id_ecdsa`, `id_rsa`). Keeps private-key
  material out of the model. (Meaningful for **stdio** only — a remote container
  has no user agent.)

### Security — documented, and it maps to the transport

- **stdio = the safe mode for inline secrets.** The server runs locally as a child
  of your client; the secret never leaves your machine. Use stdio (or the
  ssh-agent fallback) for anything sensitive.
- **⚠️ streamable HTTP behind a public tunnel** — inline secrets transit the
  network and any proxy in front. **Do not put inline passwords through a public
  endpoint.** That is the one combination to avoid.

Built-in safe defaults (not config): a 32 MiB max transfer size (per-call
overridable), **no credential logging**, and **sanitized error messages** (no
stacks / internal paths leaked back to the model).

---

## Responses, limits & errors

- **Success** — the tool returns a JSON object/array (the "Returns" shape above),
  serialized as text content.
- **File contents are base64** — `download_file` / `download_files` return
  `base64`; `upload_file` takes `base64data`. Binary flows through the model, so
  transfers are **size-capped** (32 MiB default, per-call overridable via
  `maxBytes` / `maxTotalBytes`). For very large files this server is the wrong
  tool — it moves bytes through the agent, not disk-to-disk.
- **Errors** — a failed op returns `isError: true` with a **sanitized,
  single-line** message (credentials and stack traces are never included).
  Guarded cases you'll see by design: existing-path on `upload_file`/`move`
  without `overwrite`, oversize transfers, and non-empty `delete_dir` without
  `recursive`.
- **Connections** are opened per call and **always closed** (even on error), with
  the `timeoutMs` ready-timeout applied.

---

## Transports

- **stdio** (default) — for Claude Code, Cursor, and local agent wiring. The safe
  mode for inline secrets, and the only mode where the ssh-agent fallback applies.
- **streamable HTTP** — `--http [--port N]` (or `PORT` env; default `3901`).
  Stateful sessions; liveness probe at `GET /health` → `{ "status": "ok" }`.
  For remote / metamcp-style wiring.

---

## Docker / GHCR

```bash
docker run -p 3901:3901 ghcr.io/cordfuse/sftp-mcp:latest
# or, from a checkout:
docker compose -f docker/compose.yaml up
```

Serves streamable HTTP at `http://<host>:3901/mcp`, liveness at `/health`. The
image omits ssh2's optional native `cpu-features` accelerator and runs ssh2's
pure-JS crypto — no native toolchain in the image.

---

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
npm test  -w @cordfuse/sftp-mcp        # override with SFTP_HOST/PORT/USER/PASS
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
