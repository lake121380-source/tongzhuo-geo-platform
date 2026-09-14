import test from 'node:test';
import assert from 'node:assert/strict';
import { probeTitleReadiness } from './titleReadiness';

const libraries = [{ id: 7, name: '科技标题库' }, { id: 9, name: '行业标题库' }];

test('probeTitleReadiness projects each library into a readable readiness record', async () => {
  const report = await probeTitleReadiness(async (params) => {
    if (params.title_library_id === 7) {
      return { status: 'ready', library: { name: '科技标题库', total: 12, available: 5 } };
    }
    return { status: 'blocked', library: { name: '行业标题库', total: 3, available: 0 } };
  }, libraries);

  assert.deepEqual(report['7'], { name: '科技标题库', total: 12, available: 5, blocked: false });
  assert.deepEqual(report['9'], { name: '行业标题库', total: 3, available: 0, blocked: true });
});

test('a failed probe is absent from the result, not reported as unusable', async () => {
  // 这条守的是「未知 ≠ 不可用」：把一次网络失败写成 available=0 会让清单
  // 把「不知道」说成「标题用完了」，用户于是去补一批并不需要的标题。
  const report = await probeTitleReadiness(async (params) => {
    if (params.title_library_id === 7) throw new Error('offline');
    return { status: 'ready', library: { total: 4, available: 4 } };
  }, libraries);

  assert.equal('7' in report, false);
  assert.equal(report['9'].available, 4);
});

test('probeTitleReadiness asks with the documented task-shaped parameters', async () => {
  const seen: Array<Record<string, unknown>> = [];
  await probeTitleReadiness(async (params) => {
    seen.push(params);
    return { status: 'ready', library: { total: 1, available: 1 } };
  }, [libraries[0]]);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].title_library_id, 7);
  assert.equal(seen[0].article_limit, 1);
  assert.equal(seen[0].is_loop, 0);
  assert.equal(seen[0].status, 'active');
});

test('no libraries means no requests at all', async () => {
  let calls = 0;
  const report = await probeTitleReadiness(async () => {
    calls += 1;
    return {};
  }, []);

  assert.deepEqual(report, {});
  assert.equal(calls, 0);
});

test('a library name falls back to the catalog name when the report omits it', async () => {
  const report = await probeTitleReadiness(async () => ({ status: 'ready', library: { total: 2, available: 2 } }), [libraries[1]]);

  assert.equal(report['9'].name, '行业标题库');
});
