import type { ApiRecord } from './geoflowClient';

/** 一个标题库的真实可用状态。 */
export interface TitleLibraryReadiness {
  /** 库名（后端的报错文案里要用）。 */
  name: string;
  /** 库里一共有多少条标题。 */
  total: number;
  /** 还有多少条没被占用——0 表示这个库对生成没用。 */
  available: number;
  /** 后端明确说「这个库现在不能用于生成」（通常是标题用完了）。 */
  blocked: boolean;
}

/** `GET tasks/title-readiness` 的调用签名。 */
export type TitleReadinessCheck = (
  params: Record<string, string | number | undefined>,
) => Promise<Record<string, unknown>>;

/**
 * 逐个标题库问后端「现在还能用吗」。
 *
 * **抽出来是为了让两个调用方用同一份判据**：AI 生成弹窗要它来给下拉标「可用 N」并禁用
 * 用完的库，总览的「开始使用」清单要它来判断「标题库准备好了没有」。两边各写一遍，
 * 迟早会出现「清单说没问题、弹窗说用不了」这种自相矛盾——而这个项目里「前置条件在动作
 * 之前可见」正是被反复修过的一类缺陷。
 *
 * 探针**失败就跳过该库**（不写进结果、也不抛）：它只是前置提示，真正的门禁在后端。
 * 把失败当成「不可用」会凭空禁掉一个可能好用的库；当成「可用」则会掩盖真实原因——
 * 所以调用方读到的 `undefined` 就是「不知道」，界面上要如实表现为未知。
 */
export async function probeTitleReadiness(
  check: TitleReadinessCheck,
  libraries: Array<{ id: string | number; name?: string }>,
): Promise<Record<string, TitleLibraryReadiness>> {
  const entries = await Promise.all(
    libraries.map(async (library): Promise<readonly [string, TitleLibraryReadiness | null]> => {
      try {
        const report = await check({
          title_library_id: Number(library.id),
          article_limit: 1,
          is_loop: 0,
          status: 'active',
        });
        const payload = (report?.library ?? {}) as ApiRecord;
        return [String(library.id), {
          name: String(payload.name ?? library.name ?? ''),
          total: Number(payload.total ?? 0),
          available: Number(payload.available ?? 0),
          blocked: String(report?.status ?? '') === 'blocked',
        }];
      } catch {
        return [String(library.id), null];
      }
    }),
  );

  const next: Record<string, TitleLibraryReadiness> = {};
  for (const [id, value] of entries) if (value) next[id] = value;
  return next;
}
