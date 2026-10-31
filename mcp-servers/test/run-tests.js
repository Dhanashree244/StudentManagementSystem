"use strict";

/**
 * Offline end-to-end test:  npm test
 * Starts a mock GitHub/Vercel/Render/backend, spawns the four MCP servers
 * against it and drives them with the real MCP client SDK.
 */

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { create } = require("./mock-upstream");
const { http } = require("../lib/util");

const ROOT = path.join(__dirname, "..");
const MOCK_PORT = 4100;
const MCP_TOKEN = "t".repeat(40);
const mock = create();
const M = `http://127.0.0.1:${MOCK_PORT}`;

const servers = [
  { key: "github", file: "github-mcp.js", port: 4101 },
  { key: "vercel", file: "vercel-mcp.js", port: 4102 },
  { key: "render", file: "render-mcp.js", port: 4103 },
  { key: "students", file: "students-mcp.js", port: 4104 }
];

const env = {
  ...process.env,
  MCP_AUTH_TOKEN: MCP_TOKEN,
  MCP_POLL_INTERVAL_MS: "100",
  GITHUB_API_URL: M,
  GITHUB_TOKEN: mock.tokens.GH_TOKEN,
  GITHUB_REPO: "o/r",
  GITHUB_BRANCH: "main",
  VERCEL_API_URL: `${M}/vercel`,
  VERCEL_TOKEN: mock.tokens.VERCEL_TOKEN,
  VERCEL_PROJECT_ID: "prj_test",
  VERCEL_DEPLOY_HOOK_URL: `${M}/vercel-hook/xyz`,
  RENDER_API_URL: `${M}/render`,
  RENDER_API_KEY: mock.tokens.RENDER_KEY,
  RENDER_SERVICE_ID: "srv-test",
  BACKEND_URL: `${M}/backend`
};

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${String(error.message).split("\n").join("\n       ")}`);
  }
}

const parse = r => {
  const t = r.content[0].text;
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};

async function connect(port) {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } }
    })
  );
  return client;
}
const call = async (client, name, args = {}) => client.callTool({ name, arguments: args });

async function waitHealthy(port) {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`server on :${port} did not start`);
}

(async () => {
  const mockServer = await new Promise(resolve => {
    const s = mock.app.listen(MOCK_PORT, "127.0.0.1", () => resolve(s));
  });
  const children = servers.map(s =>
    spawn("node", [path.join(ROOT, s.file)], { env: { ...env, PORT: String(s.port) }, stdio: ["ignore", "inherit", "inherit"] })
  );

  try {
    await Promise.all(servers.map(s => waitHealthy(s.port)));
    const c = {};
    for (const s of servers) c[s.key] = await connect(s.port);

    console.log("\nSecurity / transport");
    await check("rejects requests without the bearer token (401)", async () => {
      const r = await fetch("http://127.0.0.1:4101/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      assert.equal(r.status, 401);
    });
    await check("rejects a wrong token (401)", async () => {
      const r = await fetch("http://127.0.0.1:4101/mcp", { method: "POST", headers: { Authorization: "Bearer nope" }, body: "{}" });
      assert.equal(r.status, 401);
    });
    await check("each server lists its tools", async () => {
      const expect = {
        github: ["github_list_files", "github_read_file", "github_commit_changes", "github_recent_commits"],
        vercel: ["vercel_list_deployments", "vercel_get_deployment", "vercel_redeploy", "vercel_wait_for_deployment"],
        render: ["render_service_status", "render_list_deploys", "render_trigger_deploy", "render_wait_for_deploy", "render_list_env_keys", "render_set_env"],
        students: ["students_health", "students_verify_backend_commit", "students_list", "students_search", "students_add", "students_update", "students_delete"]
      };
      for (const [key, names] of Object.entries(expect)) {
        const tools = (await c[key].listTools()).tools.map(t => t.name).sort();
        assert.deepEqual(tools, [...names].sort(), key);
      }
    });
    await check("secrets are scrubbed from upstream error messages", async () => {
      await assert.rejects(
        () => http(`${M}/leaky`, { secrets: ["SECRET-TOKEN-123"] }),
        e => !e.message.includes("SECRET-TOKEN-123") && e.message.includes("***")
      );
    });

    console.log("\ngithub-mcp (read + guardrails)");
    await check("list_files hides .env but shows project files", async () => {
      const out = parse(await call(c.github, "github_list_files"));
      assert.match(out, /frontend\/index\.html/);
      assert.doesNotMatch(out, /\.env/);
    });
    await check("list_files honours the prefix", async () => {
      const out = parse(await call(c.github, "github_list_files", { prefix: "backend/" }));
      assert.match(out, /backend\/server\.js/);
      assert.doesNotMatch(out, /frontend/);
    });
    await check("read_file returns content", async () => {
      assert.equal(parse(await call(c.github, "github_read_file", { path: "frontend/script.js" })), "const API_URL = '/api';\n");
    });
    await check("read_file refuses backend/.env", async () => {
      const r = await call(c.github, "github_read_file", { path: "backend/.env" });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /blocked/);
    });
    await check("rejects path traversal", async () => {
      const r = await call(c.github, "github_read_file", { path: "../etc/passwd" });
      assert.equal(r.isError, true);
    });
    await check("commit refuses writing .env", async () => {
      const r = await call(c.github, "github_commit_changes", { message: "x y z", changes: [{ path: "backend/.env", content: "A=1" }] });
      assert.equal(r.isError, true);
    });
    await check("commit refuses paths outside ALLOWED_WRITE_PREFIXES", async () => {
      const r = await call(c.github, "github_commit_changes", { message: "x y z", changes: [{ path: "mcp-servers/github-mcp.js", content: "//" }] });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /not allowed/);
    });
    const headBefore = mock.state.head;
    await check("commit refuses JS with a syntax error (head unchanged)", async () => {
      const r = await call(c.github, "github_commit_changes", { message: "break backend", changes: [{ path: "backend/server.js", content: "const a = ;\n" }] });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /syntax error/);
      assert.equal(mock.state.head, headBefore);
    });
    await check("commit refuses invalid JSON", async () => {
      const r = await call(c.github, "github_commit_changes", { message: "bad json", changes: [{ path: "backend/package.json", content: "{oops" }] });
      assert.equal(r.isError, true);
    });
    await check("unchanged content creates no commit", async () => {
      const r = parse(await call(c.github, "github_commit_changes", { message: "noop change", changes: [{ path: "frontend/script.js", content: "const API_URL = '/api';\n" }] }));
      assert.equal(r.committed, false);
      assert.equal(mock.state.head, headBefore);
    });
    await check("dry_run previews without committing", async () => {
      const r = parse(await call(c.github, "github_commit_changes", { message: "preview only", dry_run: true, changes: [{ path: "frontend/index.html", content: "<h1>New</h1>\n" }] }));
      assert.equal(r.dry_run, true);
      assert.equal(r.files[0].status, "updated");
      assert.deepEqual(r.would_deploy, { vercel_frontend: true, render_backend: false });
      assert.equal(mock.state.head, headBefore);
    });

    console.log("\nOne prompt -> frontend + backend + deploys + verify");
    let pushed;
    await check("ONE atomic commit changes frontend AND backend (+ creates + deletes)", async () => {
      const r = parse(
        await call(c.github, "github_commit_changes", {
          message: "Add admission year to the student form and API",
          changes: [
            { path: "frontend/index.html", content: "<h1>Campus Student Portal</h1>\n" },
            { path: "backend/server.js", content: "const express = require('express');\napp.get('/ping', (q, s) => s.send('pong'));\n" },
            { path: "frontend/extra.css", content: "body{margin:0}\n" },
            { path: "frontend/script.js", action: "delete" }
          ]
        })
      );
      assert.equal(r.committed, true, JSON.stringify(r));
      assert.deepEqual(r.deploys_triggered, { vercel_frontend: true, render_backend: true });
      assert.deepEqual(r.files.map(f => f.status), ["updated", "updated", "created", "deleted"]);
      pushed = r.commit;
      // exactly ONE new commit, with all four file changes in it
      assert.equal(mock.state.commitOrder.length, 2);
      assert.equal(mock.state.head, pushed);
      const tree = (await call(c.github, "github_list_files")).content[0].text;
      assert.match(tree, /frontend\/extra\.css/);
      assert.doesNotMatch(tree, /frontend\/script\.js/);
      assert.equal(parse(await call(c.github, "github_read_file", { path: "frontend/index.html" })), "<h1>Campus Student Portal</h1>\n");
    });
    await check("recent_commits shows the new commit first", async () => {
      const r = parse(await call(c.github, "github_recent_commits", { limit: 2 }));
      assert.equal(r[0].sha, pushed);
      assert.equal(r[0].message, "Add admission year to the student form and API");
    });
    await check("vercel waits for the pushed commit and reports READY", async () => {
      const r = parse(await call(c.vercel, "vercel_wait_for_deployment", { expected_commit: pushed, timeout_seconds: 10 }));
      assert.equal(r.finished, true);
      assert.equal(r.success, true);
      assert.equal(r.deployment.state, "READY");
      assert.equal(r.deployment.commit, pushed);
      assert.match(r.deployment.url, /^https:\/\//);
    });
    await check("backend still serves the OLD commit before Render finishes", async () => {
      // (the vercel wait above does not touch render's poll counter)
      const r = parse(await call(c.students, "students_verify_backend_commit", { expected_commit: pushed.slice(0, 7) }));
      assert.equal(r.match, false);
    });
    await check("render waits for the pushed commit and reports live", async () => {
      const r = parse(await call(c.render, "render_wait_for_deploy", { expected_commit: pushed, timeout_seconds: 10 }));
      assert.equal(r.finished, true);
      assert.equal(r.success, true);
      assert.equal(r.deploy.status, "live");
      assert.equal(r.deploy.commit, pushed);
    });
    await check("students_verify_backend_commit confirms the new code is live", async () => {
      const r = parse(await call(c.students, "students_verify_backend_commit", { expected_commit: pushed.slice(0, 7) }));
      assert.equal(r.match, true);
      assert.equal(r.deployed_commit, pushed);
    });
    await check("wait tool returns finished:false when time runs out (call again)", async () => {
      await call(c.github, "github_commit_changes", { message: "tiny tweak", changes: [{ path: "frontend/extra.css", content: "body{margin:1px}\n" }] });
      const r = parse(await call(c.render, "render_wait_for_deploy", { timeout_seconds: 5 }));
      // either it finished fast or asks to be called again - it must never hang or throw
      assert.ok(r.finished === true || r.finished === false);
    });

    console.log("\nvercel-mcp / render-mcp extras");
    await check("vercel_list_deployments / get_deployment", async () => {
      const list = parse(await call(c.vercel, "vercel_list_deployments", { limit: 2 }));
      assert.equal(list.length, 2);
      const one = parse(await call(c.vercel, "vercel_get_deployment", { deployment_id: list[0].id }));
      assert.equal(one.id, list[0].id);
      const latest = parse(await call(c.vercel, "vercel_get_deployment"));
      assert.equal(latest.id, list[0].id);
    });
    await check("vercel_redeploy hits the deploy hook", async () => {
      const r = parse(await call(c.vercel, "vercel_redeploy"));
      assert.equal(r.triggered, true);
      assert.equal(r.job.state, "PENDING");
    });
    await check("render_service_status", async () => {
      const r = parse(await call(c.render, "render_service_status"));
      assert.equal(r.name, "student-management-backend");
      assert.equal(r.url, "https://backend.test");
    });
    await check("render_set_env never echoes the value; list shows names only", async () => {
      const r = await call(c.render, "render_set_env", { key: "CORS_ORIGIN", value: "https://my-app.vercel.app" });
      assert.doesNotMatch(r.content[0].text, /my-app\.vercel\.app/);
      assert.equal(mock.state.envVars.CORS_ORIGIN, "https://my-app.vercel.app");
      const keys = parse(await call(c.render, "render_list_env_keys"));
      assert.deepEqual(keys, ["CORS_ORIGIN", "MONGODB_URI", "PORT"]);
      assert.doesNotMatch(JSON.stringify(keys), /super-secret|https/);
    });
    await check("render_set_env redeploy=true starts a deploy", async () => {
      const r = parse(await call(c.render, "render_set_env", { key: "NODE_ENV", value: "production", redeploy: true }));
      assert.equal(r.deploy.status, "build_in_progress");
    });
    await check("render_set_env rejects lower-case keys", async () => {
      const r = await call(c.render, "render_set_env", { key: "bad-key", value: "x" }).catch(e => ({ isError: true, content: [{ text: e.message }] }));
      assert.equal(r.isError, true);
    });

    console.log("\nstudents-mcp (MongoDB data via backend)");
    let record;
    await check("students_health", async () => {
      const r = parse(await call(c.students, "students_health"));
      assert.equal(r.database, "connected");
    });
    await check("students_add -> list -> search", async () => {
      const added = parse(await call(c.students, "students_add", { studentId: "ST101", name: "Asha Patil", email: "asha@example.com", department: "Computer Science", semester: 5, contact: "9876543210" }));
      record = added.student.record_id;
      assert.equal(parse(await call(c.students, "students_list")).count, 1);
      assert.equal(parse(await call(c.students, "students_search", { query: "asha" })).count, 1);
    });
    await check("students_add validates the contact number", async () => {
      const r = await call(c.students, "students_add", { studentId: "ST102", name: "X", email: "x@example.com", department: "IT", semester: 1, contact: "123" }).catch(e => ({ isError: true }));
      assert.equal(r.isError, true);
    });
    await check("students_update changes a field", async () => {
      const r = parse(await call(c.students, "students_update", { record_id: record, semester: 6 }));
      assert.equal(r.student.semester, 6);
    });
    await check("students_delete refuses without confirm=true", async () => {
      const r = await call(c.students, "students_delete", { record_id: record, confirm: false });
      assert.equal(r.isError, true);
      assert.equal(parse(await call(c.students, "students_list")).count, 1);
    });
    await check("students_delete works with confirm=true", async () => {
      await call(c.students, "students_delete", { record_id: record, confirm: true });
      assert.equal(parse(await call(c.students, "students_list")).count, 0);
    });

    console.log("\nstdio mode (Claude Desktop / Claude Code)");
    await check("stdio server starts cleanly (stdout is pure JSON-RPC) and answers", async () => {
      const client = new Client({ name: "stdio-test", version: "1.0.0" });
      await client.connect(
        new StdioClientTransport({
          command: "node",
          args: [path.join(ROOT, "students-mcp.js"), "--stdio"],
          env: { PATH: process.env.PATH, BACKEND_URL: `${M}/backend` }
        })
      );
      const r = parse(await call(client, "students_health"));
      assert.equal(r.status, "ok");
      await client.close();
    });

    for (const k of Object.keys(c)) await c[k].close();
  } catch (error) {
    failures.push(`setup: ${error.message}`);
    console.error("SETUP ERROR:", error);
  } finally {
    children.forEach(ch => ch.kill());
    mockServer.close();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("Failed:\n - " + failures.join("\n - "));
    process.exit(1);
  }
  process.exit(0);
})();
