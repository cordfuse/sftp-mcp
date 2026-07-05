# sftp-mcp — Execution Plan

> An MCP server that exposes a **remote SFTP/FTP server as a browsable, mutable
> filesystem** to an AI agent — list, stat, move, mkdir, delete, batch, upload,
> download. Not just upload/download. Node runtime, **stdio + streamable HTTP**,
> zero native deps.

Status: **planning** · Created 2026-07-05 · Home: `cordfuse/sftp-mcp` (public) ·
Package: `@cordfuse/sftp-mcp`

---

## 1. Thesis

There are SFTP/SSH MCP servers already — the leader is `@fangjunjie/ssh-mcp-server`
(620★, Node, mature, security-conscious). But every incumbent is **SSH-first**:
their file story is `upload` / `download` of individual files, bolted onto remote
command execution.

**The open wedge is SFTP-as-a-filesystem.** Treat the remote as a browsable,
mutable tree: list with filters, stat, make/remove directories, move/rename,
delete, batch pull, upload — the operations that make it a *filesystem*, not a
*pipe*. No incumbent owns this.

We already own a strong head start: **`steve-krisjanovs/sftp-rest`** (2023, JS) —
an HTTP REST layer over `promise-sftp`/`promise-ftp` that already implements
list+filter+sort, single + batch download (zip + manifest), upload, delete,
rename/move, and mkdir. The **domain flow is done and battle-tested**; this project
ports that logic to MCP, modernizes the libs, closes the gaps, and adds an
agent-safe credential model.

The name is functional on purpose (discovery play, like `barcoding-mcp`): people
search "sftp mcp". The filesystem differentiation lives in the tagline, not the
name.

## 2. What we reuse vs. rebuild (from `sftp-rest`)

**Reuse — the valuable core (the domain logic):** the per-operation SFTP/FTP flow,
list + wildcard + type filter + sort, batch-download-with-manifest, the identical
FTP/SFTP client abstraction.

**Rebuild / modernize:**
- **Interface:** Express-HTTP-with-creds-in-URL → **MCP tools** (Zod schemas),
  stdio + streamable HTTP. Drop `express`, `body-parser`, `cookie-parser`,
  `express-fileupload`.
- **Libraries (2018-era → current):** `promise-sftp`/`ssh2-streams@0.2.1` →
  **`ssh2-sftp-client`** (maintained, pure JS over `ssh2`). FTP (optional,
  secondary) → **`basic-ftp`**. Drop `linq` (native array methods),
  `base64-async` (`Buffer`), `uuid@3` → `crypto.randomUUID`. No `new Buffer.from`.
- **Return shapes:** HTTP stream/zip piping → MCP content blocks (base64 or MCP
  resource), with a size cap.

## 2a. Carry-over BUGS in `sftp-rest` to fix in the port

1. **Dead port validation** — `if (!isNormalInteger)` tests the function
   reference (always truthy); the range check never runs. Validate `port` for
   real.
2. **Passphrase never applied** — the connect object key is `"passphrase "`
   (trailing space), so `ssh2` never receives it → passphrase-protected private
   keys silently fail auth. Fix the key name.

## 3. Stack

- **Runtime:** Node (LTS), TypeScript compiled with `tsc`. No native addons, no
  experimental flags, no Python.
- **SFTP:** `ssh2-sftp-client`. **FTP (optional):** `basic-ftp`.
- **MCP SDK:** `@modelcontextprotocol/sdk` (TypeScript).
- **Transports:** stdio (default) + streamable HTTP (`--http [--port N]`,
  stateful sessions, `GET /health`) — same pattern as `barcoding-mcp`.

## 4. Credential model — per-call, with an escape hatch (DECIDED)

Creds are passed **in the tool call**, not configured server-side. Chosen for
ad-hoc multi-host flexibility and statelessness (the server holds no secrets at
rest). Connection params (host / port / username) are per-call.

The **secret is supplied two ways**, caller's choice:
- **Inline** — password, or private-key bytes, in the call. Max flexibility;
  accepts that the secret transits the model context.
- **By-reference** — a private-key **path the server reads**, or a short profile
  name. Keeps per-call flexibility while the raw key material never passes
  through the model.

**Mitigations (mandatory regardless):**
- Never log credentials — redact in all error/trace/log output.
- Sanitize errors surfaced to the model (no stacks, internal paths, or host
  fingerprints).
- **Document the exposure plainly.** ⚠️ Inline secrets transit the model context,
  the client transcript, and — if fronted by the public `mcp.crosstalk.sh`
  metamcp endpoint — that proxy chain. Public-endpoint deployment with inline
  secrets is a conscious choice; by-reference or a private stdio deployment is the
  safe default for anything sensitive.

