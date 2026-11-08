/**
 * Local test website.
 *
 * A deliberately small, deterministic target for discovery and execution tests.
 * It is a normal session-cookie website: HttpOnly cookie, CSRF token for
 * mutations, per-user authorisation, and an admin-only endpoint. It also keeps
 * a request log so a test can prove a rejected tool call never reached it.
 *
 * Not part of the product: it exists so the project can be verified without a
 * production GitHub/Jira/Notion account.
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { PROJECTS, USERS, cloneTasks, type Task } from './fixtures.ts';

export interface RequestLogEntry {
  at: string;
  method: string;
  path: string;
  query: string;
  hadSessionCookie: boolean;
  status: number;
  /** Whether an Origin header was present; used to document CSRF behaviour. */
  hadOrigin: boolean;
}

export interface SessionState {
  token: string;
  username: string;
  role: 'member' | 'admin';
  csrf: string;
  valid: boolean;
  createdAt: number;
}

export interface TestSiteOptions {
  port?: number;
  host?: string;
  /** Token required by the /__test/* control endpoints. */
  testToken?: string;
  /** Artificial latency applied to every /api/* response. */
  latencyMs?: number;
}

export interface TestSite {
  readonly port: number;
  readonly origin: string;
  readonly testToken: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  reset(): void;
  getTasks(): Task[];
  getSessions(): SessionState[];
  getRequestLog(): RequestLogEntry[];
  /** Direct session creation, for tests that call the API without a browser. */
  createSession(username: string): SessionState;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { ...JSON_HEADERS, ...headers });
  res.end(payload);
}

