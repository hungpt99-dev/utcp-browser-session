import { test, expect } from './fixtures.ts';
import { createBrowserSessionClient } from '../../packages/provider/src/index.ts';

// One browser profile, one runtime: the tests below walk the documented
// workflow in order and share the state each step produces.
test.describe.configure({ mode: 'serial' });

test('AC-01: the unpacked extension installs and its service worker starts', async ({ world }) => {
  const swUrl = world.serviceWorker.url();
  expect(swUrl).toMatch(/^chrome-extension:\/\/[a-p]{32}\/background\.js$/);

  const popup = await world.popup();
  await expect(popup.getByText('UTCP Browser Session')).toBeVisible();
  await expect(popup.getByText('Not paired')).toBeVisible();

  const manifest = await popup.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.host_permissions).toEqual(['http://127.0.0.1/*', 'http://localhost/*']);
  expect(manifest.optional_host_permissions).toEqual(['https://*/*']);

  await popup.close();
});

test('AC-01: the dashboard is served by the runtime and renders', async ({ world }) => {
  const page = await world.context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const response = await page.goto(`${world.runtime.url}/?token=${world.runtime.token}`);
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByText('Browser', { exact: true }).first()).toBeVisible();
  expect(errors).toEqual([]);
  await page.close();
});

test('AC-02: pairing through the popup authenticates the websocket', async ({ world }) => {
  const popup = await world.pair();
  await expect(popup.getByText('Connected', { exact: true })).toBeVisible();
  expect(world.runtime.hub.status().connected).toBe(true);
  expect(world.runtime.hub.status().client?.label).toBe('Chrome extension');
  await popup.close();
});

test('AC-03: discovery captures the fixture API while the user browses', async ({ world }) => {
  await world.login();
  await world.enableDomain({ deepCapture: true });
  await world.startDiscovery();

  const page = await world.login();
  await page.click('#list-tasks');
  await page.waitForTimeout(300);
  await page.click('#create-task');
  await page.waitForTimeout(300);
  await page.click('#get-task');
  await page.waitForTimeout(300);
  await page.click('#delete-task');

  const endpoints = () => world.api<{ endpoints: any[] }>('/api/v1/endpoints').then((result) => result.body.endpoints);

  await expect
    .poll(async () => (await endpoints()).map((endpoint) => endpoint.key.split(' ').slice(1).join(' ')), { timeout: 20_000 })
    .toEqual(expect.arrayContaining(['GET /api/tasks', 'POST /api/tasks', 'GET /api/tasks/{id}', 'DELETE /api/tasks/{id}']));

  // The page tap reports structural shapes only; wait for them to be merged in.
  await expect
    .poll(
      async () => {
        const create = (await endpoints()).find((endpoint) => endpoint.key.endsWith('POST /api/tasks'));
        return Boolean(create?.requestSchema && create?.responseSchema);
      },
      { timeout: 20_000 },
    )
    .toBe(true);

  const all = await endpoints();
  const create = all.find((endpoint) => endpoint.key.endsWith('POST /api/tasks'));
  expect(create.permission).toBe('WRITE');
  expect(create.sources).toContain('page-tap');

  // No payload values are stored, only structure.
  const raw = JSON.stringify(all);
  expect(raw).not.toContain('Task from the fixture UI');
  expect(raw).not.toContain('correct-horse');
  expect(raw).not.toContain('sid=');

  await page.close();
});

test('AC-04: drafts become a valid UTCP manual only after approval', async ({ world }) => {
  await world.stopDiscovery();
  const generated = await world.api<{ created: any[] }>('/api/v1/tools/generate', {
    method: 'POST',
    body: JSON.stringify({ domain: '127.0.0.1' }),
  });
  expect(generated.body.created.length).toBeGreaterThan(0);
  expect(generated.body.created.every((tool) => tool.status === 'draft')).toBe(true);

  const before = await world.api<{ tools: any[] }>('/api/v1/manual');
  expect(before.body.tools.length).toBe(0);

  const tools = await world.generateAndApprove();
  const readTool = tools.find((tool) => tool.pathTemplate === '/api/tasks' && tool.method === 'GET');
  expect(readTool).toBeTruthy();

  const report = await world.api<{ ok: boolean; sdkValid: boolean; toolCount: number; errors: string[] }>(
    '/api/v1/manual/validate',
  );
  expect(report.body.ok).toBe(true);
  expect(report.body.sdkValid).toBe(true);
  expect(report.body.toolCount).toBeGreaterThanOrEqual(1);

  const manual = await world.api<{ utcp_version: string; manual_version: string; tools: any[] }>('/api/v1/manual');
  expect(manual.body.utcp_version).toBe('1.0');
  const entry = manual.body.tools[0];
  expect(entry.tool_call_template.call_template_type).toBe('utcp_browser_session');
  expect(entry.tool_call_template.pairing_token).toBe('${UTCP_BROWSER_SESSION_TOKEN}');
});

