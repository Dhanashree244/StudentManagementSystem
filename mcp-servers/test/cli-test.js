const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
const path = require("node:path");
const ROOT = path.join(__dirname, "..");
const { create } = require("./mock-upstream.js");
const mock = create();

const runWith = (envVars, args) =>
  new Promise(resolve => {
    const p = spawn("node", [path.join(ROOT, "create-render-copy.js"), ...args], { env: envVars });
    let stdout = "", stderr = "";
    p.stdout.on("data", d => (stdout += d));
    p.stderr.on("data", d => (stderr += d));
    p.on("close", status => resolve({ status, stdout, stderr }));
  });

mock.app.listen(4200, "127.0.0.1", async function () {
  const server = this;
  const env = { PATH: process.env.PATH, RENDER_API_URL: "http://127.0.0.1:4200/render", RENDER_API_KEY: mock.tokens.RENDER_KEY, RENDER_SERVICE_ID: "srv-test" };
  const run = (...a) => runWith(env, a);
  let ok = 0;
  const t = async (name, fn) => {
    try { await fn(); ok++; console.log("  ok  ", name); }
    catch (e) { console.log("  FAIL", name, "\n      ", e.message); process.exitCode = 1; }
  };

  await t("preview: exit 0, creates nothing, hides secrets", async () => {
    const r = await run("--name", "student-backend-copy");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /PREVIEW ONLY/);
    assert.match(r.stdout, /MONGODB_URI/);
    assert.doesNotMatch(r.stdout + r.stderr, /pw-SECRET-VALUE/);
    assert.equal(mock.state.createdBodies.length, 0);
  });
  await t("no --name -> clear error, exit 1", async () => {
    const r = await run(); assert.equal(r.status, 1); assert.match(r.stderr, /--name/);
  });
  await t("bad name rejected", async () => assert.equal((await run("--name", "Bad_Name")).status, 1));
  await t("same name as original rejected", async () => assert.equal((await run("--name", "student-management-backend")).status, 1));
  await t("paid plan refused with --create", async () => {
    mock.state.sourcePlan = "starter";
    const r = await run("--name", "student-backend-copy", "--create");
    mock.state.sourcePlan = "free";
    assert.equal(r.status, 1); assert.match(r.stderr, /not free/); assert.equal(mock.state.createdBodies.length, 0);
  });
  await t("--create makes the copy with --set override; secret not printed", async () => {
    const r = await run("--name", "student-backend-copy", "--create", "--set", "CORS_ORIGIN=https://copy.vercel.app");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /CREATED/); assert.match(r.stdout, /srv-copy1/);
    assert.doesNotMatch(r.stdout + r.stderr, /pw-SECRET-VALUE/);
    const b = mock.state.createdBodies[0];
    assert.equal(b.rootDir, "backend"); assert.equal(b.serviceDetails.plan, "free");
    const envs = Object.fromEntries(b.envVars.map(e => [e.key, e.value]));
    assert.equal(envs.MONGODB_URI, "mongodb+srv://user:pw-SECRET-VALUE@cluster/db");
    assert.equal(envs.CORS_ORIGIN, "https://copy.vercel.app");
  });
  await t("second --create with same name refused (no duplicate)", async () => {
    const r = await run("--name", "student-backend-copy", "--create");
    assert.equal(r.status, 1); assert.match(r.stderr, /already exists/); assert.equal(mock.state.createdBodies.length, 1);
  });
  await t("--no-env copies no env vars", async () => {
    const r = await run("--name", "copy-two", "--create", "--no-env");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(mock.state.createdBodies[1].envVars, undefined);
  });
  await t("wrong API key -> readable error, key not leaked", async () => {
    const r = await runWith({ ...env, RENDER_API_KEY: "wrong-key-123" }, ["--name", "x-copy"]);
    assert.equal(r.status, 1); assert.match(r.stderr, /HTTP 401/); assert.doesNotMatch(r.stderr, /wrong-key-123/);
  });
  await t("--docker creates a Docker copy; Node original is not changed", async () => {
    const r = await run("--name", "student-container", "--create", "--docker");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Docker container/);
    assert.match(r.stdout, /Dockerfile - it must already be committed/);
    const b = mock.state.createdBodies[mock.state.createdBodies.length - 1];
    assert.equal(b.serviceDetails.runtime, "docker");
    assert.deepEqual(b.serviceDetails.envSpecificDetails, { dockerfilePath: "./Dockerfile", dockerContext: "." });
  });
  await t("a Docker original is copied as Docker", async () => {
    mock.state.sourceRuntime = "docker";
    const r = await run("--name", "student-docker-copy", "--create");
    mock.state.sourceRuntime = "node";
    assert.equal(r.status, 0, r.stderr);
    const b = mock.state.createdBodies[mock.state.createdBodies.length - 1];
    assert.equal(b.serviceDetails.envSpecificDetails.dockerCommand, "node server.js");
  });
  console.log(`${ok} cli checks passed`);
  server.close();
});
