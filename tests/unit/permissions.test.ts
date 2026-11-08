import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPermission, requiresApproval, requiresConfirmation } from '../../packages/shared/src/permissions.ts';

describe('classifyPermission', () => {
  it('treats safe methods as READ', () => {
    for (const method of ['GET', 'get', 'HEAD', 'OPTIONS']) {
      const result = classifyPermission(method, '/api/tasks');
      assert.equal(result.level, 'READ');
      assert.equal(result.confident, true);
    }
  });

  it('treats POST/PUT/PATCH as WRITE by default', () => {
    for (const method of ['POST', 'PUT', 'PATCH']) {
      assert.equal(classifyPermission(method, '/api/tasks').level, 'WRITE');
    }
  });

  it('treats DELETE as DESTRUCTIVE', () => {
    const result = classifyPermission('DELETE', '/api/tasks/1');
    assert.equal(result.level, 'DESTRUCTIVE');
    assert.equal(result.confident, true);
  });

  it('escalates write methods on destructive-looking paths', () => {
    for (const path of ['/api/tasks/bulk-delete', '/api/sessions/revoke', '/api/account/purge', '/api/db/drop']) {
      assert.equal(classifyPermission('POST', path).level, 'DESTRUCTIVE', path);
    }
    assert.equal(classifyPermission('POST', '/api/tasks').level, 'WRITE');
    assert.equal(classifyPermission('POST', '/api/tasks/archive').level, 'DESTRUCTIVE');
  });

  it('marks unknown methods as unconfident so review is mandatory', () => {
    const result = classifyPermission('REPORT', '/api/tasks');
    assert.equal(result.level, 'WRITE');
    assert.equal(result.confident, false);
  });

  it('does not treat a GET with a destructive word as destructive', () => {
    assert.equal(classifyPermission('GET', '/api/tasks/delete-preview').level, 'READ');
  });
});

describe('approval helpers', () => {
  it('requires confirmation only for destructive calls', () => {
    assert.equal(requiresConfirmation('READ'), false);
    assert.equal(requiresConfirmation('WRITE'), false);
    assert.equal(requiresConfirmation('DESTRUCTIVE'), true);
  });

  it('requires approval for anything that mutates', () => {
    assert.equal(requiresApproval('READ'), false);
    assert.equal(requiresApproval('WRITE'), true);
    assert.equal(requiresApproval('DESTRUCTIVE'), true);
  });
});
