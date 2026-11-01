#!/usr/bin/env node
"use strict";

/**
 * Copy the Render backend service from the terminal (no Claude needed).
 *
 *   node create-render-copy.js --name student-backend-copy            (preview only)
 *   node create-render-copy.js --name student-backend-copy --create   (really create it)
 *
 * Options:
 *   --create            actually create the service (default is a preview)
 *   --allow-paid        allow a plan that is not "free" (may be billed)
 *   --docker            build the copy as a Docker container (needs backend/Dockerfile on the branch)
 *   --no-env            do not copy environment variables
 *   --set KEY=VALUE     set/override an env var on the copy (repeatable)
 *
 * Reads RENDER_API_KEY and RENDER_SERVICE_ID (the ORIGINAL service) from mcp-servers/.env.
 * Secret values are copied directly to Render and are never printed.
 */

const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, ".env"), quiet: true });

const API = (process.env.RENDER_API_URL || "https://api.render.com/v1").replace(/\/$/, "");

function parseArgs(argv) {
  const out = { create: false, allowPaid: false, copyEnv: true, docker: false, set: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--name") out.name = argv[++i];
    else if (a === "--create") out.create = true;
    else if (a === "--allow-paid") out.allowPaid = true;
    else if (a === "--no-env") out.copyEnv = false;
    else if (a === "--docker") out.docker = true;
    else if (a === "--set") {
      const pair = argv[++i] || "";
      const eq = pair.indexOf("=");
      if (eq < 1) fail(`--set needs KEY=VALUE, got "${pair}"`);
      out.set[pair.slice(0, eq)] = pair.slice(eq + 1);
    } else fail(`Unknown option: ${a}`);
  }
  return out;
}

function fail(message) {
  console.error(`\nERROR: ${message}`);
  process.exit(1);
}

const key = process.env.RENDER_API_KEY;
const sourceId = process.env.RENDER_SERVICE_ID;

