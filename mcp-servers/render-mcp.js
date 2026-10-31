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

const sid = () => encodeURIComponent(need("RENDER_SERVICE_ID"));

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
      inputSchema: {}
    },
    tool(async () => {
      const s = await render(`/services/${sid()}`);
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
      inputSchema: { limit: z.number().int().min(1).max(20).default(5) }
    },
    tool(async ({ limit }) => {
      const list = await render(`/services/${sid()}/deploys`, { query: { limit: String(limit) } });
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
        deploy_id: z.string().optional(),
        expected_commit: z.string().optional(),
        timeout_seconds: z.number().int().min(5).max(120).default(45)
      }
    },
    tool(async ({ deploy_id, expected_commit, timeout_seconds }) => {
      const deadline = Date.now() + timeout_seconds * 1000;
      let last = null;

      for (;;) {
        let d;
        if (deploy_id) {
          d = unwrap(await render(`/services/${sid()}/deploys/${encodeURIComponent(deploy_id)}`), "deploy");
        } else {
          const list = (await render(`/services/${sid()}/deploys`, { query: { limit: "10" } })) || [];
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
}

run({
  name: "student-render",
  description: "Render deploys + env vars for the Student Management backend",
  register
});