function html(res: http.ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
  res.end(body);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

async function readBody(req: http.IncomingMessage, limit = 512 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createTestSite(options: TestSiteOptions = {}): TestSite {
  const testToken = options.testToken ?? 'test-control-token';
  const latency = options.latencyMs ?? 0;
  let tasks = cloneTasks();
  const sessions = new Map<string, SessionState>();
  let requestLog: RequestLogEntry[] = [];
  let nextTaskId = 100;
  let origin = `http://127.0.0.1:${options.port ?? 0}`;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', origin);
    const path = url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();
    const cookies = parseCookies(req.headers.cookie);
    const session = cookies.sid ? sessions.get(cookies.sid) : undefined;
    const authed = !!session && session.valid;
    const logEntry: RequestLogEntry = {
      at: new Date().toISOString(),
      method,
      path,
      query: url.search,
      hadSessionCookie: !!cookies.sid,
      status: 0,
      hadOrigin: !!req.headers.origin,
    };

    const finish = (status: number) => {
      logEntry.status = status;
      requestLog.push(logEntry);
      if (requestLog.length > 2000) requestLog = requestLog.slice(-2000);
    };

    try {
      if (latency > 0 && path.startsWith('/api/')) {
        await new Promise((resolve) => setTimeout(resolve, latency));
      }

      // ---- test control plane (never used by the product) -------------------
      if (path.startsWith('/__test/')) {
        if (req.headers['x-test-token'] !== testToken) {
          finish(403);
          send(res, 403, { error: 'test token required' });
          return;
        }
        if (path === '/__test/state') {
          finish(200);
          send(res, 200, {
            tasks,
            projects: PROJECTS,
            sessions: [...sessions.values()].map((s) => ({ username: s.username, role: s.role, valid: s.valid })),
          });
          return;
        }
        if (path === '/__test/requests') {
          finish(200);
          send(res, 200, { requests: requestLog, count: requestLog.length });
          return;
        }
        if (path === '/__test/reset' && method === 'POST') {
          tasks = cloneTasks();
          sessions.clear();
          requestLog = [];
          nextTaskId = 100;
          finish(200);
          send(res, 200, { ok: true });
          return;
        }
        finish(404);
        send(res, 404, { error: 'unknown control endpoint' });
        return;
      }

      // ---- pages -----------------------------------------------------------
      if (path === '/' ) {
        finish(303);
        res.writeHead(303, { location: authed ? '/app' : '/login' });
        res.end();
        return;
      }

      if (path === '/login' && method === 'GET') {
        finish(200);
        html(
          res,
          200,
          `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture App — Sign in</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#0b1020; color:#e6edf7;
         font:15px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  .card { width:360px; padding:28px; border-radius:14px; background:#141b2d; border:1px solid #24304a;
          box-shadow:0 18px 50px rgba(0,0,0,.45); }
  h1 { margin:0 0 4px; font-size:20px; }
  p.sub { margin:0 0 20px; color:#8fa1c0; font-size:13px; }
  label { display:block; font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:#8fa1c0; margin:14px 0 6px; }
  input { width:100%; box-sizing:border-box; padding:10px 12px; border-radius:8px; border:1px solid #2b3a58;
          background:#0e1526; color:#e6edf7; font-size:14px; }
  button { margin-top:22px; width:100%; padding:11px; border:0; border-radius:8px; background:#3b82f6; color:#fff;
           font-weight:600; font-size:14px; cursor:pointer; }
  .hint { margin-top:16px; font-size:12px; color:#6b7c9b; }
</style></head><body>
<form class="card" method="post" action="/login">
  <h1>Fixture App</h1>
  <p class="sub">A local authenticated API for testing browser-session tools.</p>
  <label for="username">Username</label>
  <input id="username" name="username" value="alice" autocomplete="username">
  <label for="password">Password</label>
  <input id="password" name="password" type="password" value="correct-horse" autocomplete="current-password">
  <button type="submit" id="login-submit">Sign in</button>
  <p class="hint">Seeded accounts: alice / correct-horse, root / admin-pass</p>
</form></body></html>`,
        );
        return;
      }

      if (path === '/login' && method === 'POST') {
        const body = await readBody(req);
        const params = new URLSearchParams(body);
        const username = params.get('username') ?? '';
        const password = params.get('password') ?? '';
        const user = USERS.find((candidate) => candidate.username === username && candidate.password === password);
        if (!user) {
          finish(401);
          html(res, 401, '<p>Invalid credentials. <a href="/login">Try again</a></p>');
          return;
        }
        const session = createSession(user.username);
        finish(303);
        res.writeHead(303, {
          location: '/app',
          'set-cookie': `sid=${session.token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=3600`,
        });
        res.end();
        return;
      }

      if (path === '/app') {
        if (!authed) {
          finish(303);
          res.writeHead(303, { location: '/login' });
          res.end();
          return;
        }
        finish(200);
        html(res, 200, appPage(session!.username, session!.role));
        return;
      }

      // ---- API -------------------------------------------------------------
      if (!path.startsWith('/api/')) {
        finish(404);
        send(res, 404, { error: 'not found' });
        return;
      }

      if (path === '/api/session') {
        if (!authed) {
          finish(401);
          send(res, 401, { error: 'unauthenticated', message: 'Sign in to continue.' });
          return;
        }
        finish(200);
        send(res, 200, { user: session!.username, role: session!.role, csrfUrl: '/api/csrf' });
        return;
      }

      if (path === '/api/session/expire' && method === 'POST') {
        if (session) session.valid = false;
        finish(200);
        send(res, 200, { ok: true, message: 'Session invalidated by test control.' });
        return;
      }

      if (path === '/api/csrf') {
        if (!authed) {
          finish(401);
          send(res, 401, { error: 'unauthenticated' });
          return;
        }
        finish(200);
        send(res, 200, { token: session!.csrf });
        return;
      }

      // Everything below requires a session.
      if (!authed) {
        finish(401);
        send(res, 401, { error: 'unauthenticated', message: 'Sign in to continue.' });
        return;
      }

      // Mutations require the CSRF token. Origin, when present, must be same-site
      // or an extension acting for the user; a foreign web origin is rejected.
      //
      // This models the *supported* pattern: a token-based CSRF scheme that a
      // browser extension can satisfy by fetching the token with the session
      // cookie. Production sites that hard-require a same-origin `Origin` header
      // cannot be called by any extension and are out of scope (see
      // docs/limitations.md).
      if (method !== 'GET' && method !== 'HEAD') {
        const requestOrigin = req.headers.origin;
        const fromExtension = (requestOrigin ?? '').startsWith('chrome-extension://');
        if (requestOrigin && requestOrigin !== origin && !fromExtension) {
          finish(403);
          send(res, 403, { error: 'csrf_origin_mismatch' });
          return;
        }
        const token = req.headers['x-csrf-token'];
        if (token !== session!.csrf) {
          finish(403);
          send(res, 403, { error: 'csrf_token_invalid', message: 'A valid x-csrf-token header is required.' });
          return;
        }
      }

      if (path === '/api/tasks' && method === 'GET') {
        const status = url.searchParams.get('status');
        const limitRaw = url.searchParams.get('limit');
        const limit = limitRaw ? Math.min(Math.max(Number(limitRaw) || 10, 1), 100) : 10;
        const filtered = status ? tasks.filter((task) => task.status === status) : tasks;
        finish(200);
        send(res, 200, { tasks: filtered.slice(0, limit), total: filtered.length, status: status ?? null });
        return;
      }

      if (path === '/api/tasks' && method === 'POST') {
        const raw = await readBody(req);
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(raw);
        } catch {
          finish(400);
          send(res, 400, { error: 'invalid_json' });
          return;
        }
        const title = typeof payload.title === 'string' ? payload.title.trim() : '';
        if (!title) {
          finish(422);
          send(res, 422, { error: 'title_required', message: 'title must be a non-empty string.' });
          return;
        }
        const task: Task = {
          id: nextTaskId++,
          title,
          description: typeof payload.description === 'string' ? payload.description : '',
          status: 'open',
          priority: typeof payload.priority === 'number' ? payload.priority : 3,
          owner: session!.username,
          createdAt: new Date().toISOString(),
        };
        tasks.push(task);
        finish(201);
        send(res, 201, { task, created: true });
        return;
      }

      if (path === '/api/tasks/bulk-delete' && method === 'POST') {
        const raw = await readBody(req);
        const payload = raw ? JSON.parse(raw) : {};
        const ids: number[] = Array.isArray(payload.ids) ? payload.ids.filter((id: unknown) => typeof id === 'number') : [];
        const before = tasks.length;
        tasks = tasks.filter((task) => !ids.includes(task.id));
        finish(200);
        send(res, 200, { removed: before - tasks.length, remaining: tasks.length });
        return;
      }

      const taskMatch = path.match(/^\/api\/tasks\/(\d+)$/);
      if (taskMatch) {
        const id = Number(taskMatch[1]);
        const task = tasks.find((candidate) => candidate.id === id);
        if (!task) {
          finish(404);
          send(res, 404, { error: 'task_not_found', id });
          return;
        }
        if (method === 'GET') {
          finish(200);
          send(res, 200, { task });
          return;
        }
        if (method === 'PATCH') {
          const raw = await readBody(req);
          const payload = JSON.parse(raw || '{}');
          if (typeof payload.title === 'string') task.title = payload.title;
          if (typeof payload.status === 'string') task.status = payload.status;
          if (typeof payload.priority === 'number') task.priority = payload.priority;
          finish(200);
          send(res, 200, { task, updated: true });
          return;
        }
        if (method === 'DELETE') {
          tasks = tasks.filter((candidate) => candidate.id !== id);
          finish(204);
          res.writeHead(204);
          res.end();
          return;
        }
      }

      const projectMatch = path.match(/^\/api\/projects\/([\w-]+)\/summary$/);
      if (projectMatch && method === 'GET') {
        const project = PROJECTS.find((candidate) => candidate.id === projectMatch[1]);
        if (!project) {
          finish(404);
          send(res, 404, { error: 'project_not_found' });
          return;
        }
        const projectTasks = tasks.filter((task) => project.taskIds.includes(task.id));
        finish(200);
        send(res, 200, {
          project: { id: project.id, name: project.name },
          counts: { total: projectTasks.length, open: projectTasks.filter((t) => t.status === 'open').length },
          tasks: projectTasks,
        });
        return;
      }

      if (path === '/api/admin/users') {
        if (session!.role !== 'admin') {
          finish(403);
          send(res, 403, { error: 'forbidden', message: 'Admin role required.' });
          return;
        }
        finish(200);
        send(res, 200, { users: USERS.map((user) => ({ username: user.username, role: user.role })) });
        return;
      }

      if (path === '/api/redirect') {
        const target = url.searchParams.get('to') ?? '/api/tasks';
        finish(302);
        res.writeHead(302, { location: target });
        res.end();
        return;
      }

      if (path === '/api/slow') {
        const ms = Math.min(Math.max(Number(url.searchParams.get('ms')) || 1000, 1), 15_000);
        await new Promise((resolve) => setTimeout(resolve, ms));
        finish(200);
        send(res, 200, { waitedMs: ms });
        return;
      }

      if (path === '/api/large') {
        const bytes = Math.min(Math.max(Number(url.searchParams.get('bytes')) || 200_000, 1), 8 * 1024 * 1024);
        const filler = 'x'.repeat(Math.max(bytes - 60, 1));
        finish(200);
        send(res, 200, { payload: filler, bytes });
        return;
      }

      if (path === '/api/invalid') {
        finish(200);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end('{"broken": tru');
        return;
      }

      if (path === '/api/boom') {
        finish(500);
        send(res, 500, { error: 'internal_error', message: 'Fixture failure for error-normalization tests.' });
        return;
      }

      finish(404);
      send(res, 404, { error: 'not_found', path });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown';
      finish(500);
      if (!res.headersSent) send(res, 500, { error: 'fixture_error', message });
      else res.end();
    }
  });

  function createSession(username: string): SessionState {
    const user = USERS.find((candidate) => candidate.username === username) ?? USERS[0];
    const session: SessionState = {
      token: randomBytes(24).toString('hex'),
      username: user.username,
      role: user.role,
      csrf: randomBytes(18).toString('base64url'),
      valid: true,
      createdAt: Date.now(),
    };
    sessions.set(session.token, session);
    return session;
  }

  return {
    get port() {
      const address = server.address();
      return typeof address === 'object' && address ? address.port : 0;
    },
    get origin() {
      return origin;
    },
    testToken,
    async start() {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => resolve());
      });
      origin = `http://127.0.0.1:${this.port}`;
    },
    async stop() {
      // Browsers keep sockets alive; without this the close callback never fires.
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
    reset() {
      tasks = cloneTasks();
      sessions.clear();
      requestLog = [];
      nextTaskId = 100;
    },
    getTasks() {
      return tasks.map((task) => ({ ...task }));
    },
    getSessions() {
      return [...sessions.values()];
    },
    getRequestLog() {
      return requestLog.slice();
    },
    createSession,
  };
}