async function render(pathname, { method = "GET", body, query } = {}) {
  const qs = query ? `?${new URLSearchParams(query)}` : "";
  let res;
  try {
    res = await fetch(`${API}${pathname}${qs}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000)
    });
  } catch (error) {
    fail(`${method} ${pathname} failed: ${error.message}`);
  }
  const raw = await res.text();
  let data = raw;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    /* keep text */
  }
  if (!res.ok) {
    const detail = typeof data === "string" ? data : (data && data.message) || JSON.stringify(data);
    fail(`${method} ${pathname} -> HTTP ${res.status}: ${String(detail).replace(key, "***").slice(0, 400)}`);
  }
  return data;
}

const unwrap = (item, k) => (item && item[k]) || item;

(async () => {
  const args = parseArgs(process.argv.slice(2));

  if (!key || !sourceId) fail("Set RENDER_API_KEY and RENDER_SERVICE_ID in mcp-servers/.env");
  if (!args.name || !/^[a-z0-9][a-z0-9-]{2,62}$/.test(args.name)) {
    fail('Give a new name with --name (3-63 chars: lowercase letters, digits, dashes), e.g. --name student-backend-copy');
  }
  for (const k of Object.keys(args.set)) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(k)) fail(`Env var name "${k}" must be UPPER_SNAKE_CASE`);
  }

  console.log("Reading the original service...");
  const src = await render(`/services/${encodeURIComponent(sourceId)}`);
  const sd = src.serviceDetails || {};

  if (src.type !== "web_service") fail(`The original is a ${src.type}; only web_service is supported.`);
  if (args.name === src.name) fail("The new name must differ from the original name.");
  for (const [field, value] of [["ownerId", src.ownerId], ["repo", src.repo], ["runtime", sd.runtime]]) {
    if (!value) fail(`Could not read "${field}" from the original. Create the copy in the Render dashboard instead.`);
  }

  if (sd.runtime === "image") fail("The original runs a prebuilt image; copying that is not supported. Use the Render dashboard.");

  const existing = (await render("/services", { query: { name: args.name, limit: "20" } })) || [];
  if (existing.some(i => unwrap(i, "service").name === args.name)) {
    fail(`A service named "${args.name}" already exists. Choose another name.`);
  }

  const plan = typeof sd.plan === "string" ? sd.plan : null;
  const isFree = plan === "free";

  const envVars = [];
  const noValue = [];
  if (args.copyEnv) {
    for (const item of (await render(`/services/${encodeURIComponent(sourceId)}/env-vars`)) || []) {
      const v = unwrap(item, "envVar");
      if (!v || !v.key) continue;
      if (typeof v.value === "string" && v.value !== "") envVars.push({ key: v.key, value: v.value });
      else noValue.push(v.key);
    }
  }
  for (const [k, value] of Object.entries(args.set)) {
    const i = envVars.findIndex(e => e.key === k);
    if (i >= 0) envVars[i] = { key: k, value };
    else envVars.push({ key: k, value });
  }

  const env = sd.envSpecificDetails || {};
  const pick = (obj, keys) => Object.fromEntries(keys.filter(k => obj[k]).map(k => [k, obj[k]]));
  // dockerfilePath / dockerContext are relative to the service's root directory
  const runtime = args.docker ? "docker" : sd.runtime;
  const specific =
    runtime === "docker"
      ? sd.runtime === "docker"
        ? pick(env, ["dockerfilePath", "dockerContext", "dockerCommand"])
        : { dockerfilePath: "./Dockerfile", dockerContext: "." }
      : pick(env, ["buildCommand", "startCommand"]);
  const body = {
    type: "web_service",
    name: args.name,
    ownerId: src.ownerId,
    repo: src.repo,
    branch: src.branch || "main",
    autoDeploy: src.autoDeploy || "yes",
    ...(src.rootDir ? { rootDir: src.rootDir } : {}),
    ...(src.buildFilter && Array.isArray(src.buildFilter.paths) && src.buildFilter.paths.length
      ? { buildFilter: { paths: src.buildFilter.paths, ignoredPaths: src.buildFilter.ignoredPaths || [] } }
      : {}),
    ...(envVars.length ? { envVars } : {}),
    serviceDetails: {
      runtime,
      ...(plan ? { plan } : {}),
      ...(sd.region ? { region: sd.region } : {}),
      ...(Object.keys(specific).length ? { envSpecificDetails: specific } : {}),
      ...(sd.healthCheckPath ? { healthCheckPath: sd.healthCheckPath } : {})
    }
  };

  console.log(`
Original : ${src.name} (${src.id})
New copy : ${args.name}
  repo         ${body.repo}
  branch       ${body.branch}
  root dir     ${body.rootDir || "(repo root)"}
  runtime      ${runtime}${runtime === "docker" ? "  (Docker container)" : ""}
  region       ${sd.region || "(default)"}
  plan         ${plan || "unknown"}${runtime === "docker" ? `
  dockerfile   ${specific.dockerfilePath || "-"}
  docker ctx   ${specific.dockerContext || "-"}
  docker cmd   ${specific.dockerCommand || "(CMD from the Dockerfile)"}` : `
  build        ${specific.buildCommand || "-"}
  start        ${specific.startCommand || "-"}`}
  health check ${sd.healthCheckPath || "-"}
  env vars     ${envVars.map(e => e.key).sort().join(", ") || "(none)"}${noValue.length ? `\n  (no readable value, not copied: ${noValue.join(", ")})` : ""}
`);
  if (args.docker && sd.runtime !== "docker") {
    console.log(`NOTE: Render will build ${body.rootDir ? body.rootDir + "/" : ""}Dockerfile - it must already be committed on branch "${body.branch}", or the first deploy fails.`);
  }
  if (!isFree) console.log(`WARNING: plan is "${plan || "unknown"}", not free - the copy may be BILLED.`);
  if (args.copyEnv) console.log("NOTE: the copy shares the same database (same MONGODB_URI) unless you used --set MONGODB_URI=...");

  if (!args.create) {
    console.log(`\nPREVIEW ONLY - nothing was created.\nTo create it, run the same command again with --create`);
    return;
  }
  if (!isFree && !args.allowPaid) {
    fail(`Refusing to create: the plan is "${plan || "unknown"}" (not free). Add --allow-paid only if you accept possible charges.`);
  }

  console.log("Creating the service on Render...");
  const result = await render("/services", { method: "POST", body });
  const svc = unwrap(result, "service");

  console.log(`
CREATED
  service id : ${svc.id}
  name       : ${svc.name}
  url        : ${(svc.serviceDetails && svc.serviceDetails.url) || "(shown in the Render dashboard)"}
  first deploy id: ${(result && result.deployId) || "-"}

Next: wait for the deploy to be live in the Render dashboard, then open <url>/health
It should show "status":"ok".`);
})();
