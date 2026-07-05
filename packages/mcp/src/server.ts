import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  codedError,
  createSymlink,
  diskUsage,
  downloadFile,
  errorInfo,
  listFiles,
  lstatPath,
  move,
  readSymlink,
  realpath,
  statPath,
  uploadFile,
  uploadTree,
  withSftp,
  MAX_BYTES,
  type ConnectionArgs,
  type FileType,
  type TreeFile,
} from "./sftp.js";

// Shared per-call connection fields — every tool takes these. No server config
// for the target/secret: those are named in the call itself.
const conn = {
  host: z.string().describe("SFTP server hostname or IP."),
  port: z.number().optional().describe("Port (default 22)."),
  username: z.string().describe("SSH username."),
  password: z.string().optional().describe("Inline password."),
  privateKey: z.string().optional().describe("Inline private key (PEM/OpenSSH)."),
  passphrase: z.string().optional().describe("Passphrase for an encrypted private key."),
  timeoutMs: z.number().optional().describe("Connection timeout in ms (default 15000)."),
};

const fileTypeEnum = z.enum(["file", "directory", "symlink", "other"]);

function pickConn(a: Record<string, unknown>): ConnectionArgs {
  return {
    host: a.host as string,
    port: a.port as number | undefined,
    username: a.username as string,
    password: a.password as string | undefined,
    privateKey: a.privateKey as string | undefined,
    passphrase: a.passphrase as string | undefined,
    timeoutMs: a.timeoutMs as number | undefined,
  };
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export interface ServerOptions {
  /** Refuse all mutating tools (safe to expose over a public endpoint). */
  readOnly?: boolean;
  /** If set, every path must fall under one of these roots (a jail). */
  allow?: string[];
}

/** POSIX-normalize a path (resolve `.` and `..`), preserving leading slash. */
function normPosix(p: string): string {
  const abs = p.startsWith("/");
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return (abs ? "/" : "") + parts.join("/");
}

function assertAllowed(p: string, allow: string[]): void {
  if (!allow.length) return;
  const n = normPosix(p);
  const ok = allow.some((root) => {
    const r = normPosix(root);
    return n === r || n.startsWith(r.endsWith("/") ? r : r + "/");
  });
  if (!ok) throw codedError(`path ${p} is outside the allowed roots`, "EACCES");
}

export function createServer(options: ServerOptions = {}): McpServer {
  const policy = { readOnly: !!options.readOnly, allow: options.allow ?? [] };
  const server = new McpServer({ name: "sftp-mcp", version: "0.1.0" });

  // Policy-aware runner: enforces read-only + path jail, JSON-encodes success,
  // and returns a structured { code, message } on failure (never leaks creds).
  async function run(
    opts: { write?: boolean; paths?: string[] },
    fn: () => Promise<unknown>,
  ): Promise<ToolResult> {
    try {
      if (opts.write && policy.readOnly) {
        throw codedError("server is running in read-only mode", "EROFS");
      }
      for (const p of opts.paths ?? []) assertAllowed(p, policy.allow);
      const result = await fn();
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify(errorInfo(e), null, 2) }], isError: true };
    }
  }

  // ---- connection --------------------------------------------------------
  server.registerTool(
    "test_connection",
    {
      title: "Test an SFTP connection",
      description:
        "Connect and immediately disconnect to validate credentials and " +
        "reachability. Omit the secret to use the local ssh-agent / ~/.ssh key.",
      inputSchema: { ...conn },
    },
    async (a) =>
      run({}, async () => {
        await withSftp(pickConn(a), async () => undefined);
        return { ok: true, message: `connected to ${a.host}:${a.port ?? 22}` };
      }),
  );

  // ---- read ---------------------------------------------------------------
  server.registerTool(
    "list_files",
    {
      title: "List a remote directory",
      description:
        "List a directory: optional glob + type filter, sort, and recursion. " +
        "Returns name, path, type, size, modifyTime.",
      inputSchema: {
        ...conn,
        path: z.string().describe("Remote directory to list."),
        wildcard: z.string().optional().describe("Glob on the name, e.g. *.pdf."),
        types: z.array(fileTypeEnum).optional().describe("Keep only these entry types."),
        sortField: z.enum(["name", "size", "modifyTime"]).optional(),
        sortDirection: z.enum(["asc", "desc"]).optional(),
        recursive: z.boolean().optional().describe("Descend into subdirectories."),
        limit: z.number().optional().describe("Cap the number of entries returned."),
      },
    },
    async (a) =>
      run({ paths: [a.path] }, () =>
        withSftp(pickConn(a), (c) =>
          listFiles(c, a.path, {
            filter: { wildcard: a.wildcard, types: a.types as FileType[] | undefined },
            sort: { field: a.sortField, direction: a.sortDirection },
            recursive: a.recursive,
            limit: a.limit,
          }),
        ),
      ),
  );

  server.registerTool(
    "stat",
    {
      title: "Stat a remote path (follows symlinks)",
      description: "Metadata for a path: exists, type, size, mtime, atime, octal perms.",
      inputSchema: { ...conn, path: z.string().describe("Remote path to stat.") },
    },
    async (a) => run({ paths: [a.path] }, () => withSftp(pickConn(a), (c) => statPath(c, a.path))),
  );

  server.registerTool(
    "lstat",
    {
      title: "Stat a remote path WITHOUT following symlinks",
      description:
        "Like stat, but reports the link itself for a symlink (type=symlink) " +
        "instead of its target. Use to detect symlinks.",
      inputSchema: { ...conn, path: z.string().describe("Remote path to lstat.") },
    },
    async (a) => run({ paths: [a.path] }, () => withSftp(pickConn(a), (c) => lstatPath(c, a.path))),
  );

  server.registerTool(
    "realpath",
    {
      title: "Canonicalize a remote path",
      description:
        "Resolve a path (including `.`/`..` and symlinks) to its absolute " +
        "canonical form. Handy for turning relative paths into absolute ones.",
      inputSchema: { ...conn, path: z.string().describe("Remote path to resolve.") },
    },
    async (a) => run({ paths: [a.path] }, () => withSftp(pickConn(a), (c) => realpath(c, a.path))),
  );

  server.registerTool(
    "read_symlink",
    {
      title: "Read a symlink's target",
      description: "Return the target path a symbolic link points to.",
      inputSchema: { ...conn, path: z.string().describe("Symlink path to read.") },
    },
    async (a) =>
      run({ paths: [a.path] }, () =>
        withSftp(pickConn(a), async (c) => ({ path: a.path, target: await readSymlink(c, a.path) })),
      ),
  );

  server.registerTool(
    "disk_usage",
    {
      title: "Remote filesystem capacity",
      description:
        "Total / free / available bytes for the filesystem containing a path " +
        "(OpenSSH statvfs extension; errors ENOSYS if the server lacks it).",
      inputSchema: {
        ...conn,
        path: z.string().optional().describe("A path on the target filesystem (default '.')."),
      },
    },
    async (a) =>
      run({ paths: a.path ? [a.path] : [] }, () =>
        withSftp(pickConn(a), (c) => diskUsage(c, a.path ?? ".")),
      ),
  );

  server.registerTool(
    "download_file",
    {
      title: "Download a file",
      description: `Download a file, base64-encoded. Refuses files over ${MAX_BYTES} bytes unless maxBytes is raised.`,
      inputSchema: {
        ...conn,
        path: z.string().describe("Remote file path."),
        maxBytes: z.number().optional().describe(`Size limit (default ${MAX_BYTES}).`),
      },
    },
    async (a) =>
      run({ paths: [a.path] }, () => withSftp(pickConn(a), (c) => downloadFile(c, a.path, a.maxBytes))),
  );

  server.registerTool(
    "download_files",
    {
      title: "Download multiple files",
      description:
        "Download every file in a directory matching an optional wildcard " +
        "(optionally recursive), each base64-encoded. Total size is capped.",
      inputSchema: {
        ...conn,
        path: z.string().describe("Remote directory."),
        wildcard: z.string().optional().describe("Glob filter, e.g. *.csv."),
        recursive: z.boolean().optional(),
        maxTotalBytes: z.number().optional().describe(`Total cap (default ${MAX_BYTES}).`),
      },
    },
    async (a) =>
      run({ paths: [a.path] }, () =>
        withSftp(pickConn(a), async (c) => {
          const files = await listFiles(c, a.path, {
            filter: { wildcard: a.wildcard, types: ["file"] },
            recursive: a.recursive,
          });
          const cap = a.maxTotalBytes ?? MAX_BYTES;
          const out: { path: string; base64: string; size: number }[] = [];
          let total = 0;
          for (const f of files) {
            total += f.size;
            if (total > cap) {
              throw codedError(
                `selection totals over ${cap} bytes at ${f.path}; narrow the wildcard or raise maxTotalBytes`,
                "E2BIG",
              );
            }
            const buf = (await c.get(f.path)) as Buffer;
            out.push({ path: f.path, base64: buf.toString("base64"), size: buf.length });
          }
          return { count: out.length, files: out };
        }),
      ),
  );

  // ---- write (blocked in read-only mode) ---------------------------------
  server.registerTool(
    "make_directory",
    {
      title: "Create a directory",
      description: "Create a remote directory. recursive:true creates parents (mkdir -p), idempotent.",
      inputSchema: {
        ...conn,
        path: z.string().describe("Remote directory to create."),
        recursive: z.boolean().optional().describe("Create parents / mkdir -p (default false)."),
      },
    },
    async (a) =>
      run({ write: true, paths: [a.path] }, () =>
        withSftp(pickConn(a), async (c) => {
          await c.mkdir(a.path, a.recursive ?? false);
          return { ok: true, created: a.path };
        }),
      ),
  );

  server.registerTool(
    "upload_file",
    {
      title: "Upload a file",
      description: "Upload base64 data. Fails if the path exists unless overwrite. Size-capped.",
      inputSchema: {
        ...conn,
        path: z.string().describe("Destination path (including filename)."),
        base64data: z.string().describe("File contents, base64-encoded."),
        overwrite: z.boolean().optional().describe("Replace an existing file (default false)."),
        maxBytes: z.number().optional(),
      },
    },
    async (a) =>
      run({ write: true, paths: [a.path] }, () =>
        withSftp(pickConn(a), (c) =>
          uploadFile(c, a.path, a.base64data, { overwrite: a.overwrite, maxBytes: a.maxBytes }),
        ),
      ),
  );

  server.registerTool(
    "upload_dir",
    {
      title: "Upload a directory tree",
      description:
        "Push a whole tree of in-memory files under a base directory, creating " +
        "parent directories as needed (mkdir -p). Pairs with recursive " +
        "download_files for full tree round-trips. Total size is capped.",
      inputSchema: {
        ...conn,
        path: z.string().describe("Remote base directory."),
        files: z
          .array(z.object({ path: z.string().describe("Path relative to base."), base64: z.string() }))
          .describe("Files to write, each relative to the base directory."),
        maxTotalBytes: z.number().optional().describe(`Total cap (default ${MAX_BYTES}).`),
      },
    },
    async (a) =>
      run({ write: true, paths: [a.path] }, () =>
        withSftp(pickConn(a), (c) => uploadTree(c, a.path, a.files as TreeFile[], a.maxTotalBytes)),
      ),
  );

  server.registerTool(
    "delete_file",
    {
      title: "Delete a file",
      description: "Delete a single remote file.",
      inputSchema: { ...conn, path: z.string().describe("Remote file to delete.") },
    },
    async (a) =>
      run({ write: true, paths: [a.path] }, () =>
        withSftp(pickConn(a), async (c) => {
          await c.delete(a.path);
          return { ok: true, deleted: a.path };
        }),
      ),
  );

  server.registerTool(
    "delete_dir",
    {
      title: "Delete a directory",
      description: "Remove a directory. recursive:true removes contents (rm -rf); else it must be empty.",
      inputSchema: {
        ...conn,
        path: z.string().describe("Remote directory to remove."),
        recursive: z.boolean().optional().describe("Remove contents too (default false)."),
      },
    },
    async (a) =>
      run({ write: true, paths: [a.path] }, () =>
        withSftp(pickConn(a), async (c) => {
          await c.rmdir(a.path, a.recursive ?? false);
          return { ok: true, removed: a.path, recursive: a.recursive ?? false };
        }),
      ),
  );

  server.registerTool(
    "move",
    {
      title: "Move or rename",
      description: "Atomically rename/move a file or directory. Fails if the destination exists unless overwrite.",
      inputSchema: {
        ...conn,
        path: z.string().describe("Current remote path."),
        newPath: z.string().describe("New remote path."),
        overwrite: z.boolean().optional().describe("Replace an existing destination."),
      },
    },
    async (a) =>
      run({ write: true, paths: [a.path, a.newPath] }, () =>
        withSftp(pickConn(a), async (c) => {
          await move(c, a.path, a.newPath, a.overwrite ?? false);
          return { ok: true, from: a.path, to: a.newPath };
        }),
      ),
  );

  server.registerTool(
    "chmod",
    {
      title: "Change permissions",
      description: 'Change permission bits. Pass mode as an octal string, e.g. "644".',
      inputSchema: {
        ...conn,
        path: z.string().describe("Remote path."),
        mode: z.string().describe('Octal permission string, e.g. "644".'),
      },
    },
    async (a) =>
      run({ write: true, paths: [a.path] }, () =>
        withSftp(pickConn(a), async (c) => {
          const octal = parseInt(a.mode, 8);
          if (Number.isNaN(octal)) throw codedError(`invalid octal mode: ${a.mode}`, "EINVAL");
          await c.chmod(a.path, octal);
          return { ok: true, path: a.path, mode: a.mode };
        }),
      ),
  );

  server.registerTool(
    "symlink",
    {
      title: "Create a symbolic link",
      description: "Create a symlink at `path` pointing to `target`.",
      inputSchema: {
        ...conn,
        target: z.string().describe("The path the link points to."),
        path: z.string().describe("Where to create the link."),
      },
    },
    async (a) =>
      run({ write: true, paths: [a.path] }, () =>
        withSftp(pickConn(a), async (c) => {
          await createSymlink(c, a.target, a.path);
          return { ok: true, path: a.path, target: a.target };
        }),
      ),
  );

  return server;
}
