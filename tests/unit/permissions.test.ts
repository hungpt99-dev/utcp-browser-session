import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPermission, requiresApproval, requiresConfirmation } from '../../packages/shared/src/permissions.ts';

const classify = (
  method: string,
  path: string,
  extra: { kind?: 'rest' | 'graphql' | 'upload' | 'download' | 'stream' | 'unknown'; operationName?: string; hasBody?: boolean } = {},
) => classifyPermission({ method, path, ...extra });

describe('classifyPermission', () => {
  it('treats safe methods as READ', () => {
    for (const method of ['GET', 'get', 'HEAD', 'OPTIONS']) {
      const result = classify(method, '/api/tasks');
      assert.equal(result.level, 'READ');
      assert.equal(result.confident, true);
    }
  });

  it('treats POST/PUT/PATCH as WRITE by default', () => {
    for (const method of ['POST', 'PUT', 'PATCH']) {
      assert.equal(classify(method, '/api/tasks').level, 'WRITE');
    }
  });

  it('treats DELETE as DESTRUCTIVE', () => {
    const result = classify('DELETE', '/api/tasks/1');
    assert.equal(result.level, 'DESTRUCTIVE');
    assert.equal(result.confident, true);
  });

  it('escalates write methods on destructive-looking paths', () => {
    for (const path of ['/api/tasks/bulk-delete', '/api/sessions/revoke', '/api/account/purge', '/api/db/drop']) {
      assert.equal(classify('POST', path).level, 'DESTRUCTIVE', path);
    }
    assert.equal(classify('POST', '/api/tasks').level, 'WRITE');
    assert.equal(classify('POST', '/api/tasks/archive').level, 'DESTRUCTIVE');
  });

  it('marks unknown methods as unconfident so review is mandatory', () => {
    const result = classify('REPORT', '/api/tasks');
    assert.equal(result.level, 'WRITE');
    assert.equal(result.confident, false);
  });

  it('does not let the method override a destructive path', () => {
    // A GET can mutate: the path wins over the method.
    assert.equal(classify('GET', '/api/tasks/delete-preview').level, 'DESTRUCTIVE');
    assert.equal(classify('GET', '/api/tasks/1/remove').level, 'DESTRUCTIVE');
    assert.equal(classify('HEAD', '/api/cache/purge').level, 'DESTRUCTIVE');
  });

  it('does not let the method hide a read-only operation', () => {
    // A POST can be read-only: search endpoints are the common case.
    const search = classify('POST', '/api/search', { hasBody: true });
    assert.equal(search.level, 'READ');
    assert.equal(search.confident, true);
    assert.ok(search.signals.includes('path-verb:search'));
    assert.equal(classify('POST', '/api/tasks/query', { hasBody: true }).level, 'READ');
  });

  it('classifies GraphQL operations by name, not by the POST method', () => {
    assert.equal(classify('POST', '/graphql', { kind: 'graphql', operationName: 'GetIssue' }).level, 'READ');
    assert.equal(classify('POST', '/graphql', { kind: 'graphql', operationName: 'UpdateIssue' }).level, 'WRITE');
    assert.equal(classify('POST', '/graphql', { kind: 'graphql', operationName: 'DeleteIssue' }).level, 'DESTRUCTIVE');
  });

  it('treats uploads as writes', () => {
    assert.equal(classify('POST', '/api/files', { kind: 'upload' }).level, 'WRITE');
  });

  it('records the evidence it used', () => {
    const result = classify('DELETE', '/api/tasks/12');
    assert.ok(result.signals.some((signal) => signal === 'method:DELETE'));
    assert.ok(result.signals.length >= 1);
  });
});

describe('approval helpers', () => {
  it('requires confirmation for destructive calls', () => {
    assert.equal(requiresConfirmation('READ'), false);
    assert.equal(requiresConfirmation('WRITE'), false);
    assert.equal(requiresConfirmation('DESTRUCTIVE'), true);
  });

  it('can be told to confirm every write', () => {
    assert.equal(requiresConfirmation('WRITE', true), true);
    assert.equal(requiresConfirmation('READ', true), false);
  });

  it('requires approval for anything that mutates', () => {
    assert.equal(requiresApproval('READ'), false);
    assert.equal(requiresApproval('WRITE'), true);
    assert.equal(requiresApproval('DESTRUCTIVE'), true);
  });
});
