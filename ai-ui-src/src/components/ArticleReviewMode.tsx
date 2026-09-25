import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, CheckCircle2, XCircle, SkipForward, ChevronLeft, ChevronRight, ShieldCheck, AlertTriangle } from 'lucide-react';
import { Article } from '../types';
import { StatusBadge, qualityStatusSpec } from './StatusBadge';

interface ArticleReviewModeProps {
  /** 待审核文章列表 */
  articles: Article[];
  /**
   * 审核操作：通过/退回。
   * **必须返回批量接口的结果**（`succeeded_count` / `failed_count` / `failed[]`）——
   * 后端对不过门禁的文章会逐条返回 failed 而 HTTP 仍是 200，不读结果就会「谎报成功」
   * （2026-09-14 排查发现：点通过后界面显示已处理，其实文章根本没被批准）。
   */
  onReview: (id: string, action: 'approve' | 'reject') => Promise<unknown>;
  /** 人工放行（质检判定为「待人工复核」时唯一的出路）。 */
  onReleaseArticle?: (id: string, reason: string) => Promise<unknown>;
  /** 关闭审核模式 */
  onClose: () => void;
  lang: 'zh' | 'en';
}

/**
 * 批量审核模式：全屏左右分栏，连续处理待审核文章。
 *
 * 左侧：待审核列表，当前项高亮
 * 右侧：文章详情 + 质检报告 + 操作按钮
 *
 * ## 为什么按 id 记账，而不是「审核成功后 index + 1」
 *
 * 审核成功会让这篇文章**离开待审列表**（后端 `review_status` 不再是 `pending`，
 * 列表按它过滤）。父组件的列表一收缩，原来 index+1 的那篇就顶到了当前 index 上，
 * 再 `index + 1` 正好**跳过一篇**——审 10 篇只过 5 篇，而界面上「1 / N」照常往上走，
 * 用户看不出漏了谁。
 *
 * 这里改成：审核成功的 id 记进 `resolvedIds`，当前光标**不动**。被审掉的那篇从
 * 可见列表里消失后，下一篇自然落到同一个位置。父列表有没有来得及刷新都不影响结果。
 *
 * ## 快捷键
 *
 * ←/D 退回，→/A 通过，↑↓ 翻页，Esc 退出。计划里的核心卖点是「连续过审」，
 * 只能用鼠标点等于白做。
 */
