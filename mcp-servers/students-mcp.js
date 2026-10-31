"use strict";

/**
 * students-mcp  -  the "data" platform (MongoDB Atlas, via the live backend).
 * Lets one prompt change the DATA too, and verify that a fresh deploy is live.
 */

const { z } = require("zod");
const { run } = require("./lib/runner");
const { text, need, tool, http } = require("./lib/util");

// Render's free plan sleeps; the first request after idle can take ~1 minute.
const TIMEOUT_MS = 75000;
const base = () => need("BACKEND_URL").replace(/\/$/, "");
const api = (path, opts = {}) => http(`${base()}${path}`, { timeoutMs: TIMEOUT_MS, ...opts });

const fields = {
  studentId: z.string().min(1).max(30),
  name: z.string().min(1).max(100),
  email: z.string().email(),
  department: z.string().min(1).max(100),
  semester: z.number().int().min(1).max(12),
  contact: z.string().regex(/^[0-9]{10}$/, "10-digit number")
};

const slim = s => ({
  record_id: s._id,
  studentId: s.studentId,
  name: s.name,
  email: s.email,
  department: s.department,
  semester: s.semester,
  contact: s.contact
});

function register(server) {
  server.registerTool(
    "students_health",
    {
      description:
        "Check the live backend: reachable? database connected? which git commit is deployed? (wakes a sleeping Render service)",
      inputSchema: {}
    },
    tool(async () => text(await api("/health")))
  );

  server.registerTool(
    "students_verify_backend_commit",
    {
      description:
        "Confirm the backend running on Render is serving the given commit (use the sha returned by github_commit_changes).",
      inputSchema: { expected_commit: z.string().min(7) }
    },
    tool(async ({ expected_commit }) => {
      const health = await api("/health");
      const live = health.commit || "";
      const match = Boolean(live) && (live.startsWith(expected_commit) || expected_commit.startsWith(live));
      return text({
        match,
        deployed_commit: live || null,
        expected_commit,
        database: health.database,
        hint: match ? "Backend is running the new code." : "Not live yet (or an older deploy is still serving) - wait and retry."
      });
    })
  );

  server.registerTool(
    "students_list",
    { description: "List all students stored in MongoDB.", inputSchema: {} },
    tool(async () => {
      const r = await api("/api/students");
      return text({ count: r.count, students: (r.data || []).map(slim) });
    })
  );

  server.registerTool(
    "students_search",
    {
      description: "Search students by ID, name, email or department.",
      inputSchema: { query: z.string().min(1).max(100) }
    },
    tool(async ({ query }) => {
      const r = await api(`/api/students/search?q=${encodeURIComponent(query)}`);
      return text({ count: r.count, students: (r.data || []).map(slim) });
    })
  );

  server.registerTool(
    "students_add",
    { description: "Add a new student record.", inputSchema: fields },
    tool(async args => {
      const r = await api("/api/students", { method: "POST", body: args });
      return text({ message: r.message, student: slim(r.data) });
    })
  );

  server.registerTool(
    "students_update",
    {
      description: "Update fields of a student (use record_id from students_list/search).",
      inputSchema: {
        record_id: z.string().min(12),
        studentId: fields.studentId.optional(),
        name: fields.name.optional(),
        email: fields.email.optional(),
        department: fields.department.optional(),
        semester: fields.semester.optional(),
        contact: fields.contact.optional()
      }
    },
    tool(async ({ record_id, ...updates }) => {
      if (!Object.keys(updates).length) throw new Error("Provide at least one field to update.");
      const r = await api(`/api/students/${encodeURIComponent(record_id)}`, {
        method: "PUT",
        body: updates
      });
      return text({ message: r.message, student: slim(r.data) });
    })
  );

  server.registerTool(
    "students_delete",
    {
      description: "Delete a student record permanently. Requires confirm=true.",
      inputSchema: { record_id: z.string().min(12), confirm: z.boolean() }
    },
    tool(async ({ record_id, confirm }) => {
      if (confirm !== true) throw new Error("Refusing to delete: pass confirm=true after the user agreed.");
      const r = await api(`/api/students/${encodeURIComponent(record_id)}`, { method: "DELETE" });
      return text({ message: r.message });
    })
  );
}

run({
  name: "student-data",
  description: "Student records (MongoDB via the Render backend) + deploy verification",
  register
});
