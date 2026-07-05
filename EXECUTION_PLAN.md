# sftp-mcp — Execution Plan

> An MCP server that exposes a **remote SFTP/FTP server as a browsable, mutable
> filesystem** to an AI agent — list, stat, move, mkdir, delete, batch, upload,
> download. Not just upload/download. Node runtime, **stdio + streamable HTTP**,
> zero native deps.

Status: **built — v0.0.1 ready to publish** (Phases 0–4 done, CI green on Node
20/22 against a live `atmoz/sftp` service) · Created 2026-07-05 · Home:
`cordfuse/sftp-mcp` (public) · Package: `@cordfuse/sftp-mcp`

**Publish:** org `NPM_TOKEN` visibility is `all` and this repo is public, so the
token is delivered — no allow-list step needed (confirmed 2026-07-05). `ship it`
→ tag `v0.0.1`.

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

## 4. Credential model — 100% per-call, zero config (DECIDED)

Everything is passed **in the tool call**. There is **no server-side config** — no
key store, no profiles, no guardrail env vars. Chosen for ad-hoc multi-host
flexibility, statelessness (the server holds nothing at rest), and the smallest
possible surface. Connection params (host / port / username) and the secret are
all per-call.

**Multi-server, real-time (a direct consequence):** because every call fully
specifies its target, the agent can talk to **any number of SFTP servers, switched
call-to-call, with no registration and no restart.** There is no "configure servers"
step — you name the server in the call. (Optional later perf: a connection cache
keyed by `(host, port, user)` with idle-eviction so repeat calls to the same host
reuse a warm connection — still unlimited servers, still no config. Out of v1.)

**The secret in a call is optional, with two ways to supply it:**
- **Inline** — password, or private-key bytes (+ optional passphrase), in the call.
  Max flexibility; accepts that the secret transits the model context.
- **Omitted → local SSH fallback** — if no secret is given, the server uses the
  local **ssh-agent / `~/.ssh` default key**. Still 100% per-call (the call names
  host+user, just no secret), idiomatic for SSH users, and it keeps private-key
  material **out of the model** for the local/stdio case. The one real security
  affordance in a no-config world. (Meaningful only for stdio, where the server
  runs on the user's machine — a remote container has no user ssh-agent.)

**Built-in safe defaults (constants, not config):**
- **Max transfer size** — a sane cap (per-call overridable) so an agent can't OOM
  the server with a huge base64 blob.
- **Never log credentials** — redact in all error/trace/log output.
- **Sanitized errors** to the model (no stacks, internal paths, host fingerprints).

**Security is documented, not configured** — and it maps onto the transport:
- **stdio = the safe mode for inline secrets** — server runs locally as a child of
  your client; the secret never leaves your machine. Use this (or the ssh-agent
  fallback) for anything sensitive.
- **⚠️ streamable HTTP behind a public tunnel** (e.g. `mcp.crosstalk.sh`) — inline
  secrets transit the network + proxy chain. **Do not put inline passwords through
  a public endpoint.** This is the one combination to avoid.

Deferred (add only if a shared-endpoint operator actually asks — YAGNI for v1):
read-only mode, path allow/deny jail, host allowlist. All would be launch flags,
not per-call.

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
- **No server-side config at all** — 100% per-call. The only secret-optional path
  is the local ssh-agent / `~/.ssh` fallback (stdio). Guardrails (read-only, path
  jail, host allowlist) are deferred, not part of v1.
- FTP is **secondary** — kept because `sftp-rest` had it and it's cheap, but SFTP
  is the product. FTP is legacy/insecure; documented as such.

## 9. Decisions (locked)

1. Name — **`cordfuse/sftp-mcp`** / `@cordfuse/sftp-mcp`, functional for
   discoverability; filesystem wedge lives in the tagline.
2. Creds — **100% per-call, zero server config**; secret inline **or** omitted →
   local ssh-agent/`~/.ssh` fallback (stdio); never logged; built-in size cap.
3. Base — **port `sftp-rest`'s domain logic**, modernize libs, close the gaps.
4. Transports — **stdio + streamable HTTP**.
5. Runtime — **Node + TypeScript**, zero native deps.

## 10. Post-v1 verb/noun backlog (gap vs native SFTP)

v1 covers the everyday filesystem verbs. Deferred, ranked by value:

**Tier 1 — easy adds (`ssh2-sftp-client` already exposes them):**
- `realpath` — canonicalize a path (resolve `.`/`..`/symlinks). High value.
- `lstat` — stat without following symlinks.
- `symlink` + `readlink` — create / read symlinks (symlink-awareness = table stakes
  for "filesystem-complete").
- `append` — append to a file.
- `posixRename` under `move` — atomic overwrite (strictly better than the current
  delete-then-rename).
- `cwd` — server default/home dir.

**Tier 2 — the differentiator:**
- **Recursive tree sync** (`uploadDir`/`downloadDir`, or a base64-tree variant) —
  the operation nobody in this category does well. NOTE: the lib's dir-transfer is
  **host-filesystem ↔ remote** (the MCP server's disk), so it only makes sense for
  local/stdio deployments; a base64-tree variant would be model-safe.
- `df` / `statvfs` — filesystem free space (capacity check before big uploads).

**Tier 3 — needs raw `ssh2`, niche:**
- `chown`/`chgrp` (usually root), `setstat` times (`touch`), `truncate`,
  random-range read/write, `reget`/`reput` (resumable — the core if we ever build
  large-tree sync).

**Not native (fair to omit):** server-side `copy` (no v3 primitive), `hardlink`
(v6/extension).

---

*Port the flow from sftp-rest. Modernize the libs. Close the verb + bound gaps.
SFTP as a filesystem. Node. stdio + streamable HTTP.*
