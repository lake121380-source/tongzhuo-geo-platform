import { GeoFlowApiError } from './geoflowClient';

/**
 * The login response contains the scopes granted to the current bearer
 * token.  Keeping the checks as pure functions makes it possible for views
 * to hide/disable writes without coupling them to the API client instance.
 */
export type ScopeSource = readonly string[] | { scopes?: readonly string[] | null } | null | undefined;

export function normalizeScopes(source: ScopeSource): string[] {
  // `Array.isArray` does not remove `readonly string[]` from the false branch
  // (it only narrows to `any[]` on the true branch), so the union has to be
  // widened to `unknown` before the object-shaped member can be read.
  const raw: unknown = source;
  const values = Array.isArray(raw) ? raw : (raw as { scopes?: readonly string[] | null } | null | undefined)?.scopes;
  if (!Array.isArray(values)) return [];
  return values
    .filter((scope): scope is string => typeof scope === 'string')
    .map((scope) => scope.trim())
    .filter(Boolean);
}

/**
 * 桐灼GEO accepts `*` for an all-scope token.  Treat it as an explicit
 * wildcard here too so the UI does not hide controls for an administrator
 * token that is intentionally unrestricted.
 */
export function hasScope(source: ScopeSource, required: string): boolean {
  const normalized = String(required || '').trim();
  if (!normalized) return false;
  const scopes = normalizeScopes(source);
  return scopes.includes('*') || scopes.includes(normalized);
}

export function hasAnyScope(source: ScopeSource, required: readonly string[]): boolean {
  return required.some((scope) => hasScope(source, scope));
}

export function hasAllScopes(source: ScopeSource, required: readonly string[]): boolean {
  return required.every((scope) => hasScope(source, scope));
}

/** Keep historical database role values aligned with Admin::isSuperAdmin(). */
export function isSuperAdminRole(role: unknown): boolean {
  const normalized = typeof role === 'string' ? role.trim().toLowerCase() : '';
  return normalized === 'super_admin' || normalized === 'superadmin';
}

export function isForbiddenError(error: unknown): error is GeoFlowApiError {
  return error instanceof GeoFlowApiError && error.status === 403;
}

/**
 * 422 的字段级原因。
 *
 * 后端的校验失败信封里，`error.message` 恒为「参数校验失败」，真正的原因
 * （哪个字段、为什么不合法）在 `details.field_errors` 里。以前这里只取 message，
 * 于是运营上传一个 PDF 也只能看到「参数校验失败」，看不出是格式还是大小的问题。
 */
function fieldErrorSummary(details: Record<string, unknown>, lang: 'zh' | 'en'): string {
  const raw = details.field_errors ?? details.fieldErrors;
  if (!raw || typeof raw !== 'object') return '';
  const messages: string[] = [];
  for (const value of Object.values(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && value.trim() !== '') {
      messages.push(value.trim());
    } else if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === 'string' && entry.trim() !== '') messages.push(entry.trim());
      }
    }
    if (messages.length >= 3) break;
  }
  return [...new Set(messages)].slice(0, 3).join(lang === 'en' ? '; ' : '；');
}

/**
 * Turn a backend error into a useful UI message.  In particular, 403s should
 * tell an operator which scope is missing instead of only saying “操作失败”.
 */
export function describeApiError(
  error: unknown,
  fallback: string,
  lang: 'zh' | 'en' = 'zh',
): string {
  if (error instanceof GeoFlowApiError) {
    const requiredScope = typeof error.details.required_scope === 'string'
      ? error.details.required_scope
      : typeof error.details.requiredScope === 'string'
        ? error.details.requiredScope
        : '';
    if (error.status === 403) {
      if (lang === 'en') {
        return requiredScope
          ? `Permission denied (403): this action requires the “${requiredScope}” scope.`
          : 'Permission denied (403): your token cannot perform this action.';
      }
      return requiredScope
        ? `权限不足（403）：此操作需要「${requiredScope}」权限。`
        : '权限不足（403）：当前 Token 无权执行此操作。';
    }
    // 字段级原因优先拼在后面：只有「参数校验失败」这一句等于没说。
    const fields = fieldErrorSummary(error.details, lang);
    if (fields !== '') {
      const head = error.message && error.message !== fields ? error.message : (lang === 'en' ? 'Invalid input' : '参数校验未通过');
      return `${head}：${fields}`;
    }
    if (error.message) return error.message;
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export function requiredScopeLabel(scope: string, lang: 'zh' | 'en' = 'zh'): string {
  return lang === 'en' ? `Requires “${scope}” scope` : `需要「${scope}」权限`;
}
