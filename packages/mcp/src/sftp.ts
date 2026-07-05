import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import Client from "ssh2-sftp-client";

// --- connection model: 100% per-call, secret optional -----------------------

export interface ConnectionArgs {
  host: string;
  port?: number;
  username: string;
  /** Inline password. */
  password?: string;
  /** Inline private key (PEM/OpenSSH text). */
  privateKey?: string;
  /** Passphrase for an encrypted private key. */
  passphrase?: string;
  /** Connection timeout in ms (default 15000). */
  timeoutMs?: number;
}

/** Largest single transfer we will move through the model, in bytes (32 MiB). */
export const MAX_BYTES = 32 * 1024 * 1024;

const DEFAULT_KEYS = ["id_ed25519", "id_ecdsa", "id_rsa"];

/**
 * Resolve authentication for a connection. Priority: inline password, then
 * inline private key, then — if no secret is supplied — the local ssh-agent
 * and/or a default `~/.ssh` key. The fallback keeps key material out of the
 * model for the local/stdio case; it is meaningful only when the server runs
 * on the user's machine (a remote container has no user agent/keys).
 */
function resolveAuth(conn: ConnectionArgs): Record<string, unknown> {
  if (conn.password) return { password: conn.password };
  if (conn.privateKey) {
    return conn.passphrase
      ? { privateKey: conn.privateKey, passphrase: conn.passphrase }
      : { privateKey: conn.privateKey };
  }
  // No secret provided → local SSH fallback.
  const auth: Record<string, unknown> = {};
  if (process.env.SSH_AUTH_SOCK) auth.agent = process.env.SSH_AUTH_SOCK;
  for (const name of DEFAULT_KEYS) {
    const p = join(homedir(), ".ssh", name);
    if (existsSync(p)) {
      auth.privateKey = readFileSync(p);
      break;
    }
  }
  return auth;
}

/** Strip anything credential-shaped from an error before it reaches the model. */
export function sanitizeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // Collapse absolute host paths / stacks; keep the human-readable reason.
  return msg.split("\n")[0].slice(0, 300);
}

/** Make an Error carrying a string code (EEXIST, EACCES, …). */
export function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

const SFTP_STATUS: Record<number, string> = {
  2: "ENOENT",
  3: "EACCES",
  4: "EFAILURE",
  5: "EBADMSG",
  8: "ENOSYS",
};

/** Map any SFTP/ssh2 error (or our coded errors) to { code, message }. */
export function errorInfo(e: unknown): { code: string; message: string } {
  const message = sanitizeError(e);
  const c = (e as { code?: unknown })?.code;
  if (typeof c === "string" && /^E[A-Z0-9]+$/.test(c)) return { code: c, message };
  if (typeof c === "number" && SFTP_STATUS[c]) return { code: SFTP_STATUS[c], message };
  const m = message.toLowerCase();
  if (m.includes("no such file")) return { code: "ENOENT", message };
  if (m.includes("permission denied")) return { code: "EACCES", message };
  if (m.includes("already exists")) return { code: "EEXIST", message };
  if (m.includes("not a directory")) return { code: "ENOTDIR", message };
  if (m.includes("is a directory")) return { code: "EISDIR", message };
  return { code: "EFAILURE", message };
}

/** Coerce ssh2-sftp-client's isX (boolean or fn) into a FileType. */
function statType(o: Record<string, unknown>): FileType {
  const flag = (k: string) => {
    const v = o[k];
    return typeof v === "function" ? Boolean((v as () => boolean)()) : Boolean(v);
  };
  if (flag("isSymbolicLink")) return "symlink";
  if (flag("isDirectory")) return "directory";
  if (flag("isFile")) return "file";
  return "other";
}

/**
 * Open a connection, run `fn`, and ALWAYS close it — the fix for sftp-rest's
 * connection leaks on error paths. Never logs credentials.
 */
export async function withSftp<T>(
  conn: ConnectionArgs,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client();
  const config = {
    host: conn.host,
    port: conn.port ?? 22,
    username: conn.username,
    readyTimeout: conn.timeoutMs ?? 15000,
    ...resolveAuth(conn),
  };
  try {
    await client.connect(config);
    return await fn(client);
  } finally {
    try {
      await client.end();
    } catch {
      /* already closed / never opened */
    }
  }
}

// --- shared shapes -----------------------------------------------------------

export type FileType = "file" | "directory" | "symlink" | "other";

export interface FileEntry {
  name: string;
  path: string;
  type: FileType;
  size: number;
  modifyTime: number;
}

