"use strict";

/**
 * Offline stand-in for GitHub + Vercel + Render + the student backend.
 * It is wired together like production: a push to the branch "auto-deploys"
 * to the fake Vercel and fake Render, and the fake backend's /health then
 * reports the new commit once the fake Render deploy is live.
 */

const crypto = require("node:crypto");
const express = require("express");

const GH_TOKEN = "gh-test-token";
const RENDER_KEY = "render-test-key";
const VERCEL_TOKEN = "vercel-test-token";

const blobSha = c =>
  crypto.createHash("sha1").update(`blob ${Buffer.byteLength(c)}\0`).update(c).digest("hex");

function create() {
  const app = express();
  app.use(express.json({ limit: "5mb" }));

  /* ---------------- GitHub ---------------- */
  const blobs = {};
  const trees = {};
  const commits = {};
  let treeCounter = 0;
  const seed = new Map([
    ["frontend/index.html", "<h1>Student Management System</h1>\n"],
    ["frontend/script.js", "const API_URL = '/api';\n"],
    ["backend/server.js", "const express = require('express');\n"],
    ["backend/.env", "MONGODB_URI=super-secret\n"],
    ["backend/package.json", '{"name":"backend"}\n'],
    ["mcp-servers/github-mcp.js", "// not writable by prompt\n"]
  ]);
  const makeTree = files => {
    const sha = `tree${++treeCounter}`;
    trees[sha] = new Map(files);
    return sha;
  };
  const sha0 = "a".repeat(40);
  commits[sha0] = { sha: sha0, tree: makeTree([...seed].map(([p, c]) => [p, { sha: blobSha(c), content: c }])), message: "initial", parents: [], date: new Date().toISOString() };
  const state = {
    head: sha0,
    commitOrder: [sha0],
    renderDeploys: [],
    vercelDeploys: [],
    backendCommit: null,
    students: [],
    envVars: { MONGODB_URI: "x", PORT: "10000" },
    log: []
  };

  const ghAuth = (req, res, next) =>
    req.get("authorization") === `Bearer ${GH_TOKEN}` ? next() : res.status(401).json({ message: "Bad credentials" });
  const gh = express.Router();
  gh.use(ghAuth);
  gh.get("/git/ref/heads/:branch", (req, res) => res.json({ object: { sha: state.head } }));
  gh.get("/git/commits/:sha", (req, res) => {
    const c = commits[req.params.sha];
    c ? res.json({ sha: c.sha, tree: { sha: c.tree } }) : res.status(404).json({ message: "Not Found" });
  });
  gh.get("/git/trees/:sha", (req, res) => {
    const key = req.params.sha === "main" ? commits[state.head].tree : req.params.sha;
    const t = trees[key];
    if (!t) return res.status(404).json({ message: "Not Found" });
    res.json({
      truncated: false,
      tree: [...t].map(([path, f]) => ({ path, type: "blob", sha: f.sha, size: Buffer.byteLength(f.content) }))
    });
  });
  gh.post("/git/blobs", (req, res) => {
    const sha = blobSha(req.body.content);
    blobs[sha] = req.body.content;
    res.status(201).json({ sha });
  });
  gh.post("/git/trees", (req, res) => {
    const next = new Map(trees[req.body.base_tree]);
    for (const e of req.body.tree) {
      if (e.sha === null) {
        if (!next.has(e.path)) return res.status(422).json({ message: "path not in tree" });
        next.delete(e.path);
      } else next.set(e.path, { sha: e.sha, content: blobs[e.sha] });
    }
    res.status(201).json({ sha: makeTree(next) });
  });
  gh.post("/git/commits", (req, res) => {
    const sha = crypto.randomBytes(20).toString("hex");
    commits[sha] = { sha, tree: req.body.tree, message: req.body.message, parents: req.body.parents, date: new Date().toISOString() };
    res.status(201).json({ sha, html_url: `https://github.test/o/r/commit/${sha}` });
  });
  gh.patch("/git/refs/heads/:branch", (req, res) => {
    const c = commits[req.body.sha];
    if (!c || c.parents[0] !== state.head) return res.status(422).json({ message: "Update is not a fast forward" });
    state.head = c.sha;
    state.commitOrder.push(c.sha);
    state.log.push(`push ${c.sha.slice(0, 7)}`);
    // auto-deploy both platforms, like the real Git integrations do
    state.renderDeploys.unshift({ id: `dep-${c.sha.slice(0, 7)}`, status: "build_in_progress", trigger: "new_commit", commit: { id: c.sha, message: c.message }, createdAt: new Date().toISOString(), polls: 0 });
    state.vercelDeploys.unshift({ uid: `dpl_${c.sha.slice(0, 7)}`, state: "BUILDING", url: `student-${c.sha.slice(0, 5)}.vercel.app`, meta: { githubCommitSha: c.sha, githubCommitMessage: c.message }, createdAt: Date.now(), polls: 0 });
    res.json({ ref: "refs/heads/main", object: { sha: c.sha } });
  });
  gh.get("/contents/*path", (req, res) => {
    const p = [].concat(req.params.path).join("/");
    const f = trees[commits[state.head].tree].get(p);
    if (!f) return res.status(404).json({ message: "Not Found" });
    res.json({ type: "file", size: Buffer.byteLength(f.content), content: Buffer.from(f.content).toString("base64").replace(/(.{60})/g, "$1\n"), encoding: "base64" });
  });
  gh.get("/commits", (req, res) =>
    res.json(
      [...state.commitOrder].reverse().slice(0, Number(req.query.per_page || 5)).map(s => ({
        sha: s,
        commit: { message: `${commits[s].message}\n\nbody`, author: { name: "Tester", date: commits[s].date } }
      }))
    )
  );
  app.use("/repos/o/r", gh);

  /* ---------------- Render ---------------- */
  const rAuth = (req, res, next) =>
    req.get("authorization") === `Bearer ${RENDER_KEY}` ? next() : res.status(401).json({ message: "Unauthorized" });
  const r = express.Router();
  r.use(rAuth);
  const advance = d => {
    d.polls += 1;
    if (d.status === "build_in_progress" && d.polls >= 3) {
      d.status = "live";
      d.finishedAt = new Date().toISOString();
      if (d.commit && d.commit.id) state.backendCommit = d.commit.id;
    }
  };
  const strip = ({ polls, ...rest }) => rest;
  r.get("/services/srv-test", (req, res) =>
    res.json({ id: "srv-test", name: "student-management-backend", type: "web_service", branch: "main", autoDeploy: "yes", suspended: "not_suspended", serviceDetails: { url: "https://backend.test" } })
  );
  r.get("/services/srv-test/deploys", (req, res) => {
    state.renderDeploys.forEach(advance);
    res.json(state.renderDeploys.slice(0, Number(req.query.limit || 20)).map(d => ({ deploy: strip(d), cursor: d.id })));
  });
  r.post("/services/srv-test/deploys", (req, res) => {
    const d = { id: `dep-manual-${state.renderDeploys.length}`, status: "build_in_progress", trigger: "api", commit: { id: state.head, message: "manual" }, createdAt: new Date().toISOString(), polls: 0 };
    state.renderDeploys.unshift(d);
    res.status(201).json(strip(d));
  });
  r.get("/services/srv-test/deploys/:id", (req, res) => {
    const d = state.renderDeploys.find(x => x.id === req.params.id);
    if (!d) return res.status(404).json({ message: "deploy not found" });
    advance(d);
    res.json(strip(d));
  });
  r.get("/services/srv-test/env-vars", (req, res) =>
    res.json(Object.entries(state.envVars).map(([key, value]) => ({ envVar: { key, value }, cursor: key })))
  );
  r.put("/services/srv-test/env-vars/:key", (req, res) => {
    state.envVars[req.params.key] = req.body.value;
    res.json({ key: req.params.key, value: req.body.value });
  });
  app.use("/render", r);

  /* ---------------- Vercel ---------------- */
  const vAuth = (req, res, next) =>
    req.get("authorization") === `Bearer ${VERCEL_TOKEN}` ? next() : res.status(403).json({ error: { message: "Not authorized" } });
  const vadv = d => {
    d.polls += 1;
    if (d.state === "BUILDING" && d.polls >= 2) d.state = "READY";
  };
  const vstrip = ({ polls, ...rest }) => ({ ...rest, readyState: rest.state });
  app.get("/vercel/v6/deployments", vAuth, (req, res) => {
    state.vercelDeploys.forEach(vadv);
    res.json({ deployments: state.vercelDeploys.slice(0, Number(req.query.limit || 20)).map(vstrip) });
  });
  app.get("/vercel/v13/deployments/:id", vAuth, (req, res) => {
    const d = state.vercelDeploys.find(x => x.uid === req.params.id);
    if (!d) return res.status(404).json({ error: { message: "not found" } });
    vadv(d);
    res.json({ ...vstrip(d), id: d.uid });
  });
  app.post("/vercel-hook/xyz", (req, res) => {
    state.vercelDeploys.unshift({ uid: `dpl_hook${state.vercelDeploys.length}`, state: "BUILDING", url: "hook.vercel.app", meta: {}, createdAt: Date.now(), polls: 0 });
    res.status(201).json({ job: { id: "job1", state: "PENDING", createdAt: Date.now() } });
  });

  /* ---------------- Student backend ---------------- */
  app.get("/backend/health", (req, res) =>
    res.json({ success: true, status: "ok", database: "connected", commit: state.backendCommit })
  );
  app.get("/backend/api/students/search", (req, res) => {
    const q = String(req.query.q || "").toLowerCase();
    const data = state.students.filter(s => JSON.stringify(s).toLowerCase().includes(q));
    res.json({ success: true, count: data.length, data });
  });
  app.get("/backend/api/students", (req, res) => res.json({ success: true, count: state.students.length, data: state.students }));
  app.post("/backend/api/students", (req, res) => {
    const s = { _id: crypto.randomBytes(12).toString("hex"), ...req.body };
    state.students.push(s);
    res.status(201).json({ success: true, message: "Student added successfully.", data: s });
  });
  app.put("/backend/api/students/:id", (req, res) => {
    const s = state.students.find(x => x._id === req.params.id);
    if (!s) return res.status(404).json({ success: false, message: "Student not found." });
    Object.assign(s, req.body);
    res.json({ success: true, message: "Student updated successfully.", data: s });
  });
  app.delete("/backend/api/students/:id", (req, res) => {
    const i = state.students.findIndex(x => x._id === req.params.id);
    if (i < 0) return res.status(404).json({ success: false, message: "Student not found." });
    state.students.splice(i, 1);
    res.json({ success: true, message: "Student deleted successfully." });
  });

  // used to test that tokens are scrubbed from error messages
  app.get("/leaky", (req, res) => res.status(400).json({ message: "invalid token SECRET-TOKEN-123 rejected" }));

  return { app, state, tokens: { GH_TOKEN, RENDER_KEY, VERCEL_TOKEN } };
}

module.exports = { create };
