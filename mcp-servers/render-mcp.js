"use strict";

/**
 * render-mcp  -  the "backend hosting" platform.
 * Watch/trigger Render deploys and manage backend environment variables.
 */

const { z } = require("zod");
const { run } = require("./lib/runner");
const { text, need, tool, http, sleep, POLL_MS } = require("./lib/util");

const API = (process.env.RENDER_API_URL || "https://api.render.com/v1").replace(/\/$/, "");
const IN_PROGRESS = new Set(["created", "build_in_progress", "update_in_progress", "pre_deploy_in_progress"]);

async function render(path, { method = "GET", body, query } = {}) {
  const key = need("RENDER_API_KEY");
  const qs = query ? `?${new URLSearchParams(query)}` : "";
  return http(`${API}${path}${qs}`, {
    method,
    body,
    secrets: [key],
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }
  });
}

const sid = override => encodeURIComponent(override || need("RENDER_SERVICE_ID"));
const ENV_KEY = /^[A-Z][A-Z0-9_]{0,63}$/;
// Optional: lets one server manage the original AND a copy (e.g. a service just created)
const serviceIdArg = z.string().regex(/^srv-[a-z0-9]+$/, "looks like srv-abc123").optional();

// Render list endpoints wrap items as { deploy: {...}, cursor }
const unwrap = (item, key) => (item && item[key]) || item;

const brief = d => ({
  id: d.id,
  status: d.status,
  trigger: d.trigger || null,
  commit: (d.commit && d.commit.id) || null,
  commit_message: (d.commit && d.commit.message && String(d.commit.message).split("\n")[0]) || null,
  created: d.createdAt || null,
  finished: d.finishedAt || null
});

async function latestDeploy() {
  const list = await render(`/services/${sid()}/deploys`, { query: { limit: "1" } });
  if (!list || !list.length) throw new Error("No deploys found for this service.");
  return unwrap(list[0], "deploy");
}