## 5. Tools

Your 8 `sftp-rest` operations + the gap-closers that make it filesystem-complete.

| Tool | From sftp-rest | Notes |
|------|----------------|-------|
| `test_connection` | `connect` | validate creds + reachability |
| `list_files` | `listfiles` | wildcard + type filter + sort; **+ pagination, + `recursive` opt, + symlink type** |
| `stat` | — (**new**) | single-path metadata: size, mtime, perms, type, exists |
| `download_file` | `getfile` | returns base64 (size-capped) or MCP resource |
| `download_files` | `getfiles` | batch by filter; zip + manifest; **+ recursive opt** |
| `upload_file` | `putfile` | base64 in; **+ overwrite guard, + size cap** |
| `delete_file` | `rmfile` | |
| `delete_dir` | — (**new**) | remove directory; **+ recursive (`rm -rf`) opt** |
| `make_directory` | `mkdir` | **+ recursive (`mkdir -p`) opt, + idempotent** |
| `move` | `renamefile` | rename/move; **+ overwrite guard** |
| `chmod` | — (**new**, optional) | permission change (SFTP only) |

## 5a. Bound gaps to close (robustness / security, from the inspect)

- **Connection cleanup:** wrap every op so the client is `end()`-ed in a
  `finally` — `sftp-rest` leaks the connection on error paths.
- **Timeouts / keepalive:** a hung host must not hang the tool call forever.
- **Path guard:** `..`/traversal guard + optional path allow/deny list — this is
  agent-facing, not a service you fully control.
- **Size caps:** `upload_file` decodes the whole base64 in memory and downloads
  stage whole files; add a max-size guard (and stream where practical) so an
  agent can't OOM the server with a huge transfer.
- **tmp cleanup:** clean staging dirs on error, not only on success.
- **Overwrite control:** `upload_file` / `move` take a `overwrite` flag; default
  fail-if-exists for safety.

## 6. Repository layout (monorepo — mirrors barcoding-mcp)

```
sftp-mcp/
  packages/
    mcp/            @cordfuse/sftp-mcp (src/, dist/)
  docker/           Dockerfile + compose for the --http server
  package.json      workspaces: ["packages/*"]
```

## 7. Phases

- **Phase 0 — SFTP spike:** `ssh2-sftp-client` connect → list → get → put → stat
  against a throwaway SFTP host, in Node, zero native deps. Prove the modern lib
  before porting.
- **Phase 1 — Core over stdio:** MCP skeleton; port `list_files`, `stat`,
  `download_file`, `upload_file`, `test_connection`; per-call creds (inline +
  by-reference); the two bug fixes; `finally` cleanup + timeouts.
- **Phase 2 — Filesystem-complete:** `move`, `delete_file`, `delete_dir`
  (recursive), `make_directory` (recursive), `download_files` (batch),
  `chmod`. Path guard + size caps + overwrite guards.
- **Phase 3 — streamable HTTP:** `--http`, stateful sessions, `/health`.
- **Phase 4 — Polish + CI:** README (honest tool table + the credential-exposure
  warning), `node:test` smoke suite (against a container SFTP), CI on Node 20/22.
- **Phase 5 — Publish:** `v0.0.1` → npm (`@cordfuse/sftp-mcp`) + GHCR. Repo is
  **public** (required: GitHub Free org `NPM_TOKEN` only delivers to public
  repos); add to the org token's selected-repo allow-list. Optionally wire the
  `--http` endpoint into metamcp.

## 8. Non-goals

- No remote command execution (that's the incumbent's lane; we're the filesystem).
  Revisit only if a real need appears.
- No Python, no native addons.
- No server-side credential store as the *primary* model (per-call is the design);
  by-reference/profiles are the escape hatch, not the default.
- FTP is **secondary** — kept because `sftp-rest` had it and it's cheap, but SFTP
  is the product. FTP is legacy/insecure; documented as such.

## 9. Decisions (locked)

1. Name — **`cordfuse/sftp-mcp`** / `@cordfuse/sftp-mcp`, functional for
   discoverability; filesystem wedge lives in the tagline.
2. Creds — **per-call**, secret inline **or** by-reference; never logged.
3. Base — **port `sftp-rest`'s domain logic**, modernize libs, close the gaps.
4. Transports — **stdio + streamable HTTP**.
5. Runtime — **Node + TypeScript**, zero native deps.

---

*Port the flow from sftp-rest. Modernize the libs. Close the verb + bound gaps.
SFTP as a filesystem. Node. stdio + streamable HTTP.*