test('AC-05: a real UTCP client executes a read tool through the browser session', async ({ world }) => {
  const { client, manual } = await createBrowserSessionClient({
    runtimeUrl: world.runtime.url,
    token: world.runtime.token,
  });
  expect(manual.success).toBe(true);
  const tools = await client.getTools();
  expect(tools.map((tool) => tool.name)).toContain('browser.list_tasks');

  const requestsBefore = world.site.getRequestLog().length;
  const result = await client.callTool('browser.list_tasks', { status: 'open', limit: 10 });

  expect(result.ok).toBe(true);
  expect(result.status).toBe(200);
  expect(Array.isArray(result.body.tasks)).toBe(true);
  expect(result.body.tasks.length).toBeGreaterThan(0);
  expect(result.body.tasks.every((task: { status: string }) => task.status === 'open')).toBe(true);

  const log = world.site.getRequestLog();
  expect(log.length).toBeGreaterThan(requestsBefore);
  const last = log.at(-1)!;
  expect(last.method).toBe('GET');
  expect(last.path).toBe('/api/tasks');
  expect(last.status).toBe(200);
  expect(last.hadSessionCookie).toBe(true);
});

test('AC-06: a write tool mutates the site exactly once, but only when approved', async ({ world }) => {
  const tasksBefore = world.site.getTasks().length;

  // A draft version must be refused before it can touch the site.
  const all = await world.api<{ tools: any[] }>('/api/v1/tools');
  const createTool = all.body.tools.find((tool) => tool.method === 'POST' && tool.pathTemplate === '/api/tasks');
  await world.api(`/api/v1/tools/${createTool.id}/revoke`, { method: 'POST' });
  const requestsBefore = world.site.getRequestLog().length;

  const { client } = await createBrowserSessionClient({ runtimeUrl: world.runtime.url, token: world.runtime.agentToken });
  // The revoked tool is no longer in the manual, so the client cannot even see it.
  const visible = (await client.getTools()).map((tool) => tool.name);
  expect(visible).not.toContain('browser.create_task');
  expect(world.site.getRequestLog().length).toBe(requestsBefore);
  expect(world.site.getTasks().length).toBe(tasksBefore);

  // Approve it again and execute.
  await world.api(`/api/v1/tools/${createTool.id}/approve`, { method: 'POST' });
  const { client: client2 } = await createBrowserSessionClient({
    runtimeUrl: world.runtime.url,
    token: world.runtime.token,
  });
  const result = await client2.callTool('browser.create_task', {
    title: 'Created through the UTCP client',
    description: 'acceptance run',
    priority: 1,
  });

  expect(result.ok).toBe(true);
  expect(result.status).toBe(201);
  const tasksAfter = world.site.getTasks();
  expect(tasksAfter.length).toBe(tasksBefore + 1);
  expect(tasksAfter.at(-1)?.title).toBe('Created through the UTCP client');
  expect(tasksAfter.filter((task) => task.title === 'Created through the UTCP client').length).toBe(1);

  const audit = await world.api<{ events: any[] }>('/api/v1/audit?kind=tool.executed');
  expect(audit.body.events.length).toBeGreaterThan(0);
});

test('AC-06: destructive tools require an explicit confirmation', async ({ world }) => {
  const { client } = await createBrowserSessionClient({ runtimeUrl: world.runtime.url, token: world.runtime.agentToken });
  const before = world.site.getTasks().length;
  const target = world.site.getTasks().find((task) => task.id === 2)!;
  expect(target).toBeTruthy();

  await expect(client.callTool('browser.delete_task', { id: target.id })).rejects.toThrow(/confirmation/i);
  expect(world.site.getTasks().length).toBe(before);

  const confirmed = await client.callTool('browser.delete_task', { id: target.id, __confirm: true });
  expect(confirmed.status).toBe(204);
  const after = world.site.getTasks();
  expect(after.length).toBe(before - 1);
  expect(after.some((task) => task.id === target.id)).toBe(false);
});

test('AC-07: an expired session yields a reconnect instruction and no fallback', async ({ world }) => {
  const page = await world.context.newPage();
  await page.goto(`${world.site.origin}/app`);
  await page.evaluate(async () => {
    const csrf = (await (await fetch('/api/csrf')).json()).token;
    await fetch('/api/session/expire', { method: 'POST', headers: { 'x-csrf-token': csrf } });
  });
  await page.close();

  const { client } = await createBrowserSessionClient({ runtimeUrl: world.runtime.url, token: world.runtime.agentToken });
  const requestsBefore = world.site.getRequestLog().length;
  await expect(client.callTool('browser.list_tasks', {})).rejects.toThrow(/not authenticated|Sign in again/i);

  const log = world.site.getRequestLog();
  expect(log.length).toBe(requestsBefore + 1);
  expect(log.at(-1)?.status).toBe(401);
});