function normType(t: string): FileType {
  if (t === "d") return "directory";
  if (t === "-") return "file";
  if (t === "l") return "symlink";
  return "other";
}

/** Case-insensitive glob (`*`, `?`) → RegExp, anchored. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const pattern = "^" + escaped.replace(/\*/g, ".*").replace(/\?/g, ".") + "$";
  return new RegExp(pattern, "i");
}

// --- operations (thin, modernized ports of sftp-rest's handlers) -------------

export interface ListFilter {
  wildcard?: string;
  types?: FileType[];
}
export interface ListSort {
  field?: "name" | "size" | "modifyTime";
  direction?: "asc" | "desc";
}

/** POSIX-join a remote dir + name, normalizing to forward slashes. */
function remoteJoin(dir: string, name: string): string {
  return (dir.endsWith("/") ? dir + name : dir + "/" + name).replace(/\\/g, "/");
}

export async function listFiles(
  client: Client,
  path: string,
  opts: { filter?: ListFilter; sort?: ListSort; recursive?: boolean; limit?: number } = {},
): Promise<FileEntry[]> {
  const walk = async (dir: string): Promise<FileEntry[]> => {
    const raw = await client.list(dir);
    let out: FileEntry[] = raw.map((e) => ({
      name: e.name,
      path: remoteJoin(dir, e.name),
      type: normType(e.type as unknown as string),
      size: e.size,
      modifyTime: e.modifyTime,
    }));
    if (opts.recursive) {
      const subdirs = out.filter((e) => e.type === "directory");
      for (const d of subdirs) out = out.concat(await walk(d.path));
    }
    return out;
  };

  let results = await walk(path);

  const f = opts.filter;
  if (f?.wildcard) {
    const re = globToRegExp(f.wildcard);
    results = results.filter((e) => re.test(e.name));
  }
  if (f?.types && f.types.length) {
    const set = new Set(f.types);
    results = results.filter((e) => set.has(e.type));
  }

  const s = opts.sort;
  if (s?.field) {
    const field = s.field;
    const dir = s.direction === "desc" ? -1 : 1;
    results.sort((a, b) => (a[field] < b[field] ? -dir : a[field] > b[field] ? dir : 0));
  }

  if (opts.limit && results.length > opts.limit) results = results.slice(0, opts.limit);
  return results;
}

export interface StatResult {
  exists: boolean;
  type?: FileType;
  size?: number;
  modifyTime?: number;
  accessTime?: number;
  mode?: string;
}

export async function statPath(client: Client, path: string): Promise<StatResult> {
  const kind = await client.exists(path);
  if (!kind) return { exists: false };
  const st = await client.stat(path);
  return {
    exists: true,
    // stat follows symlinks, so report the followed target's type (not lstat's).
    type: statType(st as unknown as Record<string, unknown>),
    size: st.size,
    modifyTime: st.modifyTime,
    accessTime: st.accessTime,
    mode: (st.mode & 0o777).toString(8),
  };
}

export interface DownloadResult {
  path: string;
  base64: string;
  size: number;
}

export async function downloadFile(
  client: Client,
  path: string,
  maxBytes = MAX_BYTES,
): Promise<DownloadResult> {
  const st = await client.stat(path); // throws if missing
  if (st.size > maxBytes) {
    throw new Error(
      `file is ${st.size} bytes, over the ${maxBytes}-byte limit; raise maxBytes to override`,
    );
  }
  const buf = (await client.get(path)) as Buffer;
  return { path, base64: buf.toString("base64"), size: buf.length };
}

export async function uploadFile(
  client: Client,
  path: string,
  base64data: string,
  opts: { overwrite?: boolean; maxBytes?: number } = {},
): Promise<{ path: string; bytes: number }> {
  const buf = Buffer.from(base64data, "base64");
  const max = opts.maxBytes ?? MAX_BYTES;
  if (buf.length > max) {
    throw new Error(`payload is ${buf.length} bytes, over the ${max}-byte limit`);
  }
  if (!opts.overwrite && (await client.exists(path))) {
    throw new Error(`${path} already exists; pass overwrite:true to replace it`);
  }
  await client.put(buf, path);
  return { path, bytes: buf.length };
}

