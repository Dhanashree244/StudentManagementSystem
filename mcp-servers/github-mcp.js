"use strict";

/**
 * github-mcp  -  the "code" platform.
 *
 * Vercel (frontend/) and Render (backend/) both auto-deploy from this GitHub
 * repo, so ONE commit created here updates frontend AND backend together.
 */

const crypto = require("node:crypto");
const vm = require("node:vm");
const { z } = require("zod");
const { run } = require("./lib/runner");
const { text, need, tool, http } = require("./lib/util");

const API = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
const WRITE_PREFIXES = (
  process.env.ALLOWED_WRITE_PREFIXES || "frontend/,backend/,README.md,render.yaml"
)
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const MAX_READ_BYTES = 200 * 1024;

function cfg() {
  return {
    token: need("GITHUB_TOKEN"),
    repo: need("GITHUB_REPO"),
    branch: (process.env.GITHUB_BRANCH || "main").trim()
  };
}

async function gh(path, { method = "GET", body } = {}) {
  const { token, repo } = cfg();
  return http(`${API}/repos/${repo}${path}`, {
    method,
    body,
    secrets: [token],
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "student-management-mcp"
    }
  });
}

/* ------------------------------ guardrails ------------------------------ */

function cleanPath(p) {
  if (
    typeof p !== "string" ||
    !p.trim() ||
    p.startsWith("/") ||
    p.includes("\\") ||
    p.includes("\0")
  ) {
    throw new Error(`Invalid path "${p}". Use a relative path like frontend/script.js`);
  }
  const parts = p.split("/");
  if (parts.some(x => !x || x === "." || x === "..")) {
    throw new Error(`Invalid path "${p}".`);
  }
  const lower = parts.map(x => x.toLowerCase());
  const base = lower[lower.length - 1];
  const isSecret =
    lower.includes(".git") ||
    lower.includes("node_modules") ||
    (base === ".env" || (base.startsWith(".env.") && base !== ".env.example")) ||
    /\.(pem|key|p12|pfx)$/.test(base);
  if (isSecret) {
    throw new Error(`Path "${p}" is blocked (secrets / git internals / dependencies).`);
  }
  return p;
}

function assertWritable(p) {
  const ok = WRITE_PREFIXES.some(prefix => (prefix.endsWith("/") ? p.startsWith(prefix) : p === prefix));
  if (!ok) {
    throw new Error(
      `Writing "${p}" is not allowed. Allowed: ${WRITE_PREFIXES.join(", ")} ` +
        "(change ALLOWED_WRITE_PREFIXES to widen this)."
    );
  }
}

/** Refuse to push code that cannot even be parsed (it would break a deploy). */
function validateSource(path, content) {
  if (/\.json$/i.test(path)) {
    try {
      JSON.parse(content);
    } catch (error) {
      throw new Error(`${path} is not valid JSON: ${error.message}`);
    }
  } else if (/\.(c?js)$/i.test(path)) {
    try {
      new vm.Script(`(function(exports,require,module,__filename,__dirname){${content}\n})`, {
        filename: path
      });
    } catch (error) {
      throw new Error(
        `${path} has a JavaScript syntax error: ${error.message}. ` +
          "Fix it (or pass validate=false for ES-module code)."
      );
    }
  }
}

const gitBlobSha = content =>
  crypto
    .createHash("sha1")
    .update(`blob ${Buffer.byteLength(content, "utf8")}\0`)
    .update(content, "utf8")
    .digest("hex");

const platformsTouched = paths => ({
  vercel_frontend: paths.some(p => p.startsWith("frontend/")),
  render_backend: paths.some(p => p.startsWith("backend/"))
});

/* -------------------------------- server -------------------------------- */