function register(server) {
  server.registerTool(
    "render_service_status",
    {
      description: "Show the Render backend service: name, URL, branch, auto-deploy, suspended or not.",
      inputSchema: { service_id: serviceIdArg }
    },
    tool(async ({ service_id }) => {
      const s = await render(`/services/${sid(service_id)}`);
      return text({
        id: s.id,
        name: s.name,
        type: s.type,
        url: (s.serviceDetails && s.serviceDetails.url) || null,
        branch: s.branch || null,
        auto_deploy: s.autoDeploy || null,
        suspended: s.suspended || null,
        updated: s.updatedAt || null
      });
    })
  );

  server.registerTool(
    "render_list_deploys",
    {
      description: "List the latest Render deploys (status, commit).",
      inputSchema: { limit: z.number().int().min(1).max(20).default(5), service_id: serviceIdArg }
    },
    tool(async ({ limit, service_id }) => {
      const list = await render(`/services/${sid(service_id)}/deploys`, { query: { limit: String(limit) } });
      return text((list || []).map(i => brief(unwrap(i, "deploy"))));
    })
  );

  server.registerTool(
    "render_trigger_deploy",
    {
      description:
        "Start a new Render deploy of the backend (needed after changing env vars; a GitHub push already triggers one automatically).",
      inputSchema: { clear_cache: z.boolean().default(false) }
    },
    tool(async ({ clear_cache }) => {
      const d = await render(`/services/${sid()}/deploys`, {
        method: "POST",
        body: { clearCache: clear_cache ? "clear" : "do_not_clear" }
      });
      return text({ triggered: true, deploy: brief(unwrap(d, "deploy")) });
    })
  );

  server.registerTool(
    "render_wait_for_deploy",
    {
      description:
        "Wait (up to timeout_seconds) until a Render deploy is live or failed. " +
        "If expected_commit is given, waits for the deploy of that commit (the one just pushed). " +
        "If it is still building when time is up, call this tool again.",
      inputSchema: {
        service_id: serviceIdArg,
        deploy_id: z.string().optional(),
        expected_commit: z.string().optional(),
        timeout_seconds: z.number().int().min(5).max(120).default(45)
      }
    },
    tool(async ({ service_id, deploy_id, expected_commit, timeout_seconds }) => {
      const deadline = Date.now() + timeout_seconds * 1000;
      let last = null;

      for (;;) {
        let d;
        if (deploy_id) {
          d = unwrap(await render(`/services/${sid(service_id)}/deploys/${encodeURIComponent(deploy_id)}`), "deploy");
        } else {
          const list = (await render(`/services/${sid(service_id)}/deploys`, { query: { limit: "10" } })) || [];
          const items = list.map(i => unwrap(i, "deploy"));
          d = expected_commit
            ? items.find(x => {
                const sha = x.commit && x.commit.id;
                return sha && (sha.startsWith(expected_commit) || expected_commit.startsWith(sha));
              })
            : items[0];
        }

        if (d) {
          last = brief(d);
          if (!IN_PROGRESS.has(last.status)) {
            return text({ finished: true, success: last.status === "live", deploy: last });
          }
        }
        if (Date.now() + POLL_MS > deadline) break;
        await sleep(POLL_MS);
      }

      return text({
        finished: false,
        message: last
          ? "Still deploying - call render_wait_for_deploy again."
          : "Deploy for that commit not visible yet - call again in a few seconds.",
        deploy: last
      });
    })
  );

  server.registerTool(
    "render_list_env_keys",
    {
      description: "List the NAMES of the backend's environment variables (values are never shown).",
      inputSchema: {}
    },
    tool(async () => {
      const list = (await render(`/services/${sid()}/env-vars`)) || [];
      return text(list.map(i => unwrap(i, "envVar").key).sort());
    })
  );

  server.registerTool(
    "render_set_env",
    {
      description:
        "Create or update ONE backend environment variable (e.g. CORS_ORIGIN). The value is never echoed back. " +
        "Set redeploy=true to start a deploy so the change takes effect.",
      inputSchema: {
        key: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, "UPPER_SNAKE_CASE only"),
        value: z.string().max(4000),
        redeploy: z.boolean().default(false)
      }
    },
    tool(async ({ key, value, redeploy }) => {
      await render(`/services/${sid()}/env-vars/${encodeURIComponent(key)}`, {
        method: "PUT",
        body: { value }
      });
      const out = { updated: key };
      if (redeploy) {
        const d = await render(`/services/${sid()}/deploys`, {
          method: "POST",
          body: { clearCache: "do_not_clear" }
        });
        out.deploy = brief(unwrap(d, "deploy"));
      } else {
        out.note = "Not live yet - run render_trigger_deploy (or set redeploy=true).";
      }
      return text(out);
    })
  );

  server.registerTool(
    "render_create_service",
    {
      description:
        "Create a COPY of the backend web service on Render (as_docker=true builds it as a Docker container from Dockerfile): same repo, branch, root dir, runtime, build/start commands, " +
        "region, plan, health check and (optionally) environment variables - read from the original service. " +
        "SAFE BY DEFAULT: dry_run=true only previews what would be created. To really create it, call again with " +
        "dry_run=false and confirm_name equal to new_name. Paid plans are refused unless allow_paid=true. " +
        "Env var values are copied server-side and never shown.",
      inputSchema: {
        new_name: z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/, "3-63 chars: lowercase letters, digits, dashes"),
        copy_env_vars: z.boolean().default(true),
        env_overrides: z.record(z.string().regex(ENV_KEY, "UPPER_SNAKE_CASE only"), z.string().max(4000)).default({}),
        dry_run: z.boolean().default(true),
        confirm_name: z.string().optional(),
        allow_paid: z.boolean().default(false),
        as_docker: z.boolean().default(false)
      }
    },
    tool(async ({ new_name, copy_env_vars, env_overrides, dry_run, confirm_name, allow_paid, as_docker }) => {
      const src = await render(`/services/${sid()}`);
      const sd = src.serviceDetails || {};

      if (src.type !== "web_service") {
        throw new Error(`The source service is a ${src.type}; only web_service copies are supported.`);
      }
      if (new_name === src.name) throw new Error("new_name must differ from the original service name.");
      for (const [field, value] of [["ownerId", src.ownerId], ["repo", src.repo], ["runtime", sd.runtime]]) {
        if (!value) {
          throw new Error(`Could not read "${field}" from the original service. Create the copy in the Render dashboard instead.`);
        }
      }

      if (sd.runtime === "image") {
        throw new Error("The original runs a prebuilt image (runtime image); copying that is not supported here. Use the Render dashboard.");
      }

      // never create the same service twice (e.g. when a call is retried)
      const found = (await render("/services", { query: { name: new_name, limit: "20" } })) || [];
      if (found.some(i => unwrap(i, "service").name === new_name)) {
        throw new Error(`A service named "${new_name}" already exists. Pick another name.`);
      }

      const plan = typeof sd.plan === "string" ? sd.plan : null;
      const isFree = plan === "free";

      // environment variables: copy values server-side, then apply overrides
      const envVars = [];
      const noValue = [];
      if (copy_env_vars) {
        for (const item of (await render(`/services/${sid()}/env-vars`)) || []) {
          const v = unwrap(item, "envVar");
          if (!v || !v.key) continue;
          if (typeof v.value === "string" && v.value !== "") envVars.push({ key: v.key, value: v.value });
          else noValue.push(v.key);
        }
      }
      for (const [key, value] of Object.entries(env_overrides)) {
        const i = envVars.findIndex(e => e.key === key);
        if (i >= 0) envVars[i] = { key, value };
        else envVars.push({ key, value });
      }

      const envDetails = sd.envSpecificDetails || {};
      const pick = (obj, keys) => Object.fromEntries(keys.filter(k => obj[k]).map(k => [k, obj[k]]));
      // Docker copy: copy the original's Docker settings, or (as_docker) build from backend/Dockerfile.
      // dockerfilePath/dockerContext are relative to the service's root directory.
      const runtime = as_docker ? "docker" : sd.runtime;
      const specific =
        runtime === "docker"
          ? sd.runtime === "docker"
            ? pick(envDetails, ["dockerfilePath", "dockerContext", "dockerCommand"])
            : { dockerfilePath: "./Dockerfile", dockerContext: "." }
          : pick(envDetails, ["buildCommand", "startCommand"]);
      const body = {
        type: "web_service",
        name: new_name,
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

      const warnings = [];
      if (!isFree) {
        warnings.push(
          `Plan is "${plan || "unknown"}", not "free": the copy may be BILLED. It is refused unless allow_paid=true.`
        );
      }
      if (copy_env_vars) {
        warnings.push("The copy shares the same database (same MONGODB_URI) unless you override it.");
      }
      warnings.push(`The copy auto-deploys from branch "${body.branch}", like the original.`);
      if (as_docker && sd.runtime !== "docker") {
        warnings.push(
          `The copy is built as a DOCKER container from ${body.rootDir ? body.rootDir + "/" : ""}Dockerfile - that file must already be committed on branch "${body.branch}", or the first deploy fails.`
        );
      }

      const preview = {
        original: { id: src.id, name: src.name },
        new_service: {
          name: new_name,
          repo: body.repo,
          branch: body.branch,
          root_dir: body.rootDir || null,
          runtime: body.serviceDetails.runtime,
          region: body.serviceDetails.region || null,
          plan: plan || "unknown",
          build_command: specific.buildCommand || null,
          start_command: specific.startCommand || null,
          dockerfile_path: specific.dockerfilePath || null,
          docker_context: specific.dockerContext || null,
          docker_command: specific.dockerCommand || null,
          health_check_path: body.serviceDetails.healthCheckPath || null,
          auto_deploy: body.autoDeploy
        },
        env_vars_copied: envVars.map(e => e.key).sort(),
        env_vars_without_readable_value: noValue.sort(),
        env_overridden: Object.keys(env_overrides).sort(),
        warnings
      };

      if (dry_run) {
        return text({
          created: false,
          dry_run: true,
          ...preview,
          next: `Nothing was created. To create it, call again with dry_run=false and confirm_name="${new_name}".`
        });
      }
      if (confirm_name !== new_name) {
        throw new Error(`Refusing to create: confirm_name must exactly equal new_name ("${new_name}").`);
      }
      if (!isFree && !allow_paid) {
        throw new Error(`Refusing to create: the plan is "${plan || "unknown"}" (not free). Pass allow_paid=true only if you accept possible charges.`);
      }

      const result = await render("/services", { method: "POST", body });
      const svc = unwrap(result, "service");
      return text({
        created: true,
        service: {
          id: svc.id,
          name: svc.name,
          url: (svc.serviceDetails && svc.serviceDetails.url) || null,
          dashboard: svc.dashboardUrl || null
        },
        deploy_id: (result && result.deployId) || null,
        ...preview,
        next:
          "The first deploy has started. Watch it with render_wait_for_deploy (service_id=<this id>, deploy_id=<deploy_id>). " +
          "To point the frontend at the copy, change only frontend/config.js. " +
          "To manage it from Claude permanently, add its id as RENDER_SERVICE_ID in a second server entry."
      });
    })
  );
}

run({
  name: "student-render",
  description: "Render deploys + env vars for the Student Management backend",
  register
});