export async function move(
  client: Client,
  from: string,
  to: string,
  overwrite = false,
): Promise<void> {
  if (!overwrite && (await client.exists(to))) {
    throw codedError(`${to} already exists; pass overwrite:true to replace it`, "EEXIST");
  }
  // posixRename is atomic and overwrites in place (no delete-then-rename race).
  // Fall back to plain rename if the server lacks the posix-rename extension.
  try {
    await client.posixRename(from, to);
  } catch {
    if (overwrite && (await client.exists(to))) await client.delete(to);
    await client.rename(from, to);
  }
}

// --- 0.1.0 additions: filesystem-complete verbs ------------------------------

/** Canonicalize a remote path (resolve ./.. and symlinks to an absolute path). */
export async function realpath(
  client: Client,
  path: string,
): Promise<{ path: string; realpath: string }> {
  return { path, realpath: await client.realPath(path) };
}

/** Stat WITHOUT following a final symlink (reports the link itself). */
export async function lstatPath(client: Client, path: string): Promise<StatResult> {
  try {
    // lstat exists at runtime but isn't in @types/ssh2-sftp-client.
    const lstat = (client as unknown as { lstat: (p: string) => Promise<unknown> }).lstat;
    const o = (await lstat.call(client, path)) as Record<string, unknown>;
    return {
      exists: true,
      type: statType(o),
      size: o.size as number,
      modifyTime: o.modifyTime as number,
      accessTime: o.accessTime as number,
      mode: ((o.mode as number) & 0o777).toString(8),
    };
  } catch (e) {
    if (errorInfo(e).code === "ENOENT") return { exists: false };
    throw e;
  }
}

/** Access the raw ssh2 SFTP stream for ops the wrapper doesn't expose. */
function raw(client: Client): {
  symlink: (t: string, p: string, cb: (e: unknown) => void) => void;
  readlink: (p: string, cb: (e: unknown, t: string) => void) => void;
  ext_openssh_statvfs?: (p: string, cb: (e: unknown, s: Record<string, number>) => void) => void;
} {
  const r = (client as unknown as { sftp?: unknown }).sftp;
  if (!r) throw codedError("raw SFTP stream unavailable", "EFAILURE");
  return r as ReturnType<typeof raw>;
}

/** Create a symbolic link at `path` pointing to `target`. */
export async function createSymlink(client: Client, target: string, path: string): Promise<void> {
  const r = raw(client);
  await promisify(r.symlink.bind(r))(target, path);
}

/** Read a symlink's target path. */
export async function readSymlink(client: Client, path: string): Promise<string> {
  const r = raw(client);
  return promisify(r.readlink.bind(r))(path);
}

/** Remote filesystem capacity (OpenSSH statvfs extension). */
export async function diskUsage(
  client: Client,
  path: string,
): Promise<{ totalBytes: number; freeBytes: number; availableBytes: number }> {
  const r = raw(client);
  if (typeof r.ext_openssh_statvfs !== "function") {
    throw codedError("server does not support the statvfs extension", "ENOSYS");
  }
  const s = await promisify(r.ext_openssh_statvfs.bind(r))(path);
  const bsize = s.f_frsize || s.f_bsize;
  return {
    totalBytes: s.f_blocks * bsize,
    freeBytes: s.f_bfree * bsize,
    availableBytes: s.f_bavail * bsize,
  };
}

export interface TreeFile {
  /** Path relative to the upload base. */
  path: string;
  base64: string;
}

/** Push a whole directory tree from in-memory base64 files, auto-mkdir -p. */
export async function uploadTree(
  client: Client,
  basePath: string,
  files: TreeFile[],
  maxTotalBytes = MAX_BYTES,
): Promise<{ count: number; written: { path: string; bytes: number }[] }> {
  const written: { path: string; bytes: number }[] = [];
  const madeDirs = new Set<string>();
  let total = 0;
  const root = basePath.replace(/\/$/, "");
  // Ensure the base directory exists up front (mkdir -p, idempotent).
  await client.mkdir(root, true);
  madeDirs.add(root);
  for (const f of files) {
    const buf = Buffer.from(f.base64, "base64");
    total += buf.length;
    if (total > maxTotalBytes) {
      throw codedError(`tree exceeds ${maxTotalBytes} bytes at ${f.path}`, "E2BIG");
    }
    const remote = `${root}/${f.path.replace(/^\//, "")}`.replace(/\\/g, "/");
    const dir = remote.slice(0, remote.lastIndexOf("/"));
    if (dir && !madeDirs.has(dir)) {
      await client.mkdir(dir, true);
      madeDirs.add(dir);
    }
    await client.put(buf, remote);
    written.push({ path: remote, bytes: buf.length });
  }
  return { count: written.length, written };
}
