import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  downloadFile,
  listFiles,
  move,
  sanitizeError,
  statPath,
  uploadFile,
  withSftp,
  MAX_BYTES,
  type ConnectionArgs,
  type FileType,
} from "./sftp.js";

// Shared per-call connection fields — every tool takes these. No server config:
// the target and (optional) secret are named in the call itself.
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

/** Run an op, JSON-encode success, sanitize failures (never leak creds). */
async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const result = await fn();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return { content: [{ type: "text", text: sanitizeError(e) }], isError: true };
  }
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "sftp-mcp", version: "0.0.1" });

  server.registerTool(
    "test_connection",
    {
      title: "Test an SFTP connection",
      description:
        "Connect to an SFTP server and immediately disconnect, to validate " +
        "credentials and reachability. Omit the secret to use the local " +
        "ssh-agent / default ~/.ssh key (stdio only).",
      inputSchema: { ...conn },
    },
    async (a) =>
      run(async () => {
        await withSftp(pickConn(a), async () => undefined);
        return { ok: true, message: `connected to ${a.host}:${a.port ?? 22}` };
      }),
  );

  server.registerTool(
    "list_files",
    {
      title: "List a remote directory",
      description:
        "List a directory, optionally filtered by wildcard and/or type, sorted, " +
        "and optionally recursive. Returns name, path, type, size, modifyTime.",
      inputSchema: {
        ...conn,
        path: z.string().describe("Remote directory to list."),
        wildcard: z.string().optional().describe("Glob filter on the name, e.g. *.pdf."),
        types: z.array(fileTypeEnum).optional().describe("Keep only these entry types."),
        sortField: z.enum(["name", "size", "modifyTime"]).optional(),
        sortDirection: z.enum(["asc", "desc"]).optional(),
        recursive: z.boolean().optional().describe("Descend into subdirectories."),
        limit: z.number().optional().describe("Cap the number of entries returned."),
      },
    },
    async (a) =>
      run(() =>
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
      title: "Stat a remote path",
      description:
        "Return metadata for a single remote path: exists, type, size, mtime, " +
        "atime, and octal permissions. Use as an existence check too.",
      inputSchema: { ...conn, path: z.string().describe("Remote path to stat.") },
    },
    async (a) => run(() => withSftp(pickConn(a), (c) => statPath(c, a.path))),
  );

  server.registerTool(
    "download_file",
    {
      title: "Download a file",
      description:
        `Download a single remote file and return it base64-encoded. Refuses ` +
        `files over ${MAX_BYTES} bytes unless maxBytes is raised.`,
      inputSchema: {
        ...conn,
        path: z.string().describe("Remote file path."),
        maxBytes: z.number().optional().describe(`Size limit (default ${MAX_BYTES}).`),
      },
    },
    async (a) => run(() => withSftp(pickConn(a), (c) => downloadFile(c, a.path, a.maxBytes))),
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
      run(() =>
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
              throw new Error(
                `selection totals over ${cap} bytes at ${f.path}; narrow the wildcard or raise maxTotalBytes`,
              );
            }
            const buf = (await c.get(f.path)) as Buffer;
            out.push({ path: f.path, base64: buf.toString("base64"), size: buf.length });
          }
          return { count: out.length, files: out };
        }),
      ),
  );

  server.registerTool(
    "upload_file",
    {
      title: "Upload a file",
      description:
        "Upload base64 data to a remote path. Fails if the path exists unless " +
        "overwrite is true. Size-capped.",
      inputSchema: {
        ...conn,
        path: z.string().describe("Destination remote path (including filename)."),
        base64data: z.string().describe("File contents, base64-encoded."),
        overwrite: z.boolean().optional().describe("Replace an existing file (default false)."),
        maxBytes: z.number().optional(),
      },
    },
    async (a) =>
      run(() =>
        withSftp(pickConn(a), (c) =>
          uploadFile(c, a.path, a.base64data, { overwrite: a.overwrite, maxBytes: a.maxBytes }),
        ),
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
      run(() =>
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
      description:
        "Remove a remote directory. With recursive:true, removes its contents " +
        "too (rm -rf); otherwise the directory must be empty.",
      inputSchema: {
        ...conn,
        path: z.string().describe("Remote directory to remove."),
        recursive: z.boolean().optional().describe("Remove contents too (default false)."),
      },
    },
    async (a) =>
      run(() =>
        withSftp(pickConn(a), async (c) => {
          await c.rmdir(a.path, a.recursive ?? false);
          return { ok: true, removed: a.path, recursive: a.recursive ?? false };
        }),
      ),
  );

  server.registerTool(
    "make_directory",
    {
      title: "Create a directory",
      description:
        "Create a remote directory. With recursive:true, creates missing parents " +
        "(mkdir -p) and is idempotent.",
      inputSchema: {
        ...conn,
        path: z.string().describe("Remote directory to create."),
        recursive: z.boolean().optional().describe("Create parents / mkdir -p (default false)."),
      },
    },
    async (a) =>
      run(() =>
        withSftp(pickConn(a), async (c) => {
          await c.mkdir(a.path, a.recursive ?? false);
          return { ok: true, created: a.path };
        }),
      ),
  );

  server.registerTool(
    "move",
    {
      title: "Move or rename",
      description:
        "Rename or move a remote file or directory. Fails if the destination " +
        "exists unless overwrite is true.",
      inputSchema: {
        ...conn,
        path: z.string().describe("Current remote path."),
        newPath: z.string().describe("New remote path."),
        overwrite: z.boolean().optional().describe("Replace an existing destination."),
      },
    },
    async (a) =>
      run(() =>
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
      description:
        "Change a remote path's permission bits. Pass mode as an octal string, " +
        'e.g. "644" or "755".',
      inputSchema: {
        ...conn,
        path: z.string().describe("Remote path."),
        mode: z.string().describe('Octal permission string, e.g. "644".'),
      },
    },
    async (a) =>
      run(() =>
        withSftp(pickConn(a), async (c) => {
          const octal = parseInt(a.mode, 8);
          if (Number.isNaN(octal)) throw new Error(`invalid octal mode: ${a.mode}`);
          await c.chmod(a.path, octal);
          return { ok: true, path: a.path, mode: a.mode };
        }),
      ),
  );

  return server;
}
