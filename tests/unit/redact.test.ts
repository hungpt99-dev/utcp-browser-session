import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { REDACTED, isSecretKey, pickSafeHeaders, redactHeaders, redactString, redactValue } from '../../packages/shared/src/redact.ts';

describe('redactHeaders', () => {
  it('masks credential-bearing headers and keeps the rest', () => {
    const result = redactHeaders({
      Authorization: 'Bearer abcdefghijklmnop',
      Cookie: 'sid=supersecret',
      'Set-Cookie': 'sid=supersecret',
      'X-CSRF-Token': 'tok_123',
      'content-type': 'application/json',
      'x-request-id': 'abc',
    });
    assert.equal(result.authorization, REDACTED);
    assert.equal(result.cookie, REDACTED);
    assert.equal(result['set-cookie'], REDACTED);
    assert.equal(result['x-csrf-token'], REDACTED);
    assert.equal(result['content-type'], 'application/json');
    assert.equal(result['x-request-id'], 'abc');
  });

  it('redacts secret-looking values inside otherwise safe headers', () => {
    const result = redactHeaders({ 'x-debug': 'Bearer aaaaaaaaaaaaaaaa', 'x-note': 'token=abcdefghij' });
    assert.equal(result['x-debug'], REDACTED);
    assert.match(result['x-note'], /\[REDACTED\]/);
  });
});

describe('pickSafeHeaders', () => {
  it('drops everything that is not explicitly safe', () => {
    const result = pickSafeHeaders({
      'content-type': 'application/json',
      'set-cookie': 'sid=x',
      authorization: 'Bearer x',
      'x-powered-by': 'Express',
    });
    assert.deepEqual(Object.keys(result), ['content-type']);
  });
});

describe('redactString', () => {
  it('masks bearer credentials, JWTs and long tokens', () => {
    assert.equal(redactString('Authorization: Bearer abcdefghijklmnop'), `Authorization: ${REDACTED}`);
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    assert.ok(!redactString(`token ${jwt}`).includes('eyJhbGciOiJIUzI1NiJ9'));
    assert.ok(!redactString(`value ${'a'.repeat(48)}`).includes('a'.repeat(48)));
  });

  it('masks cookie pairs', () => {
    assert.equal(redactString('sid=abcdef123456; theme=dark'), `sid=${REDACTED}; theme=dark`);
  });

  it('leaves ordinary text intact', () => {
    assert.equal(redactString('GET /api/tasks -> 200 in 12 ms'), 'GET /api/tasks -> 200 in 12 ms');
  });
});

describe('redactValue', () => {
  it('redacts nested secret keys but keeps structural data', () => {
    const result = redactValue({
      tool: 'browser.list_tasks',
      session: { token: 'abc', cookie: 'sid=1', user: 'alice' },
      items: [{ password: 'x', title: 'ok' }],
    }) as Record<string, any>;
    assert.equal(result.tool, 'browser.list_tasks');
    assert.equal(result.session.token, REDACTED);
    assert.equal(result.session.cookie, REDACTED);
    assert.equal(result.session.user, 'alice');
    assert.equal(result.items[0].password, REDACTED);
    assert.equal(result.items[0].title, 'ok');
  });

  it('stops at depth instead of recursing forever', () => {
    let deep: Record<string, unknown> = { value: 'end' };
    for (let index = 0; index < 30; index += 1) deep = { nested: deep };
    assert.doesNotThrow(() => redactValue(deep));
  });
});

describe('isSecretKey', () => {
  it('recognises common credential names', () => {
    for (const key of ['authorization', 'Cookie', 'x-api-key', 'client_secret', 'refreshToken', 'password', 'session_id']) {
      assert.ok(isSecretKey(key), key);
    }
    assert.equal(isSecretKey('content-type'), false);
    assert.equal(isSecretKey('title'), false);
  });
});