function register(server) {
  server.registerTool(
    "github_list_files",
    {
      description:
        "List files in the project repo (whole tree, or only under a folder prefix such as 'frontend/'). Secrets and node_modules are hidden.",
      inputSchema: { prefix: z.string().default("") }
    },
    tool(async ({ prefix }) => {
      const { branch } = cfg();
      const tree = await gh(`/git/trees/${encodeURIComponent(branch)}?recursive=1`);
      const files = tree.tree
        .filter(e => e.type === "blob" && e.path.startsWith(prefix))
        .filter(e => {
          try {
            cleanPath(e.path);
            return true;
          } catch {
            return false;
          }
        })
        .map(e => `${e.path}  (${e.size ?? "?"} bytes)`);
      return text(files.length ? files.join("\n") : "No files found.");
    })
  );

  server.registerTool(
    "github_read_file",
    {
      description: "Read one text file from the repo (latest commit on the configured branch).",
      inputSchema: { path: z.string() }
    },
    tool(async ({ path }) => {
      cleanPath(path);
      const { branch } = cfg();
      const file = await gh(`/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`);
      if (Array.isArray(file) || file.type !== "file") {
        throw new Error(`"${path}" is a folder. Use github_list_files.`);
      }
      if (file.size > MAX_READ_BYTES) {
        throw new Error(`"${path}" is ${file.size} bytes; limit is ${MAX_READ_BYTES}.`);
      }
      const content = Buffer.from(file.content || "", "base64").toString("utf8");
      if (content.includes("\0")) throw new Error("Binary files cannot be read as text.");
      return text(content);
    })
  );

  server.registerTool(
    "github_commit_changes",
    {
      description:
        "Create/update/delete SEVERAL files in ONE atomic commit (e.g. frontend + backend together). " +
        "Vercel and Render then auto-deploy from the push. Always send the FULL new content of each file. " +
        "Use dry_run=true to preview. Read the current file first with github_read_file.",
      inputSchema: {
        message: z.string().min(3).max(200),
        changes: z
          .array(
            z.object({
              path: z.string(),
              action: z.enum(["write", "delete"]).default("write"),
              content: z.string().max(200000).optional()
            })
          )
          .min(1)
          .max(30),
        validate: z.boolean().default(true),
        dry_run: z.boolean().default(false)
      }
    },
    tool(async ({ message, changes, validate, dry_run }) => {
      const { branch } = cfg();

      const seen = new Set();
      for (const change of changes) {
        cleanPath(change.path);
        assertWritable(change.path);
        if (seen.has(change.path)) throw new Error(`Duplicate path in changes: ${change.path}`);
        seen.add(change.path);
        if (change.action === "write") {
          if (typeof change.content !== "string") {
            throw new Error(`"${change.path}": content is required for action=write.`);
          }
          if (validate) validateSource(change.path, change.content);
        }
      }

      const ref = await gh(`/git/ref/heads/${encodeURIComponent(branch)}`);
      const headSha = ref.object.sha;
      const headCommit = await gh(`/git/commits/${headSha}`);
      const baseTree = headCommit.tree.sha;
      const existingTree = await gh(`/git/trees/${baseTree}?recursive=1`);
      const existing = new Map(existingTree.tree.filter(e => e.type === "blob").map(e => [e.path, e.sha]));

      const plan = [];
      for (const change of changes) {
        const before = existing.get(change.path);
        if (change.action === "delete") {
          if (!before) throw new Error(`Cannot delete "${change.path}": it does not exist.`);
          plan.push({ path: change.path, status: "deleted" });
        } else {
          const status = !before ? "created" : before === gitBlobSha(change.content) ? "unchanged" : "updated";
          plan.push({ path: change.path, status, content: change.content });
        }
      }

      const effective = plan.filter(p => p.status !== "unchanged");
      const summary = plan.map(p => ({ path: p.path, status: p.status }));

      if (effective.length === 0) {
        return text({ committed: false, reason: "No file content changed.", files: summary });
      }
      if (dry_run) {
        return text({
          committed: false,
          dry_run: true,
          files: summary,
          would_deploy: platformsTouched(effective.map(p => p.path))
        });
      }

      const treeEntries = [];
      for (const item of effective) {
        if (item.status === "deleted") {
          treeEntries.push({ path: item.path, mode: "100644", type: "blob", sha: null });
        } else {
          const blob = await gh("/git/blobs", {
            method: "POST",
            body: { content: item.content, encoding: "utf-8" }
          });
          treeEntries.push({ path: item.path, mode: "100644", type: "blob", sha: blob.sha });
        }
      }

      const newTree = await gh("/git/trees", {
        method: "POST",
        body: { base_tree: baseTree, tree: treeEntries }
      });
      const newCommit = await gh("/git/commits", {
        method: "POST",
        body: { message, tree: newTree.sha, parents: [headSha] }
      });
      try {
        await gh(`/git/refs/heads/${encodeURIComponent(branch)}`, {
          method: "PATCH",
          body: { sha: newCommit.sha, force: false }
        });
      } catch (error) {
        throw new Error(`${error.message} (the branch may have moved - read the files again and retry)`);
      }

      return text({
        committed: true,
        commit: newCommit.sha,
        short: newCommit.sha.slice(0, 7),
        url: newCommit.html_url || null,
        branch,
        files: summary,
        deploys_triggered: platformsTouched(effective.map(p => p.path)),
        next:
          "Vercel/Render auto-deploy from this push. Use vercel_wait_for_deployment and " +
          "render_wait_for_deploy, then students_verify_backend_commit with this commit sha."
      });
    })
  );

  server.registerTool(
    "github_recent_commits",
    {
      description: "Show the latest commits on the configured branch.",
      inputSchema: { limit: z.number().int().min(1).max(20).default(5) }
    },
    tool(async ({ limit }) => {
      const { branch } = cfg();
      const commits = await gh(`/commits?sha=${encodeURIComponent(branch)}&per_page=${limit}`);
      return text(
        commits.map(c => ({
          sha: c.sha,
          short: c.sha.slice(0, 7),
          message: String(c.commit.message).split("\n")[0],
          author: c.commit.author && c.commit.author.name,
          date: c.commit.author && c.commit.author.date
        }))
      );
    })
  );
}

run({
  name: "student-github",
  description: "GitHub repo access + atomic multi-file commits for the Student Management System",
  register
});