export const ArticleReviewMode: React.FC<ArticleReviewModeProps> = ({
  articles,
  onReview,
  onReleaseArticle,
  onClose,
  lang,
}) => {
  const zh = lang === 'zh';
  const [cursor, setCursor] = useState(0);
  const [resolvedIds, setResolvedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** 人工放行：理由（必填，记入审计）与本次会话里已放行的文章。 */
  const [releaseReason, setReleaseReason] = useState('');
  const [releasedIds, setReleasedIds] = useState<string[]>([]);

  const visible = useMemo(
    () => articles.filter((article) => !resolvedIds.includes(article.id)),
    [articles, resolvedIds],
  );
  const safeCursor = Math.min(cursor, Math.max(0, visible.length - 1));
  const current = visible[safeCursor];
  const hasNext = safeCursor < visible.length - 1;
  const hasPrev = safeCursor > 0;

  // 处理完最后一篇（或列表本来就空）就退出，不留一个空壳界面。
  useEffect(() => {
    if (visible.length === 0) onClose();
  }, [visible.length, onClose]);

  const handleAction = async (action: 'approve' | 'reject') => {
    if (!current || busy) return;
    const id = current.id;
    setBusy(true);
    setError('');
    try {
      const result = await onReview(id, action);
      // 后端对「不过门禁」的文章**逐条返回失败但 HTTP 仍是 200**，所以必须读结果：
      // 不读就会把它当成"处理完了"——用户看到「已处理 N 篇」，其实这篇还躺在待审列表里。
      const record = (result && typeof result === 'object') ? result as Record<string, unknown> : {};
      const failedIds = Array.isArray(record.failed_ids) ? record.failed_ids.map(String) : [];
      const failedCount = Number(record.failed_count ?? 0);
      const failed = failedIds.includes(String(id)) || failedCount > 0;
      if (failed) {
        const failures = Array.isArray(record.failed) ? record.failed as Array<Record<string, unknown>> : [];
        const mine = failures.find((f) => String(f.article_id ?? '') === String(id)) ?? failures[0];
        const detail = mine && typeof mine.error === 'object' && mine.error
          ? String((mine.error as Record<string, unknown>).message ?? '')
          : '';
        // 后端那句「文章需要人工审核」没说是**哪条路**——判定为待人工复核时，
        // 出路就是上面的「人工放行」，这里必须点明，否则又是一个没有出口的报错。
        const hint = current.aiQualityDecision === 'needs_review'
          ? (zh ? '先在上方「AI 质检」区填写理由并点『人工放行』，再通过审核。' : 'Release it manually in the AI quality panel above, then approve.')
          : '';
        setError([detail, hint].filter(Boolean).join(' ')
          || (action === 'approve'
            ? (zh ? '这篇没有通过门禁，无法直接通过审核。' : 'Blocked by the gate.')
            : (zh ? '退回失败，请重试。' : 'Reject failed, please retry.')));
        return; // 不标已处理、光标不动——失败就该停在原地
      }
      setResolvedIds((previous) => (previous.includes(id) ? previous : [...previous, id]));
      setReleaseReason('');
    } catch (err) {
      setError(err instanceof Error ? err.message : (zh ? '操作失败' : 'Action failed'));
    } finally {
      setBusy(false);
    }
  };

  /** 人工放行：后端要求填理由（4–1000 字），放行后这篇才能通过审核。 */
  const handleRelease = async () => {
    if (!current || busy || !onReleaseArticle) return;
    const reason = releaseReason.trim();
    if (reason.length < 4) {
      setError(zh ? '放行理由至少 4 个字（会记入审计）。' : 'Release reason must be at least 4 characters.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onReleaseArticle(current.id, reason);
      setReleasedIds((previous) => (previous.includes(current.id) ? previous : [...previous, current.id]));
      setReleaseReason('');
    } catch (err) {
      setError(err instanceof Error ? err.message : (zh ? '人工放行失败' : 'Release failed'));
    } finally {
      setBusy(false);
    }
  };

  const goToPrev = () => {
    if (!hasPrev) return;
    setCursor(safeCursor - 1);
    setError('');
  };

  const goToNext = () => {
    if (!hasNext) return;
    setCursor(safeCursor + 1);
    setError('');
  };

  const skip = () => {
    if (hasNext) {
      setCursor(safeCursor + 1);
      setError('');
    } else {
      onClose();
    }
  };

  // 键盘处理走 ref：监听器只注册一次，而它调用的是**这一次渲染**里的最新闭包
  // （否则光标会一直停在 0，因为监听器捕获的是首次渲染的 state）。
  const handlers = useRef({ approve: () => {}, reject: () => {}, prev: () => {}, next: () => {}, skip: () => {}, close: () => {} });
  useEffect(() => {
    handlers.current = {
      approve: () => void handleAction('approve'),
      reject: () => void handleAction('reject'),
      prev: goToPrev,
      next: goToNext,
      skip,
      close: onClose,
    };
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))) return;
      switch (event.key) {
        case 'Escape': event.preventDefault(); handlers.current.close(); break;
        case 'ArrowRight': case 'a': case 'A': event.preventDefault(); handlers.current.approve(); break;
        case 'ArrowLeft': case 'd': case 'D': event.preventDefault(); handlers.current.reject(); break;
        case 'ArrowDown': case 'j': case 'J': event.preventDefault(); handlers.current.next(); break;
        case 'ArrowUp': case 'k': case 'K': event.preventDefault(); handlers.current.prev(); break;
        default: break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (!current) {
    return null;
  }

  const score = typeof current.geoScore === 'number' ? current.geoScore : null;
  /**
   * 判色用**这篇自己的**通过线/人工放行线。
   *
   * 以前这里写死 80/60，而文章列表按真实 `pass_score` 判、质检面板又写死 85/70——
   * 同一篇 82 分（通过线 85）在三个地方会是三种颜色：审核人看到绿灯点「通过审核」，
   * 结果被质检门禁拒掉。取不到通过线时回落到中性色，不假装知道。
   */
  const passLine = typeof current.aiQualityPassScore === 'number' ? current.aiQualityPassScore : null;
  const overrideLine = typeof current.aiQualityOverrideMinScore === 'number' ? current.aiQualityOverrideMinScore : null;
  const scoreTone = score === null || passLine === null
    ? 'bg-slate-800 text-slate-300 border-slate-700'
    : score >= passLine
      ? 'bg-emerald-950/40 text-emerald-200 border-emerald-500/40'
      : overrideLine !== null && score >= overrideLine
        ? 'bg-amber-950/40 text-amber-200 border-amber-500/40'
        : 'bg-rose-950/40 text-rose-200 border-rose-500/40';

  return (
    <div className="fixed inset-0 bg-slate-950 z-50 flex flex-col">
      {/* 顶栏 */}
      <div className="h-14 border-b border-slate-800 bg-slate-900/95 backdrop-blur-md px-4 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <ShieldCheck className="w-5 h-5 text-indigo-400" />
          <h2 className="text-sm font-bold text-white">
            {zh ? '连续审核' : 'Batch Review'}
          </h2>
          <span data-review-progress className="text-xs text-slate-400 font-mono tabular-nums">
            {safeCursor + 1} / {visible.length}
          </span>
          {resolvedIds.length > 0 && (
            <span className="text-[11px] text-emerald-300">
              {zh ? `已处理 ${resolvedIds.length} 篇` : `${resolvedIds.length} handled`}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
        >
          <X className="w-4 h-4" />
          <span>{zh ? '退出审核' : 'Exit'}</span>
          <kbd className="ml-1 rounded border border-slate-600 px-1 text-[10px] text-slate-400">Esc</kbd>
        </button>
      </div>

      {/* 主体：左右分栏 */}
      <div className="flex-1 flex overflow-hidden">
        {/* 左侧：待审核列表 */}
        <div className="w-64 border-r border-slate-800 bg-slate-900/50 overflow-y-auto">
          <div className="p-3 space-y-1">
            {visible.map((article, index) => {
              const isActive = index === safeCursor;
              return (
                <button
                  type="button"
                  key={article.id}
                  onClick={() => { setCursor(index); setError(''); }}
                  data-review-item={isActive ? 'active' : 'idle'}
                  className={`w-full text-left px-3 py-2.5 rounded-lg text-xs transition ${
                    isActive
                      ? 'bg-indigo-600 text-white'
                      : 'text-slate-300 hover:bg-slate-800/80'
                  }`}
                >
                  <div className="font-semibold truncate">{article.title}</div>
                  <div className="text-[10px] opacity-70 mt-0.5">{article.category}</div>
                  {article.aiQualityStatus && (
                    <div className="mt-1">
                      <StatusBadge spec={qualityStatusSpec(article.aiQualityStatus, article.aiQualityDecision, { degraded: article.aiQualityDegraded === true })} lang={lang} className="!text-[10px]" />
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* 右侧：文章详情 */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-4xl mx-auto p-6 space-y-6">
            {/* 标题 */}
            <div>
              <h1 className="text-2xl font-black text-white leading-tight">
                {current.title}
              </h1>
              <div className="flex items-center gap-2 mt-2 text-xs text-slate-400">
                <span>{current.category}</span>
                <span>·</span>
                <span>{current.author}</span>
                <span>·</span>
                <span>{current.createdAt}</span>
              </div>
            </div>

            {/* 摘要 */}
            {current.summary && (
              <div className="p-4 rounded-lg bg-slate-800/40 border border-slate-700">
                <div className="text-xs font-semibold text-slate-400 mb-2">
                  {zh ? '摘要' : 'Summary'}
                </div>
                <div className="text-sm text-slate-300 leading-relaxed">
                  {current.summary}
                </div>
              </div>
            )}

            {/* 质检状态 */}
            {(current.aiQualityStatus || score !== null) && (() => {
              // 只看「判定」：status=completed 只说明跑完了，能不能过要看 decision。
              const verdict = qualityStatusSpec(current.aiQualityStatus, current.aiQualityDecision, { degraded: current.aiQualityDegraded === true });
              const released = releasedIds.includes(current.id) || current.aiQualityIsOverridden === true;
              const needsRelease = verdict.tone === 'warning' && !released && Boolean(onReleaseArticle);
              const toneClass = verdict.tone === 'success'
                ? 'bg-emerald-950/20 border-emerald-500/30'
                : verdict.tone === 'danger'
                  ? 'bg-rose-950/20 border-rose-500/30'
                  : 'bg-amber-950/20 border-amber-500/30';
              const iconClass = verdict.tone === 'success' ? 'text-emerald-400' : verdict.tone === 'danger' ? 'text-rose-400' : 'text-amber-400';
              return (
              <div className={`p-4 rounded-lg border ${toneClass}`}>
                <div className="flex items-start gap-3">
                  <ShieldCheck className={`w-5 h-5 shrink-0 ${iconClass}`} />
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-semibold text-white">
                        {zh ? 'AI 质检' : 'AI Quality'}
                      </span>
                      <span className={`rounded-md border px-2 py-0.5 text-xs font-bold tabular-nums ${scoreTone}`}>
                        {score === null ? (zh ? '无评分' : 'No score') : `${score} ${zh ? '分' : 'pts'}`}
                      </span>
                      <StatusBadge spec={verdict} lang={lang} />
                    </div>
                    {current.aiQualityReason && (
                      <div className="text-xs text-slate-400 mt-2">{current.aiQualityReason}</div>
                    )}
                    {(needsRelease || released) && (
                      <div className="mt-3 space-y-2 border-t border-slate-700/50 pt-3">
                        {released ? (
                          <p className="text-xs text-emerald-300">{zh ? '已人工放行：这篇现在可以通过审核了。' : 'Released manually — approve is now allowed.'}</p>
                        ) : (
                          <>
                            <p className="text-xs leading-relaxed text-amber-200">
                              {zh
                                ? '质检结论是「待人工复核」——直接点「通过审核」会被门禁拒绝。先在这里放行（理由记入审计），再审核。'
                                : 'Verdict is “needs review” — approve will be refused until you release it manually.'}
                            </p>
                            <div className="flex flex-wrap items-center gap-2">
                              <input
                                value={releaseReason}
                                onChange={(event) => setReleaseReason(event.target.value)}
                                placeholder={zh ? '放行理由（必填，会记入审计）' : 'Release reason (required)'}
                                className="h-9 min-w-[220px] flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 text-xs text-white outline-none focus:border-indigo-500"
                              />
                              <button
                                type="button"
                                disabled={busy || releaseReason.trim().length < 4}
                                onClick={() => void handleRelease()}
                                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-amber-600 px-3.5 text-xs font-bold text-white transition hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {zh ? '人工放行' : 'Release'}
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
              );
            })()}

            {/* 正文预览 */}
            <div className="prose prose-invert prose-sm max-w-none">
              <div className="text-xs font-semibold text-slate-400 mb-3">
                {zh ? '正文内容' : 'Content'}
              </div>
              <div className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap">
                {current.content.slice(0, 1000)}
                {current.content.length > 1000 && (
                  <span className="text-slate-500"> ... ({zh ? '已省略' : 'truncated'})</span>
                )}
              </div>
            </div>

            {/* SEO 关键词 */}
            {current.seoKeywords && current.seoKeywords.length > 0 && (
              <div>
                <div className="text-xs font-semibold text-slate-400 mb-2">
                  {zh ? 'SEO 关键词' : 'SEO Keywords'}
                </div>
                <div className="flex flex-wrap gap-2">
                  {current.seoKeywords.map((keyword) => (
                    <span
                      key={keyword}
                      className="px-2 py-1 rounded text-xs bg-slate-800 text-slate-300 border border-slate-700"
                    >
                      {keyword}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* 错误提示 */}
            {error && (
              <div role="alert" className="p-4 rounded-lg bg-rose-950/20 border border-rose-500/30 flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0" />
                <div className="text-sm text-rose-200">{error}</div>
              </div>
            )}

            {/* 操作按钮区 */}
            <div className="sticky bottom-0 -mx-6 -mb-6 p-6 bg-gradient-to-t from-slate-950 via-slate-950/95 to-transparent border-t border-slate-800">
              <div className="flex items-center justify-between gap-4">
                {/* 导航 */}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={goToPrev}
                    disabled={!hasPrev || busy}
                    className="flex items-center gap-1 px-3 py-2 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-300 disabled:opacity-30 disabled:cursor-not-allowed transition"
                  >
                    <ChevronLeft className="w-4 h-4" />
                    <span>{zh ? '上一篇' : 'Prev'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={goToNext}
                    disabled={!hasNext || busy}
                    className="flex items-center gap-1 px-3 py-2 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-300 disabled:opacity-30 disabled:cursor-not-allowed transition"
                  >
                    <span>{zh ? '下一篇' : 'Next'}</span>
                    <ChevronRight className="w-4 h-4" />
                  </button>
                  <span className="ml-1 hidden text-[10px] text-slate-500 sm:inline">
                    {zh ? '↑↓ / J K 翻页' : '↑↓ / J K to move'}
                  </span>
                </div>

                {/* 审核操作 */}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={skip}
                    disabled={busy}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 disabled:opacity-50 transition"
                  >
                    <SkipForward className="w-4 h-4" />
                    <span>{zh ? '跳过' : 'Skip'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleAction('reject')}
                    disabled={busy}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white disabled:opacity-50 transition"
                  >
                    <XCircle className="w-4 h-4" />
                    <span>{zh ? '退回修改' : 'Reject'}</span>
                    <kbd className="ml-0.5 rounded border border-rose-300/40 px-1 text-[10px]">←</kbd>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleAction('approve')}
                    disabled={busy}
                    className="flex items-center gap-1.5 px-5 py-2 rounded-lg text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50 transition shadow-sm"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    <span>{zh ? '通过审核' : 'Approve'}</span>
                    <kbd className="ml-0.5 rounded border border-emerald-300/40 px-1 text-[10px]">→</kbd>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
