/**
 * Multi-domain isolation, in a real browser.
 *
 * Two independent applications run on the same host (`127.0.0.1`) on different
 * ports — the case that used to collide when a "domain" was keyed by hostname
 * only. Each has its own login and its own cookies; neither may execute through
 * the other's tools, and revoking one must leave the other working.
 */
import { test, expect } from './fixtures.ts';
import { createTestSite, type TestSite } from '../../packages/test-site/src/server.ts';

let second: TestSite;

test.beforeAll(async () => {
  second = createTestSite({ port: 0 });
  await second.start();
});

test.afterAll(async () => {
  await second.stop();
});

test('two sites coexist with independent sessions and tools', async ({ world }) => {
  await world.pair();
  // Cookies are host-scoped (ports do not separate a cookie jar), so the second
  // app is reached as `localhost` while the first stays on `127.0.0.1`. The
  // same-host/different-port case is covered by the integration suite.
  const hostB = second.origin.replace('127.0.0.1', 'localhost');

  // Enable both origins and start discovery on each.
  for (const origin of [world.site.origin, hostB]) {
    const result = await world.api('/api/v1/domains', {
      method: 'POST',
      body: JSON.stringify({ domain: origin, deepCapture: true }),
    });
    expect(result.status).toBe(201);
    const started = await world.api(`/api/v1/domains/${encodeURIComponent(origin)}/discovery`, { method: 'POST' });
    expect(started.status).toBe(200);
  }

  // Sign in to app A as alice, app B as root: different cookies, same host.
  const pageA = await world.login();
  const pageB = await world.context.newPage();
  await pageB.goto(`${hostB}/login`);
  await pageB.fill('#username', 'root');
  await pageB.fill('#password', 'admin-pass');
  await pageB.click('#login-submit');
  await pageB.waitForURL('**/app');

  await pageA.click('#list-tasks');
  await pageB.click('#list-tasks');
  // The app also loads /api/session on boot; make sure it is observed on both.
  await pageA.reload();
  await pageB.reload();
  await pageA.waitForTimeout(800);

  // Both origins produced their own inventory.
  await expect
    .poll(async () => {
      const result = await world.api<{ endpoints: Array<{ origin: string }> }>('/api/v1/endpoints');
      const origins = new Set(result.body.endpoints.map((endpoint) => endpoint.origin));
      return origins.has(world.site.origin) && origins.has(hostB);
    }, { timeout: 15_000 })
    .toBe(true);

  // Generate and approve tools for each origin separately.
  for (const origin of [world.site.origin, hostB]) {
    const generated = await world.api<{ created: Array<{ fqName: string }> }>('/api/v1/tools/generate', {
      method: 'POST',
      body: JSON.stringify({ origin }),
    });
    expect(generated.status).toBe(201);
    const tools = await world.api<{ tools: Array<{ id: string; origin: string; status: string }> }>(
      `/api/v1/tools?origin=${encodeURIComponent(origin)}`,
    );
    for (const tool of tools.body.tools) {
      expect(tool.origin).toBe(origin);
      await world.api(`/api/v1/tools/${tool.id}/approve`, { method: 'POST' });
    }
  }

  // Every approved tool is bound to exactly one origin.
  const tools = await world.api<{ tools: Array<{ fqName: string; origin: string }> }>('/api/v1/tools');
  const byOrigin = new Map<string, string[]>();
  for (const tool of tools.body.tools) {
    byOrigin.set(tool.origin, [...(byOrigin.get(tool.origin) ?? []), tool.fqName]);
  }
  expect(byOrigin.has(world.site.origin)).toBe(true);
  expect(byOrigin.has(hostB)).toBe(true);

  // Identity comes from the browser session, per origin: alice on A, root on B.
  for (const [origin, expectedUser] of [
    [world.site.origin, 'alice'],
    [hostB, 'root'],
  ] as const) {
    const sessionTool = tools.body.tools.find((tool) => tool.origin === origin && /session/.test(tool.fqName));
    if (!sessionTool) continue;
    const identity = await world.api<{ ok: boolean; body: { user: string } }>('/api/v1/execute', {
      method: 'POST',
      body: JSON.stringify({ tool: sessionTool.fqName, args: {} }),
    });
    expect(identity.body.ok).toBe(true);
    expect(identity.body.body.user).toBe(expectedUser);
  }

  // A call through A's tool lands on A, with A's session (alice's tasks).
  const listA = tools.body.tools.find(
    (tool) => tool.origin === world.site.origin && /list_task/.test(tool.fqName),
  );
  expect(listA).toBeTruthy();
  const requestsBeforeB = second.getRequestLog().length;
  const resultA = await world.api<{ ok: boolean; body: { items: Array<{ title: string }> } }>('/api/v1/execute', {
    method: 'POST',
    body: JSON.stringify({ tool: listA!.fqName, args: {} }),
  });
  expect(resultA.body.ok).toBe(true);
  // B recorded nothing: no cross-origin dispatch.
  expect(second.getRequestLog().length).toBe(requestsBeforeB);

  // Revoking A must not touch B.
  const disabled = await world.api(`/api/v1/domains/${encodeURIComponent(world.site.origin)}`, { method: 'DELETE' });
  expect(disabled.status).toBe(200);
  const afterDisable = await world.api<{ tools: Array<{ origin: string; status: string }> }>('/api/v1/tools');
  const bTools = afterDisable.body.tools.filter((tool) => tool.origin === hostB);
  const aTools = afterDisable.body.tools.filter((tool) => tool.origin === world.site.origin);
  expect(bTools.every((tool) => tool.status === 'approved')).toBe(true);
  expect(aTools.every((tool) => tool.status === 'revoked')).toBe(true);

  // B still answers after A is revoked.
  const listB = tools.body.tools.find((tool) => tool.origin === hostB && /list_task/.test(tool.fqName));
  const resultB = await world.api<{ ok: boolean }>('/api/v1/execute', {
    method: 'POST',
    body: JSON.stringify({ tool: listB!.fqName, args: {} }),
  });
  expect(resultB.body.ok).toBe(true);

  // A is refused, with no request reaching A.
  const requestsBeforeA = world.site.getRequestLog().length;
  const refused = await world.api<{ ok: boolean; error: { code: string } }>('/api/v1/execute', {
    method: 'POST',
    body: JSON.stringify({ tool: listA!.fqName, args: {} }),
  });
  expect(refused.body.ok).toBe(false);
  expect(['tool_revoked', 'domain_not_allowed', 'policy_blocked']).toContain(refused.body.error.code);
  expect(world.site.getRequestLog().length).toBe(requestsBeforeA);

  // Sessions are tracked per origin.
  const domains = await world.api<{ domains: Array<{ origin: string; session: { status: string } }> }>('/api/v1/domains');
  const aRecord = domains.body.domains.find((domain) => domain.origin === world.site.origin);
  const bRecord = domains.body.domains.find((domain) => domain.origin === hostB);
  expect(aRecord).toBeTruthy();
  expect(bRecord).toBeTruthy();
  expect(bRecord!.session.status).toBe('ok');

  await pageA.close();
  await pageB.close();
});
