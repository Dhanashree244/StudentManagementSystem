
require("dotenv").config();

const express = require("express");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  StreamableHTTPServerTransport
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const {
  isInitializeRequest
} = require("@modelcontextprotocol/sdk/types.js");
const { z } = require("zod");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 3000);
const PROJECT_DIR = path.resolve(__dirname, "..");
const TOKEN = process.env.MCP_AUTH_TOKEN;

if (!TOKEN || TOKEN.length < 32) {
  console.error(
    "Set MCP_AUTH_TOKEN to a random secret of at least 32 characters."
  );
  process.exit(1);
}

const sessions = new Map();

const blockedNames = new Set([
  ".env",
  ".env.local",
  ".env.production",
  "server.js.backup"
]);

function safePath(relativePath) {
  if (
    typeof relativePath !== "string" ||
    !relativePath.trim() ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error("Provide a valid relative project path.");
  }

  const parts = relativePath.split(/[\\/]+/);

  if (
    parts.some(
      part =>
        !part ||
        part === "." ||
        part === ".." ||
        part.startsWith(".") ||
        part.toLowerCase() === "node_modules" ||
        part.toLowerCase() === ".git"
    ) ||
    parts.some(part => blockedNames.has(part.toLowerCase()))
  ) {
    throw new Error("This path is blocked.");
  }

  const resolved = path.resolve(PROJECT_DIR, relativePath);

  if (!resolved.startsWith(PROJECT_DIR + path.sep)) {
    throw new Error("Access outside the project is not allowed.");
  }

  return resolved;
}

async function checkRegularFile(file) {
  const stat = await fs.lstat(file);

  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > 100000
  ) {
    throw new Error("Only regular files up to 100 KB are allowed.");
  }

  return stat;
}

function makeServer() {
  const server = new McpServer({
    name: "student-management-project",
    version: "1.0.0"
  });

  // TOOL 1: List project files and folders.
  server.registerTool(
    "list_project_files",
    {
      description: "List files and folders within the project.",
      inputSchema: {
        folder: z.string().default("")
      }
    },
    async ({ folder }) => {
      const dir = folder ? safePath(folder) : PROJECT_DIR;
      const entries = await fs.readdir(dir, {
        withFileTypes: true
      });

      const visibleEntries = entries
        .filter(
          entry =>
            !entry.name.startsWith(".") &&
            entry.name.toLowerCase() !== "node_modules"
        )
        .map(
          entry =>
            `${entry.isDirectory() ? "[DIR]" : "[FILE]"} ${entry.name}`
        )
        .join("\n");

      return {
        content: [
          {
            type: "text",
            text: visibleEntries || "No files found."
          }
        ]
      };
    }
  );

  // TOOL 2: Read a project file.
  server.registerTool(
    "read_project_file",
    {
      description: "Read a text file from the project, excluding secrets.",
      inputSchema: {
        file: z.string()
      }
    },
    async ({ file }) => {
      const target = safePath(file);
      await checkRegularFile(target);

      const content = await fs.readFile(target, "utf8");

      if (content.includes("\u0000")) {
        throw new Error("Binary files cannot be read as text.");
      }

      return {
        content: [{ type: "text", text: content }]
      };
    }
  );

  // TOOL 3: Create a new file without overwriting an existing file.
  server.registerTool(
    "create_project_file",
    {
      description:
        "Create a new text file in the project. Existing files are not overwritten.",
      inputSchema: {
        file: z.string(),
        content: z.string().max(100000)
      }
    },
    async ({ file, content }) => {
      const target = safePath(file);

      await fs.mkdir(path.dirname(target), {
        recursive: true
      });

      await fs.writeFile(target, content, {
        encoding: "utf8",
        flag: "wx"
      });

      return {
        content: [
          {
            type: "text",
            text: `Created ${file}`
          }
        ]
      };
    }
  );

  // TOOL 4: Edit a file after creating a backup.
  server.registerTool(
    "edit_project_file",
    {
      description:
        "Replace a project's text file after making a timestamped backup.",
      inputSchema: {
        file: z.string(),
        content: z.string().max(100000)
      }
    },
    async ({ file, content }) => {
      const target = safePath(file);
      await checkRegularFile(target);

      const current = await fs.readFile(target, "utf8");

      if (current.includes("\u0000")) {
        throw new Error("Binary files cannot be edited.");
      }

      const backup = `${target}.${Date.now()}.bak`;

      await fs.copyFile(
        target,
        backup,
        crypto.constants.COPYFILE_EXCL
      );

      await fs.writeFile(target, content, "utf8");

      return {
        content: [
          {
            type: "text",
            text:
              `Updated ${file}. Backup created at ` +
              path.relative(PROJECT_DIR, backup)
          }
        ]
      };
    }
  );

  return server;
}

function isAuthorized(req) {
  const provided = req.get("authorization") || "";
  const expected = `Bearer ${TOKEN}`;

  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);

  return (
    providedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

app.get("/", (_req, res) => {
  res.send("Student Management MCP server is running.");
});

// MCP Streamable HTTP endpoint.
app.post("/mcp", async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const sessionId = req.get("mcp-session-id");
  let entry = sessionId ? sessions.get(sessionId) : undefined;

  if (sessionId && !entry) {
    return res.status(404).json({
      error: "Session not found. Initialize a new session."
    });
  }

  try {
    if (!entry && isInitializeRequest(req.body)) {
      const server = makeServer();
      let transport;

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),

        onsessioninitialized: id => {
          sessions.set(id, { transport, server });
        }
      });

      transport.onclose = async () => {
        const id = transport.sessionId;

        if (id) {
          sessions.delete(id);
        }

        await server.close();
      };

      await server.connect(transport);
      entry = { transport, server };
    } else if (!entry) {
      return res.status(400).json({
        error: "Initialize an MCP session first."
      });
    }

    await entry.transport.handleRequest(req, res, req.body);
    console.log("Session after request:", entry.transport.sessionId);
console.log("Stored session IDs after request:", [...sessions.keys()]);

// Save the session so the next request can find it.
if (entry.transport.sessionId) {
  sessions.set(entry.transport.sessionId, entry);
}
  } catch (error) {
    console.error("MCP request failed:", error.message);

    if (!res.headersSent) {
      res.status(500).json({
        error: "MCP request failed."
      });
    }
  }
});

app.get("/mcp", (_req, res) => {
  res.status(405).send("GET transport is not enabled in this example.");
});

app.delete("/mcp", async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).end();
  }

  const sessionId = req.get("mcp-session-id");
  console.log("Incoming session ID:", sessionId);
console.log("Stored session IDs:", [...sessions.keys()]);
  const entry = sessionId ? sessions.get(sessionId) : undefined;

  if (!entry) {
    return res.status(404).json({ error: "Session not found." });
  }

  try {
    await entry.transport.close();
    sessions.delete(sessionId);
    res.status(200).end();
  } catch (error) {
    console.error("MCP session close failed:", error.message);

    if (!res.headersSent) {
      res.status(500).json({ error: "Could not close MCP session." });
    }
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MCP server listening on port ${PORT}`);
  console.log("Project directory:", PROJECT_DIR);
  console.log("MCP endpoint: /mcp");
});
