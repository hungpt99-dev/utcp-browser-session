import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkRedirect,
  checkTargetUrl,
  isLoopbackDomain,
  isPrivateAddress,
  isValidDomain,
  normalizeDomain,
  parseDomainInput,
} from '../../packages/shared/src/domain.ts';

describe('normalizeDomain', () => {
  it('reduces URLs, credentials and ports to a bare hostname', () => {
    assert.equal(normalizeDomain('HTTPS://user:pass@Example.COM:8443/a/b?c=1#x'), 'example.com');
    assert.equal(normalizeDomain('example.com.'), 'example.com');
    assert.equal(normalizeDomain('  127.0.0.1:8788 '), '127.0.0.1');
    assert.equal(normalizeDomain(''), '');
  });
});

describe('isValidDomain', () => {
  it('accepts real hostnames and loopback', () => {
    assert.ok(isValidDomain('example.com'));
    assert.ok(isValidDomain('app.staging.internal.example.co.uk'));
    assert.ok(isValidDomain('localhost'));
    assert.ok(isValidDomain('127.0.0.1'));
  });

  it('rejects bare IP literals, wildcards and junk', () => {
    assert.equal(isValidDomain('8.8.8.8'), false);
    assert.equal(isValidDomain('*.example.com'), false);
    assert.equal(isValidDomain('exa mple.com'), false);
    assert.equal(isValidDomain('-bad.com'), false);
    assert.equal(isValidDomain(''), false);
  });
});

describe('isPrivateAddress', () => {
  it('flags RFC1918 ranges but allows loopback as an explicit fixture case', () => {
    assert.equal(isPrivateAddress('10.0.0.5'), true);
    assert.equal(isPrivateAddress('192.168.1.1'), true);
    assert.equal(isPrivateAddress('169.254.169.254'), true);
    assert.equal(isPrivateAddress('100.64.0.1'), true);
    assert.equal(isPrivateAddress('127.0.0.1'), false);
    assert.equal(isPrivateAddress('example.com'), false);
  });
});

describe('parseDomainInput', () => {
  it('defaults to https for public hosts and http for loopback', () => {
    assert.deepEqual(parseDomainInput('app.example.com'), { domain: 'app.example.com', origin: 'https://app.example.com' });
    assert.deepEqual(parseDomainInput('127.0.0.1:8788'), { domain: '127.0.0.1', origin: 'http://127.0.0.1:8788' });
    assert.deepEqual(parseDomainInput('https://example.com/some/path?x=1'), {
      domain: 'example.com',
      origin: 'https://example.com',
    });
  });

  it('refuses plain http for non-loopback hosts and embedded credentials', () => {
    assert.equal(parseDomainInput('http://example.com'), null);
    assert.equal(parseDomainInput('https://user:pw@example.com'), null);
    assert.equal(parseDomainInput('ftp://example.com'), null);
    assert.equal(parseDomainInput(''), null);
  });
});

describe('checkTargetUrl', () => {
  it('accepts a same-origin URL', () => {
    const result = checkTargetUrl('https://example.com/api/tasks?x=1', 'example.com');
    assert.equal(result.ok, true);
    assert.equal(result.url?.pathname, '/api/tasks');
  });

  it('rejects a different host', () => {
    const result = checkTargetUrl('https://evil.example.net/api', 'example.com');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'cross_domain_blocked');
  });

  it('rejects a different port when the origin is pinned', () => {
    const result = checkTargetUrl('http://127.0.0.1:9999/api', '127.0.0.1', { expectedOrigin: 'http://127.0.0.1:8788' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'cross_domain_blocked');
  });

  it('rejects non-http schemes', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<script>', 'chrome://settings']) {
      const result = checkTargetUrl(url, 'example.com');
      assert.equal(result.ok, false, url);
    }
  });

  it('rejects credential embeds and header-injection attempts', () => {
    assert.equal(checkTargetUrl('https://user:pw@example.com/', 'example.com').ok, false);
    assert.equal(checkTargetUrl('https://example.com/a%0d%0aX-Injected:%201', 'example.com').ok, false);
    assert.equal(checkTargetUrl('https://example.com/a\nHost: evil', 'example.com').ok, false);
    assert.equal(checkTargetUrl('https://example.com\\@evil.com/', 'example.com').ok, false);
  });

  it('normalizes dot segments without letting a request escape the origin', () => {
    // The URL parser collapses `/api/../../admin` to `/admin`; the origin is
    // unchanged, so this is not an SSRF primitive. The guard still rejects a
    // segment that survives parsing as `..`.
    const normalized = checkTargetUrl('https://example.com/api/../../admin', 'example.com');
    assert.equal(normalized.ok, true);
    assert.equal(normalized.url?.origin, 'https://example.com');
    assert.equal(normalized.url?.pathname, '/admin');
    assert.equal(checkTargetUrl('https://example.com/api/%2e%2e%2fadmin', 'example.com').url?.origin, 'https://example.com');
  });

  it('allows http only for loopback', () => {
    assert.equal(checkTargetUrl('http://example.com/api', 'example.com').ok, false);
    assert.equal(checkTargetUrl('http://127.0.0.1:8788/api', '127.0.0.1').ok, true);
  });

  it('rejects private IP literals', () => {
    const result = checkTargetUrl('http://169.254.169.254/latest/meta-data', '169.254.169.254');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'private_address_blocked');
  });

  it('rejects over-long URLs', () => {
    const url = `https://example.com/${'a'.repeat(2100)}`;
    assert.equal(checkTargetUrl(url, 'example.com').ok, false);
  });
});

describe('checkRedirect', () => {
  it('allows same-origin redirects and blocks cross-origin ones', () => {
    const same = checkRedirect('/api/v2/tasks', 'https://example.com/api/tasks', 'example.com');
    assert.equal(same.ok, true);
    const cross = checkRedirect('https://attacker.example/', 'https://example.com/api', 'example.com');
    assert.equal(cross.ok, false);
    assert.equal(cross.code, 'cross_domain_blocked');
  });

  it('blocks protocol-relative and scheme-downgrade redirects', () => {
    assert.equal(checkRedirect('//attacker.example/x', 'https://example.com/api', 'example.com').ok, false);
    assert.equal(checkRedirect('http://example.com/api', 'https://example.com/api', 'example.com').ok, false);
  });
});

describe('isLoopbackDomain', () => {
  it('recognises loopback forms', () => {
    assert.ok(isLoopbackDomain('127.0.0.1'));
    assert.ok(isLoopbackDomain('localhost'));
    assert.equal(isLoopbackDomain('example.com'), false);
  });
});