function appPage(username: string, role: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture App</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0b1020; color:#e6edf7; font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  header { display:flex; align-items:center; gap:14px; padding:16px 24px; border-bottom:1px solid #1e2942; background:#0e1526; }
  header h1 { font-size:16px; margin:0; }
  .who { margin-left:auto; font-size:13px; color:#8fa1c0; }
  .pill { padding:3px 9px; border-radius:999px; background:#1b2740; border:1px solid #2b3a58; font-size:12px; }
  main { max-width:980px; margin:0 auto; padding:24px; display:grid; gap:18px; }
  section { background:#141b2d; border:1px solid #24304a; border-radius:12px; padding:18px; }
  h2 { margin:0 0 12px; font-size:14px; text-transform:uppercase; letter-spacing:.08em; color:#8fa1c0; }
  button { padding:8px 14px; border-radius:8px; border:1px solid #2b3a58; background:#1b2740; color:#e6edf7;
           font-size:13px; cursor:pointer; margin:0 8px 8px 0; }
  button:hover { background:#22304d; }
  button.primary { background:#3b82f6; border-color:#3b82f6; color:#fff; font-weight:600; }
  button.danger { background:#3a1620; border-color:#6b2233; color:#ff9fb0; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid #1e2942; }
  th { color:#8fa1c0; font-weight:500; font-size:12px; text-transform:uppercase; letter-spacing:.06em; }
  pre { margin:0; padding:12px; border-radius:8px; background:#0a1020; border:1px solid #1e2942; overflow:auto;
        max-height:320px; font-size:12px; color:#9fd0ff; }
  .row { display:flex; flex-wrap:wrap; gap:6px; }
</style></head><body>
<header>
  <h1>Fixture App</h1>
  <span class="pill">${role}</span>
  <span class="who">signed in as <strong>${username}</strong></span>
</header>
<main>
  <section>
    <h2>Tasks</h2>
    <div class="row">
      <button id="list-tasks" class="primary">List tasks</button>
      <button id="get-task">Get task 1</button>
      <button id="create-task">Create task</button>
      <button id="update-task">Update task 1</button>
      <button id="delete-task" class="danger">Delete task 3</button>
      <button id="bulk-delete" class="danger">Bulk delete [3]</button>
      <button id="project-summary">Project summary</button>
      <button id="admin-users">Admin users</button>
      <button id="slow">Slow call</button>
      <button id="invalid">Invalid JSON</button>
    </div>
    <table><thead><tr><th>ID</th><th>Title</th><th>Status</th><th>Priority</th><th>Owner</th></tr></thead>
      <tbody id="task-rows"><tr><td colspan="5">Press “List tasks”.</td></tr></tbody></table>
  </section>
  <section>
    <h2>Last response</h2>
    <pre id="output">—</pre>
  </section>
</main>
<script>
  const out = document.getElementById('output');
  let csrf = null;
  const show = (value) => { out.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); };
  const render = (tasks) => {
    document.getElementById('task-rows').innerHTML = tasks.map((t) =>
      '<tr><td>' + t.id + '</td><td>' + t.title + '</td><td>' + t.status + '</td><td>' + t.priority + '</td><td>' + t.owner + '</td></tr>'
    ).join('') || '<tr><td colspan="5">No tasks.</td></tr>';
  };
  const csrfToken = async () => {
    if (csrf) return csrf;
    const response = await fetch('/api/csrf', { credentials: 'include' });
    csrf = (await response.json()).token;
    return csrf;
  };
  const call = async (path, init = {}) => {
    const options = { credentials: 'include', ...init };
    options.headers = { ...(init.headers || {}) };
    if (options.method && options.method !== 'GET') options.headers['x-csrf-token'] = await csrfToken();
    if (options.body) options.headers['content-type'] = 'application/json';
    const response = await fetch(path, options);
    const text = await response.text();
    let parsed = text;
    try { parsed = text ? JSON.parse(text) : null; } catch (e) { /* keep text */ }
    show({ status: response.status, body: parsed });
    return parsed;
  };
  document.getElementById('list-tasks').onclick = async () => {
    const data = await call('/api/tasks?status=open&limit=10');
    if (data && data.tasks) render(data.tasks);
  };
  document.getElementById('get-task').onclick = () => call('/api/tasks/1');
  document.getElementById('create-task').onclick = () => call('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ title: 'Task from the fixture UI', description: 'created by a click', priority: 2 }),
  });
  document.getElementById('update-task').onclick = () => call('/api/tasks/1', {
    method: 'PATCH',
    body: JSON.stringify({ priority: 1, status: 'in_progress' }),
  });
  document.getElementById('delete-task').onclick = () => call('/api/tasks/3', { method: 'DELETE' });
  document.getElementById('bulk-delete').onclick = () => call('/api/tasks/bulk-delete', {
    method: 'POST',
    body: JSON.stringify({ ids: [3] }),
  });
  document.getElementById('project-summary').onclick = () => call('/api/projects/proj-1/summary');
  document.getElementById('admin-users').onclick = () => call('/api/admin/users');
  document.getElementById('slow').onclick = () => call('/api/slow?ms=1500');
  document.getElementById('invalid').onclick = () => call('/api/invalid');
</script>
</body></html>`;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const site = createTestSite({ port: Number(process.env.SITE_PORT ?? 8788) });
  await site.start();
  console.log(`[test-site] listening on ${site.origin}`);
  console.log(`[test-site] control token: ${site.testToken} (header: x-test-token)`);
  console.log('[test-site] users: alice/correct-horse (member), root/admin-pass (admin)');
}
