# Student Management System — Vercel + Render + MCP (multi-platform agent)

Ek hi prompt se **frontend, backend, deploy aur data** — sab Claude badal sakta hai.
Hosting: **Vercel** (frontend) + **Render** (backend) + MongoDB Atlas. Netlify use nahi hota.

```
                       ┌──────────────── Claude (unified agent) ────────────────┐
   1 prompt  ───────►  │  student-github   student-vercel   student-render   student-data │
                       └──────┬───────────────┬────────────────┬──────────────┬─┘
                              │ 1 atomic      │ status/wait    │ status/wait  │ CRUD + verify
                              ▼ commit        ▼                ▼ env vars     ▼
                           GitHub ──push──► Vercel          Render ───────► MongoDB Atlas
                        frontend/ + backend/  (frontend/)   (backend/)
```

GitHub me **ek commit** → Vercel aur Render dono khud deploy karte hain → Claude dono ka deploy
status wait karta hai → `/health` se verify karta hai ki naya commit live hai.

## Kya-kya badla

| Jagah | Change |
|---|---|
| `mcp-servers/` (naya) | 4 MCP servers: **GitHub**, **Vercel**, **Render**, **Students/MongoDB** (pehle sirf ek local-file server tha jo Render pe Git me save hi nahi hota tha) |
| `CLAUDE.md`, `.mcp.json` (naya) | Claude ko "unified agent" banane ka playbook + 4 servers ki config |
| `frontend/` | `config.js` (backend URL ek hi jagah), `vercel.json`, Render sleep ke liye 70s timeout + friendly message |
| `backend/` | `GET /health` (DB status + deployed commit), `CORS_ORIGIN` env, **`package.json` fix** (neeche dekho) |
| `render.yaml` (naya) | 4 MCP servers ko Render pe deploy karne ka Blueprint |
| `.gitignore` | Saare `.env` ignore |
| Hata diya | purana `mcp-server/` aur `server.js.before-oauth.txt/` (usme `.env` ki copy thi) |

## ⚠️ Pehle ye karo (security)

Aapke git me **`backend/.env` aur `mcp-server/.env` commit ho chuke hain** (history me bhi).
Matlab MongoDB URI aur MCP token GitHub pe hain.

1. **MongoDB Atlas me DB user ka password change karo** aur Render backend me naya `MONGODB_URI` daalo.
2. Purana `MCP_AUTH_TOKEN` bekaar maano; naya banao:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
3. Git se tracking hatao:
   ```bash
   git rm --cached backend/.env mcp-server/.env
   git rm -r mcp-server            # purana server
   ```
   (History se hatane ke liye `git filter-repo`/BFG use kar sakte ho, par asli fix password change karna hai.)

**Bug jo mila:** `backend/package.json` me MCP wali dependencies thi (`mongoose`/`cors` nahi), jabki
`package-lock.json` me sahi thi. Fresh deploy pe backend `Cannot find module 'cors'` se crash hota.
Naya `package.json` lockfile se match karta hai (`npm ci` test kiya).

## Setup

### 1. Code push karo
Is folder ki files apni repo me daalo, commit + push karo.

### 2. Vercel (frontend)
1. Vercel → **Add New Project** → apni GitHub repo import → **Root Directory = `frontend`**, Framework = *Other*.
2. Deploy ke baad: **Settings → General** se *Project ID* copy karo.
3. **Settings → Git → Deploy Hooks** me `main` branch ka hook banao → URL copy karo.
4. Account **Settings → Tokens** se token banao.

### 3. Render (backend — jo already bana hua hai)
Service → **Settings**:
- Root Directory `backend` · Build `npm install` · Start `node server.js` · Health Check Path `/health`
- **Build Filters → Included Paths: `backend/**`** (taaki frontend change pe backend redeploy na ho)
- Environment: `MONGODB_URI` (naya), `CORS_ORIGIN` = apna Vercel URL (e.g. `https://xyz.vercel.app`)

`srv-xxxx` wali **Service ID** URL me dikhti hai. **Account Settings → API Keys** se key banao.

### 4. GitHub token
Settings → Developer settings → **Fine-grained token** → *sirf is repo* → **Contents: Read and write**.

### 5. MCP servers configure karo
```bash
cd mcp-servers
npm install
cp .env.example .env     # fill karo: GITHUB_TOKEN, VERCEL_*, RENDER_*, BACKEND_URL
npm test                 # offline test (35 checks)
```

### 6. Claude se jodo
**Option A (recommended) — Claude Code:** project folder me `claude` chalao. `.mcp.json` se 4 servers khud
load hote hain, `CLAUDE.md` playbook bhi padh leta hai. `/mcp` se check karo.

**Option B — Claude Desktop:** `docs/claude_desktop_config.example.json` ko apni config me merge karo
(paths badlo), Desktop restart. `CLAUDE.md` ka text Project instructions me paste kar do.

**Option C — Remote (Render):** Blueprint se 4 services banao (`render.yaml`), phir
```bash
claude mcp add --transport http student-github https://student-github-mcp.onrender.com/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```
(baaki teen ke liye bhi aise). Free plan pe service sleep hoti hai — pehli call slow ho sakti hai, isliye A/B zyada reliable hain.
claude.ai web ke custom connector me static Bearer header ka option mujhe nahi pata (OAuth chahiye) — apne UI me check kar lena.

## Ek prompt → saare platforms (examples)

> **"Student me `admissionYear` field add karo: backend schema + validation, frontend form aur table column. Ek hi commit me push karo, Vercel aur Render dono ka deploy wait karo, phir verify karke ek test student add karo."**

Claude: `github_read_file` ×4 → `github_commit_changes` (frontend + backend, 1 commit) → `vercel_wait_for_deployment` + `render_wait_for_deploy` → `students_verify_backend_commit` → `students_add` → report.

> **"Header ka title 'Campus Student Portal' kar do aur subtitle me college ka naam daalo, deploy karke bata do."** (sirf frontend)

> **"Backend CORS ko sirf mere Vercel domain tak limit karo."** → `render_set_env CORS_ORIGIN` + redeploy + health check.

> **"Sab platforms ka status batao."** → `vercel_list_deployments`, `render_service_status`, `render_list_deploys`, `students_health`.

## Guardrails
- `.env`, `.git`, `node_modules`, `*.pem/*.key` kabhi read/write nahi hote.
- Sirf `ALLOWED_WRITE_PREFIXES` (`frontend/`, `backend/`, `README.md`, `render.yaml`) me write; `mcp-servers/` prompt se edit nahi hota.
- JS/JSON me syntax error ho to **commit hi nahi hota** (broken deploy se bachav).
- `dry_run` preview, "unchanged" files par empty commit nahi, branch move ho to safe fail.
- Render env values kabhi echo nahi hoti; error messages se tokens scrub hote hain.
- `students_delete` ko `confirm: true` chahiye.

## Honest notes
- Test **mock GitHub/Vercel/Render/backend** ke against hue hain (35 checks, HTTP + stdio, guardrails tod ke bhi check kiya).
  Real accounts/credentials mere paas nahi the, to live API call test nahi hui; endpoints official docs se match kiye hain.
  Pehli baar "Sab platforms ka status batao" jaisa chhota prompt chalao.
- Vercel/Render dono GitHub se auto-deploy karte hain, isliye `vercel_redeploy` / `render_trigger_deploy` sirf env change ya manual redeploy ke liye hain.
- Env var badalne par Render redeploy zaroori hai (`redeploy: true`).
