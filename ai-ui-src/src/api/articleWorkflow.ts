/**
 * The API exposes two workflow fields while the UI has a smaller display
 * status.  Keep the transition decision in one place so a display value can
 * never accidentally be treated as a successful publication.
 */

export type ArticleWorkflowLike = {
  apiStatus?: unknown;
  status?: unknown;
  reviewStatus?: unknown;
};

export type PublicationAction = 'review' | 'publish' | 'done' | 'invalid';

const APPROVED_REVIEW_STATUSES = new Set(['approved', 'auto_approved']);
const PUBLISHABLE_WORKFLOW_STATUSES = new Set(['draft', 'private']);

function normalize(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim().toLowerCase();
}

/** Return the raw 桐灼GEO workflow status, with a safe UI fallback. */
export function workflowStatus(article: ArticleWorkflowLike): string {
  const raw = normalize(article.apiStatus);
  if (raw) return raw;

  const display = normalize(article.status);
  return display === 'published' ? 'published' : display === 'review' ? 'draft' : display;
}

/** The API projection is authoritative only when the raw field is present. */
export function hasRawWorkflowStatus(article: ArticleWorkflowLike): boolean {
  return normalize(article.apiStatus) !== '';
}

export function reviewStatus(article: ArticleWorkflowLike): string {
  return normalize(article.reviewStatus);
}

export function isPublishedWorkflow(article: ArticleWorkflowLike): boolean {
  return workflowStatus(article) === 'published';
}

export function isApprovedWorkflow(article: ArticleWorkflowLike): boolean {
  return APPROVED_REVIEW_STATUSES.has(reviewStatus(article))
    && PUBLISHABLE_WORKFLOW_STATUSES.has(workflowStatus(article));
}

/**
 * Decide the next action for the single “approve and publish” control.
 *
 * Before a review response arrives, an unreviewed draft needs `review`.
 * After a review response, only an explicitly approved draft/private article
 * may continue to `publish`; a malformed or rejected response is invalid and
 * must not trigger another mutation.
 */
export function publicationAction(
  article: ArticleWorkflowLike | null | undefined,
  phase: 'before_review' | 'after_review' = 'before_review',
): PublicationAction {
  if (!article) return 'review';

  // A successful mutation must contain the raw 桐灼GEO status.  Accepting the
  // UI's derived `status` here would turn a truncated/malformed response into
  // a false publication and could issue a second mutation.
  if (phase === 'after_review' && !hasRawWorkflowStatus(article)) return 'invalid';

  if (isPublishedWorkflow(article)) return 'done';
  if (isApprovedWorkflow(article)) return 'publish';

  if (
    phase === 'before_review'
    && (workflowStatus(article) === '' || PUBLISHABLE_WORKFLOW_STATUSES.has(workflowStatus(article)))
  ) {
    return 'review';
  }

  return 'invalid';
}
