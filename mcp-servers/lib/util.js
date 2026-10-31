"use strict";

/** MCP tool result helpers + small HTTP client shared by all servers. */

const text = value => ({
  content: [
    {
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
    }
  ]
});

function need(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing configuration: set ${name} in mcp-servers/.env`);
  }
  return value.trim();
}

/** Wrap a tool handler so failures come back as readable tool errors. */
const tool = handler => async args => {
  try {
    return await handler(args || {});
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error: ${error.message}` }]
    };
  }
};

/**
 * fetch + JSON + timeout. `secrets` are scrubbed from any error message so
 * tokens never leak back into the chat.
 */
async function http(url, { method = "GET", headers = {}, body, timeoutMs = 20000, secrets = [] } = {}) {
  const scrub = message =>
    secrets.filter(Boolean).reduce((m, s) => m.split(s).join("***"), String(message));

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    throw new Error(scrub(`${method} ${new URL(url).pathname} failed: ${error.message}`));
  }

  const raw = await response.text();
  let data = raw;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    /* keep raw text */
  }

  if (!response.ok) {
    const detail = typeof data === "string" ? data : data && (data.message || JSON.stringify(data));
    throw new Error(
      scrub(`${method} ${new URL(url).pathname} -> HTTP ${response.status}: ${String(detail).slice(0, 400)}`)
    );
  }
  return data;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Poll interval is overridable so tests do not have to wait 5s per poll. */
const POLL_MS = Number(process.env.MCP_POLL_INTERVAL_MS || 5000);

module.exports = { text, need, tool, http, sleep, POLL_MS };
