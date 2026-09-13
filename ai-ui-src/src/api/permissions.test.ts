import { describeApiError, hasAllScopes, hasAnyScope, hasScope, isSuperAdminRole, normalizeScopes } from './permissions';
import assert from 'node:assert/strict';
import test from 'node:test';
import { GeoFlowApiError } from './geoflowClient';

test('scope helpers accept an auth session projection and wildcard tokens', () => {
  const session = { scopes: [' tasks:read ', 'catalog:read'] };
  assert.deepEqual(normalizeScopes(session), ['tasks:read', 'catalog:read']);
  assert.equal(hasScope(session, 'tasks:read'), true);
  assert.equal(hasScope(session, 'tasks:write'), false);
  assert.equal(hasAnyScope(session, ['tasks:write', 'catalog:read']), true);
  assert.equal(hasAllScopes(session, ['tasks:read', 'catalog:read']), true);
  assert.equal(hasScope(['*'], 'models:write'), true);
});

test('scope helpers reject malformed or empty values', () => {

  test('super administrator role helper accepts canonical and historical values only', () => {
    assert.equal(isSuperAdminRole('super_admin'), true);
    assert.equal(isSuperAdminRole(' SuperAdmin '), true);
    assert.equal(isSuperAdminRole('admin'), false);
    assert.equal(isSuperAdminRole(null), false);
  });
  assert.deepEqual(normalizeScopes({ scopes: [' ', 1 as unknown as string, null as unknown as string] }), []);
  assert.equal(hasScope(undefined, 'tasks:read'), false);
  assert.equal(hasAnyScope([], []), false);
  assert.equal(hasAllScopes([], []), true);
});

test('forbidden API errors expose the required scope in Chinese and English', () => {
  const error = new GeoFlowApiError(
    'Forbidden',
    403,
    'forbidden',
    { required_scope: 'models:write' },
  );
  assert.equal(describeApiError(error, '失败', 'zh'), '权限不足（403）：此操作需要「models:write」权限。');
  assert.equal(describeApiError(error, 'failed', 'en'), 'Permission denied (403): this action requires the “models:write” scope.');
});

test('non-forbidden API errors preserve backend messages', () => {
  const error = new GeoFlowApiError('参数校验失败', 422, 'validation_failed');
  assert.equal(describeApiError(error, '失败'), '参数校验失败');
  assert.equal(describeApiError(new Error('network down'), '失败'), 'network down');
});
