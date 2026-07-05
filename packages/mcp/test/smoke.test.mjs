// Runs against the built dist + a live SFTP server.
// Local: `docker run -d --name sftp-test -p 2222:22 atmoz/sftp foo:testpass:1001::upload`
// Override with SFTP_HOST / SFTP_PORT / SFTP_USER / SFTP_PASS.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  withSftp,
  listFiles,
  statPath,
  lstatPath,
  downloadFile,
  uploadFile,
  move,
  realpath,
  createSymlink,
  readSymlink,
  diskUsage,
  uploadTree,
  errorInfo,
} from "../dist/sftp.js";
import { createServer } from "../dist/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const conn = {
  host: process.env.SFTP_HOST ?? "127.0.0.1",
  port: Number(process.env.SFTP_PORT ?? 2222),
  username: process.env.SFTP_USER ?? "foo",
  password: process.env.SFTP_PASS ?? "testpass",
};
const uniq = () => `/upload/t-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const b64 = (s) => Buffer.from(s).toString("base64");

test("full filesystem lifecycle over one connection", async () => {
  const dir = uniq();
  await withSftp(conn, async (c) => {
    await c.mkdir(dir, true);

    // upload -> list -> stat -> download round-trip
    await uploadFile(c, `${dir}/a.txt`, b64("hello sftp-mcp\n"));
    const listed = await listFiles(c, dir);
    assert.ok(listed.some((e) => e.name === "a.txt" && e.type === "file"));

    const st = await statPath(c, `${dir}/a.txt`);
    assert.equal(st.exists, true);
    assert.equal(st.size, 15);

    const dl = await downloadFile(c, `${dir}/a.txt`);
    assert.equal(Buffer.from(dl.base64, "base64").toString(), "hello sftp-mcp\n");

    // mkdir -p + move + recursive list
    await c.mkdir(`${dir}/sub/deep`, true);
    await move(c, `${dir}/a.txt`, `${dir}/sub/deep/b.txt`);
    const rec = await listFiles(c, dir, { recursive: true });
    assert.ok(rec.some((e) => e.path === `${dir}/sub/deep/b.txt`));

    // cleanup
    await c.rmdir(dir, true);
    assert.equal(await c.exists(dir), false);
  });
});

test("glob filter keeps only matching names", async () => {
  const dir = uniq();
  await withSftp(conn, async (c) => {
    await c.mkdir(dir, true);
    await uploadFile(c, `${dir}/keep.log`, b64("x"));
    await uploadFile(c, `${dir}/skip.txt`, b64("y"));
    const logs = await listFiles(c, dir, { filter: { wildcard: "*.log" } });
    assert.deepEqual(
      logs.map((e) => e.name),
      ["keep.log"],
    );
    await c.rmdir(dir, true);
  });
});

test("upload overwrite guard", async () => {
  const dir = uniq();
  await withSftp(conn, async (c) => {
    await c.mkdir(dir, true);
    await uploadFile(c, `${dir}/x`, b64("1"));
    await assert.rejects(() => uploadFile(c, `${dir}/x`, b64("2")), /already exists/);
    await uploadFile(c, `${dir}/x`, b64("2"), { overwrite: true }); // ok now
    await c.rmdir(dir, true);
  });
});

test("download size cap refuses oversized files", async () => {
  const dir = uniq();
  await withSftp(conn, async (c) => {
    await c.mkdir(dir, true);
    await uploadFile(c, `${dir}/big`, b64("0123456789"));
    await assert.rejects(() => downloadFile(c, `${dir}/big`, 1), /over the 1-byte limit/);
    await c.rmdir(dir, true);
  });
});

test("0.1.0 verbs: realpath, lstat, symlink/readlink, disk_usage, upload_dir", async () => {
  const dir = uniq();
  await withSftp(conn, async (c) => {
    // upload_dir creates the base + nested dirs from an in-memory tree
    const up = await uploadTree(c, dir, [
      { path: "real.txt", base64: b64("hello") },
      { path: "sub/deep/c.txt", base64: b64("C") },
    ]);
    assert.equal(up.count, 2);
    const rec = await listFiles(c, dir, { recursive: true });
    assert.ok(rec.some((e) => e.path === `${dir}/sub/deep/c.txt`));

    // realpath canonicalizes `..`
    const rp = await realpath(c, `${dir}/sub/../real.txt`);
    assert.equal(rp.realpath, `${dir}/real.txt`);

    // symlink + readlink + lstat(link)=symlink vs stat(link)=file
    await createSymlink(c, `${dir}/real.txt`, `${dir}/link.txt`);
    assert.equal(await readSymlink(c, `${dir}/link.txt`), `${dir}/real.txt`);
    assert.equal((await lstatPath(c, `${dir}/link.txt`)).type, "symlink");
    assert.equal((await statPath(c, `${dir}/link.txt`)).type, "file");

    // disk_usage (OpenSSH statvfs; tolerate a server that lacks the extension)
    try {
      const du = await diskUsage(c, dir);
      assert.ok(du.totalBytes > 0 && du.availableBytes >= 0);
    } catch (e) {
      assert.equal(errorInfo(e).code, "ENOSYS");
    }

    await c.rmdir(dir, true);
  });
});

test("move uses atomic overwrite and guards without it", async () => {
  const dir = uniq();
  await withSftp(conn, async (c) => {
    await c.mkdir(dir, true);
    await uploadFile(c, `${dir}/x`, b64("X"));
    await uploadFile(c, `${dir}/y`, b64("Y"));
    await move(c, `${dir}/x`, `${dir}/y`, true); // atomic overwrite
    assert.equal(Buffer.from((await downloadFile(c, `${dir}/y`)).base64, "base64").toString(), "X");
    assert.equal((await statPath(c, `${dir}/x`)).exists, false);
    await uploadFile(c, `${dir}/z`, b64("Z"));
    await assert.rejects(() => move(c, `${dir}/y`, `${dir}/z`), /already exists/);
    await c.rmdir(dir, true);
  });
});

test("MCP round-trip: 17 tools registered, test_connection works", async () => {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverT);
  const client = new Client({ name: "smoke", version: "0" });
  await client.connect(clientT);

  const { tools } = await client.listTools();
  assert.equal(tools.length, 17);
  for (const name of [
    "list_files", "stat", "lstat", "realpath", "read_symlink", "disk_usage",
    "upload_file", "upload_dir", "move", "chmod", "delete_dir", "symlink",
  ]) {
    assert.ok(tools.some((t) => t.name === name), `missing tool ${name}`);
  }

  const res = await client.callTool({ name: "test_connection", arguments: conn });
  assert.equal(res.isError ?? false, false);
  assert.match(res.content[0].text, /connected to/);

  await client.close();
});

test("read-only mode refuses writes with EROFS, allows reads", async () => {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createServer({ readOnly: true }).connect(serverT);
  const client = new Client({ name: "ro", version: "0" });
  await client.connect(clientT);

  const w = await client.callTool({ name: "make_directory", arguments: { ...conn, path: "/upload/ro" } });
  assert.equal(w.isError, true);
  assert.match(w.content[0].text, /EROFS/);

  const r = await client.callTool({ name: "list_files", arguments: { ...conn, path: "/upload" } });
  assert.equal(r.isError ?? false, false);
  await client.close();
});

test("path jail refuses paths outside the allowed root with EACCES", async () => {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createServer({ allow: ["/upload/allowed"] }).connect(serverT);
  const client = new Client({ name: "jail", version: "0" });
  await client.connect(clientT);

  const out = await client.callTool({ name: "list_files", arguments: { ...conn, path: "/etc" } });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /EACCES/);
  await client.close();
});
