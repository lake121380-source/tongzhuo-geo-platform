import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isApprovedWorkflow,
  isPublishedWorkflow,
  publicationAction,
  reviewStatus,
  workflowStatus,
} from './articleWorkflow';

test('review response that already published is terminal and must not call publish again', () => {
  const article = {
    apiStatus: 'published',
    status: 'published',
    reviewStatus: 'approved',
  };

  assert.equal(publicationAction(article, 'after_review'), 'done');
  assert.equal(isPublishedWorkflow(article), true);
});

test('approved draft/private review response advances to publish', () => {
  assert.equal(publicationAction({ apiStatus: 'draft', reviewStatus: 'approved' }, 'after_review'), 'publish');
  assert.equal(publicationAction({ apiStatus: 'private', reviewStatus: 'auto_approved' }, 'after_review'), 'publish');
  assert.equal(isApprovedWorkflow({ apiStatus: 'draft', reviewStatus: 'approved' }), true);
});

test('an existing approved draft can be retried without submitting review again', () => {
  assert.equal(publicationAction({ apiStatus: 'draft', reviewStatus: 'approved' }), 'publish');
});

test('pending/rejected or malformed review responses are not publishable', () => {
  assert.equal(publicationAction({ apiStatus: 'draft', reviewStatus: 'pending' }, 'after_review'), 'invalid');
  assert.equal(publicationAction({ apiStatus: 'draft', reviewStatus: 'rejected' }, 'after_review'), 'invalid');
  assert.equal(publicationAction({ apiStatus: 'unexpected', reviewStatus: 'approved' }, 'after_review'), 'invalid');
  assert.equal(publicationAction({ status: 'draft', reviewStatus: 'approved' }, 'after_review'), 'invalid');
});

test('display fallback is only used when the raw API status is absent', () => {
  assert.equal(workflowStatus({ status: 'review', reviewStatus: 'pending' }), 'draft');
  assert.equal(workflowStatus({ apiStatus: 'private', status: 'draft' }), 'private');
  assert.equal(reviewStatus({ reviewStatus: 'AUTO_APPROVED' }), 'auto_approved');
});