test('AC-08: an unauthorised domain never reaches the target server', async ({ world }) => {
  const origin = 'https://attacker.invalid';
  await world.api('/api/v1/domains', {
    method: 'POST',
    body: JSON.stringify({ domain: 'attacker.invalid', deepCapture: false }),
  });
  world.runtime.store.recordObservation({
    origin,
    method: 'GET',
    path: '/api/steal',
    queryKeys: [],
    status: 200,
    source: 'webRequest',
  });
  const draft = world.runtime.store.generateDrafts(origin).created[0];
  expect(draft).toBeTruthy();
  world.runtime.store.approveTool(draft.id, 'test');

  // Revoking the domain must revoke its tools, and the request must be refused
  // before anything is dispatched to the browser.
  await world.api(`/api/v1/domains/${encodeURIComponent(origin)}`, { method: 'DELETE' });

  const requestsBefore = world.site.getRequestLog().length;
  const executionsBefore = (await world.api<{ executions: any[] }>('/api/v1/executions?limit=100')).body.executions.length;

  const result = await world.api('/api/v1/execute', {
    method: 'POST',
    body: JSON.stringify({ tool: draft.fqName, args: {}, confirm: false }),
  });
  expect(result.body.ok).toBe(false);
  expect(['tool_revoked', 'domain_not_allowed']).toContain(result.body.error.code);

  const executions = (await world.api<{ executions: any[] }>('/api/v1/executions?limit=100')).body.executions;
  expect(executions.length).toBe(executionsBefore + 1);
  expect(executions[0].outcome).toBe('rejected');
  expect(executions[0].origin).toBe(origin);

  const audit = await world.api<{ events: any[] }>('/api/v1/audit?limit=50');
  expect(audit.body.events.some((event) => event.kind === 'tool.rejected')).toBe(true);
  expect(world.site.getRequestLog().length).toBe(requestsBefore);
});

test('AC-09: no browser credential appears in responses, logs or state', async ({ world }) => {
  const executions = await world.api<{ executions: any[] }>('/api/v1/executions?limit=50');
  const audit = await world.api<{ events: any[] }>('/api/v1/audit?limit=200');
  const serialized = JSON.stringify({ executions: executions.body, audit: audit.body });
  for (const pattern of ['sid=', 'set-cookie', 'authorization', 'correct-horse', 'Bearer ']) {
    expect(serialized.toLowerCase()).not.toContain(pattern.toLowerCase());
  }

  const state = await (await import('node:fs')).promises.readFile(`${world.runtime.config.dataDir}/state.json`, 'utf8');
  expect(state).not.toContain('sid=');
  expect(state).not.toContain(world.runtime.token);
  expect(state).not.toContain(world.runtime.agentToken);

  // The extension itself must not be able to read the cookie either.
  const cookieVisible = await world.serviceWorker.evaluate(async () => {
    try {
      const cookies = await chrome.cookies?.getAll({ url: 'http://127.0.0.1' });
      return Array.isArray(cookies) ? cookies.length : 'no-cookies-api';
    } catch {
      return 'blocked';
    }
  });
  expect(cookieVisible === 0 || cookieVisible === 'blocked' || cookieVisible === 'no-cookies-api').toBe(true);
});

test('AC-10: the runtime survives a timeout and returns a structured error', async ({ world }) => {
  // AC-07 invalidated the session; sign in again so this test exercises a timeout.
  const login = await world.login();
  await login.close();

  world.runtime.store.updateSettings({ defaultTimeoutMs: 1000 });
  world.runtime.store.recordObservation({
    origin: world.site.origin,
    method: 'GET',
    path: '/api/slow',
    queryKeys: ['ms'],
    status: 200,
    source: 'webRequest',
  });
  const draft = world.runtime.store
    .generateDrafts(world.site.origin)
    .created.find((tool) => tool.pathTemplate === '/api/slow')!;
  world.runtime.store.approveTool(draft.id, 'test');

  const { client } = await createBrowserSessionClient({ runtimeUrl: world.runtime.url, token: world.runtime.agentToken });
  await expect(client.callTool(draft.fqName, { ms: '5000' })).rejects.toThrow(/did not finish|timed out/i);

  const status = await world.api('/api/v1/status');
  expect(status.body.connection.connected).toBe(true);
  world.runtime.store.updateSettings({ defaultTimeoutMs: 30_000 });
});

test('AC-10: the runtime stays up when the browser goes away and recovers on reconnect', async ({ world }) => {
  const popup = await world.popup();
  await popup.getByRole('button', { name: 'Unpair' }).click();
  await popup.waitForTimeout(800);
  expect(world.runtime.hub.status().connected).toBe(false);

  const { client } = await createBrowserSessionClient({ runtimeUrl: world.runtime.url, token: world.runtime.agentToken });
  await expect(client.callTool('browser.list_tasks', {})).rejects.toThrow(/browser|disconnected/i);

  const health = await world.api('/api/v1/status');
  expect(health.status).toBe(200);

  await popup.close();
  // Re-pair from the same popup: after unpairing it returns to the pairing form.
  const fresh = await world.popup();
  await expect(fresh.getByText('Not paired')).toBeVisible();
  await world.pair(fresh);
  expect(world.runtime.hub.status().connected).toBe(true);
  await fresh.close();

  const { client: client2 } = await createBrowserSessionClient({
    runtimeUrl: world.runtime.url,
    token: world.runtime.token,
  });
  const result = await client2.callTool('browser.list_tasks', {});
  expect(result.ok).toBe(true);
});
