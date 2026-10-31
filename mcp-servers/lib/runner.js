"use strict";

const path = require("node:path");
// quiet:true -> dotenv must not print to stdout (that would corrupt stdio MCP)
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const crypto = require("node:crypto");
const express = require("express");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  StreamableHTTPServerTransport
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");

function isAuthorized(req, token) {
  const provided = Buffer.from(req.get("authorization") || "");
  const expected = Buffer.from(`Bearer ${token}`);
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

/**
 * Start an MCP server in one of two modes:
 *   node x-mcp.js --stdio   -> local, for Claude Desktop / Claude Code
 *   node x-mcp.js           -> HTTP (Streamable HTTP) on $PORT, for Render
 * HTTP mode is stateless: nothing is lost when Render restarts or sleeps.
 */
async function run({ name, description, register }) {
  const makeServer = () => {
    const server = new McpServer({ name, version: "2.0.0" });
    register(server);
    return server;
  };

  if (process.argv.includes("--stdio")) {
    await makeServer().connect(new StdioServerTransport());
    console.error(`[${name}] running over stdio`);
    return;
  }

  const token = process.env.MCP_AUTH_TOKEN;
  if (!token || token.length < 32) {
    console.error(`[${name}] Set MCP_AUTH_TOKEN to a random secret of at least 32 characters.`);
    process.exit(1);
  }

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));

  app.get("/", (_req, res) => res.send(`${name}: ${description}`));
  app.get("/health", (_req, res) => res.json({ status: "ok", server: name }));

  app.post("/mcp", async (req, res) => {
    if (!isAuthorized(req, token)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const server = makeServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error(`[${name}] request failed:`, error.message);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null
        });
      }
    }
  });

  const methodNotAllowed = (_req, res) =>
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null
    });
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  const port = Number(process.env.PORT || 3000);
  app.listen(port, "0.0.0.0", () => {
    console.error(`[${name}] listening on :${port}  (POST /mcp, GET /health)`);
  });
}

module.exports = { run };
