// Runs against the built dist + a live SFTP server.
// Local: `docker run -d --name sftp-test -p 2222:22 atmoz/sftp foo:testpass:1001::upload`
// Override with SFTP_HOST / SFTP_PORT / SFTP_USER / SFTP_PASS.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  withSftp,
  listFiles,
  statPath,
  downloadFile,
  uploadFile,
  move,
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

test("MCP round-trip: 11 tools registered, test_connection works", async () => {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverT);
  const client = new Client({ name: "smoke", version: "0" });
  await client.connect(clientT);

  const { tools } = await client.listTools();
  assert.equal(tools.length, 11);
  assert.ok(tools.find((t) => t.name === "download_pdf") === undefined);
  for (const name of ["list_files", "stat", "upload_file", "move", "chmod", "delete_dir"]) {
    assert.ok(tools.some((t) => t.name === name), `missing tool ${name}`);
  }

  const res = await client.callTool({ name: "test_connection", arguments: conn });
  assert.equal(res.isError ?? false, false);
  assert.match(res.content[0].text, /connected to/);

  await client.close();
});
