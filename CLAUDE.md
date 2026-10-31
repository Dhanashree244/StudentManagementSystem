# Student Management System - how Claude must work here

You are ONE agent that controls four MCP servers. A single user prompt may need
all of them. Do the whole job; don't stop after the first platform.

| Platform | What it hosts | MCP server (tools) |
|---|---|---|
| GitHub | the code (source of truth) | `student-github`: github_* |
| Vercel | frontend (`frontend/`) | `student-vercel`: vercel_* |
| Render | backend API (`backend/`) | `student-render`: render_* |
| MongoDB Atlas | student records | `student-data`: students_* (via the backend API) |

NEVER use Netlify. Hosting is Vercel (frontend) + Render (backend) only.

## Playbook for any change request

1. **Understand** - `github_list_files`, then `github_read_file` for every file you will touch.
   Change the frontend AND the backend together when the feature needs both
   (e.g. a new field: Mongoose schema + validation in `backend/server.js`,
   form + table + payload in `frontend/index.html` / `script.js`).
2. **Preview** - `github_commit_changes` with `dry_run: true` when the change is large.
3. **Commit ONCE** - one `github_commit_changes` call containing every changed file
   (full file contents, not diffs). Clear commit message. Vercel and Render
   auto-deploy from that push.
4. **Wait for both deploys** - `vercel_wait_for_deployment` and `render_wait_for_deploy`
   with `expected_commit` = the sha returned in step 3. If `finished:false`, call again.
   If a deploy failed, say so and fix it; don't claim success.
5. **Verify** - `students_verify_backend_commit` (backend serves the new commit),
   then exercise the feature with `students_*` if the change affects data.
6. **Report** - what changed per platform, the commit sha, deploy states, and anything
   you could not verify.

## Other platform tasks
- Backend env var (e.g. `CORS_ORIGIN`): `render_set_env` with `redeploy: true`, then wait.
- Frontend points to a different backend: edit only `frontend/config.js`.
- Data changes ("add/update/delete student"): `students_*` tools.
  Ask before `students_delete`; it needs `confirm: true`.

## Rules
- Secrets (`.env`, tokens, MongoDB URI) are never read, written, printed or committed.
  Env vars go through `render_set_env` only, and values are never echoed.
- Only `frontend/`, `backend/`, `README.md`, `render.yaml` are writable. Don't try to
  edit `mcp-servers/` through prompts.
- Keep the existing API contract (`/api/students`, `{ success, data, message }`) unless
  the user asks to change it - and then change frontend and backend in the same commit.
- Render's free plan sleeps: the first backend call can take ~1 minute. Be patient.
