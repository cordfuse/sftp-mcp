#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer, type ServerOptions } from "./server.js";

interface Opts {
  http: boolean;
  port: number;
  serverOptions: ServerOptions;
}

function parseArgs(argv: string[]): Opts {
  let http = false;
  let port = Number(process.env.PORT ?? 3901);
  let readOnly = process.env.SFTP_READONLY === "1" || process.env.SFTP_READONLY === "true";
  const allow: string[] = (process.env.SFTP_ALLOW ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--http") http = true;
    else if (argv[i] === "--port") port = Number(argv[++i]);
    else if (argv[i] === "--read-only" || argv[i] === "--readonly") readOnly = true;
    else if (argv[i] === "--allow") allow.push(argv[++i]);
  }
  return { http, port, serverOptions: { readOnly, allow } };
}

async function runStdio(opts: Opts): Promise<void> {
  const server = createServer(opts.serverOptions);
  await server.connect(new StdioServerTransport());
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : undefined);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

async function runHttp(port: number, serverOptions: ServerOptions): Promise<void> {
  // Stateful sessions: initialize mints an mcp-session-id; later requests route
  // back to the same server+transport; evicted on close.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createHttpServer(async (req, res) => {
    if (req.method === "GET" && (req.url ?? "").split("?")[0] === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: "sftp-mcp" }));
      return;
    }

    if ((req.url ?? "").split("?")[0] !== "/mcp") {
      res.writeHead(404).end();
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (req.method === "POST") {
      const body = await readBody(req).catch(() => undefined);
      let transport = sessionId ? transports.get(sessionId) : undefined;

      if (!transport && isInitializeRequest(body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports.set(sid, transport!);
          },
        });
        transport.onclose = () => {
          if (transport!.sessionId) transports.delete(transport!.sessionId);
        };
        await createServer(serverOptions).connect(transport);
      }

      if (!transport) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "no valid session; send an initialize request first" }));
        return;
      }
      await transport.handleRequest(req, res, body);
      return;
    }

    if ((req.method === "GET" || req.method === "DELETE") && sessionId) {
      const transport = transports.get(sessionId);
      if (!transport) {
        res.writeHead(404).end();
        return;
      }
      await transport.handleRequest(req, res);
      return;
    }

    res.writeHead(400).end();
  });

  httpServer.listen(port, () => {
    console.error(`sftp-mcp: streamable HTTP on :${port} (POST/GET/DELETE /mcp, GET /health)`);
  });
}

const opts = parseArgs(process.argv.slice(2));
(opts.http ? runHttp(opts.port, opts.serverOptions) : runStdio(opts)).catch((e) => {
  console.error(e);
  process.exit(1);
});
