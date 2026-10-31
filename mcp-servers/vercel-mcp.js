"use strict";

/**
 * vercel-mcp  -  the "frontend hosting" platform.
 * Pushes to GitHub already auto-deploy; this server lets Claude watch the
 * build, force a redeploy (deploy hook) and confirm the frontend is READY.
 */

const { z } = require("zod");
const { run } = require("./lib/runner");
const { text, need, tool, http, sleep, POLL_MS } = require("./lib/util");

const API = (process.env.VERCEL_API_URL || "https://api.vercel.com").replace(/\/$/, "");
const IN_PROGRESS = new Set(["QUEUED", "INITIALIZING", "BUILDING"]);
const FAILED = new Set(["ERROR", "CANCELED"]);

async function vercel(path, query = {}) {
  const token = need("VERCEL_TOKEN");
  const params = new URLSearchParams(query);
  if (process.env.VERCEL_TEAM_ID) params.set("teamId", process.env.VERCEL_TEAM_ID.trim());
  const qs = params.toString();
  return http(`${API}${path}${qs ? `?${qs}` : ""}`, {
    secrets: [token],
    headers: { Authorization: `Bearer ${token}` }
  });
}

const stateOf = d => String(d.readyState || d.state || d.status || "UNKNOWN").toUpperCase();

const brief = d => ({
  id: d.uid || d.id,
  state: stateOf(d),
  url: d.url ? `https://${String(d.url).replace(/^https?:\/\//, "")}` : null,
  target: d.target || "preview",
  commit: (d.meta && d.meta.githubCommitSha) || null,
  commit_message: (d.meta && d.meta.githubCommitMessage) || null,
  created: d.createdAt || d.created || null
});

async function latestDeployment() {
  const data = await vercel("/v6/deployments", {
    projectId: need("VERCEL_PROJECT_ID"),
    limit: "1"
  });
  if (!data.deployments || !data.deployments.length) throw new Error("No deployments found for this project.");
  return data.deployments[0];
}

function register(server) {
  server.registerTool(
    "vercel_list_deployments",
    {
      description: "List the latest Vercel deployments of the frontend project (state, url, commit).",
      inputSchema: { limit: z.number().int().min(1).max(20).default(5) }
    },
    tool(async ({ limit }) => {
      const data = await vercel("/v6/deployments", {
        projectId: need("VERCEL_PROJECT_ID"),
        limit: String(limit)
      });
      return text((data.deployments || []).map(brief));
    })
  );

  server.registerTool(
    "vercel_get_deployment",
    {
      description: "Get the status of one Vercel deployment by id (or the latest one if id is omitted).",
      inputSchema: { deployment_id: z.string().optional() }
    },
    tool(async ({ deployment_id }) => {
      const d = deployment_id ? await vercel(`/v13/deployments/${encodeURIComponent(deployment_id)}`) : await latestDeployment();
      return text(brief(d));
    })
  );

  server.registerTool(
    "vercel_redeploy",
    {
      description:
        "Trigger a new production deployment of the frontend through the project's Deploy Hook " +
        "(normally NOT needed after a GitHub push - Vercel deploys automatically).",
      inputSchema: {}
    },
    tool(async () => {
      const hook = need("VERCEL_DEPLOY_HOOK_URL");
      const result = await http(hook, { method: "POST", secrets: [hook] });
      return text({ triggered: true, job: (result && result.job) || result });
    })
  );

  server.registerTool(
    "vercel_wait_for_deployment",
    {
      description:
        "Wait (up to timeout_seconds) until a Vercel deployment is READY or failed. " +
        "If expected_commit is given, waits for the deployment of that commit (the one just pushed). " +
        "If it is still building when the time is up, call this tool again.",
      inputSchema: {
        deployment_id: z.string().optional(),
        expected_commit: z.string().optional(),
        timeout_seconds: z.number().int().min(5).max(120).default(45)
      }
    },
    tool(async ({ deployment_id, expected_commit, timeout_seconds }) => {
      const deadline = Date.now() + timeout_seconds * 1000;
      let last = null;

      for (;;) {
        let d;
        if (deployment_id) {
          d = await vercel(`/v13/deployments/${encodeURIComponent(deployment_id)}`);
        } else {
          const data = await vercel("/v6/deployments", {
            projectId: need("VERCEL_PROJECT_ID"),
            limit: "10"
          });
          const list = data.deployments || [];
          d = expected_commit
            ? list.find(x => {
                const sha = x.meta && x.meta.githubCommitSha;
                return sha && (sha.startsWith(expected_commit) || expected_commit.startsWith(sha));
              })
            : list[0];
        }

        if (d) {
          last = brief(d);
          if (!IN_PROGRESS.has(last.state)) {
            return text({ finished: true, success: !FAILED.has(last.state), deployment: last });
          }
        }
        if (Date.now() + POLL_MS > deadline) break;
        await sleep(POLL_MS);
      }

      return text({
        finished: false,
        message: last
          ? "Still building - call vercel_wait_for_deployment again."
          : "Deployment for that commit not visible yet - call again in a few seconds.",
        deployment: last
      });
    })
  );
}

run({
  name: "student-vercel",
  description: "Vercel deployment status / redeploy for the Student Management frontend",
  register
});
