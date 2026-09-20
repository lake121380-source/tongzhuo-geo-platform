import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Wand2,
  XCircle,
} from 'lucide-react';
import { Article } from '../types';
import {
  ApiRecord,
  GeoFlowApiClient,
  GeoFlowApiError,
} from '../api/geoflowClient';
import { mapArticle } from '../api/mappers';
import { useConfirm } from './ui';

interface ArticleQualityPanelProps {
  article: Article;
  apiClient: GeoFlowApiClient;
  lang: 'zh' | 'en';
  /** Called after an apply/rollback mutation has returned an authoritative article. */
  onArticleStateChange?: (article: Article) => void | Promise<void>;
}

type BusyAction = 'refresh' | 'recheck' | 'start' | 'apply' | 'cancel' | 'rollback' | 'override' | null;

function record(value: unknown): ApiRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as ApiRecord
    : {};
}

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

function number(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function bool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return ['true', '1', 'yes', 'on'].includes(text(value).trim().toLowerCase());
}

function qualityFrom(value: unknown): ApiRecord {
  const root = record(value);
  const nested = record(root.ai_quality);
  if (Object.keys(nested).length > 0) {
    return {
      ...nested,
      ...(root.optimization !== undefined ? { optimization: root.optimization } : {}),
    };
  }
  return root;
}

/**
 * 从后端给的可读结论反推判定。
 * 为什么需要：`/ai-quality/status` 是扁平载荷、**不带 decision**，只有 `result_label`
 * （如「AI 质检待人工复核」「质检通过」）——不反推的话，「人工放行」这条路永远不出现。
 */
function decisionFromResultLabel(label: string): string {
  const text = (label || '').trim();
  if (!text) return '';
  if (/待人工复核|待复核|needs review/i.test(text)) return 'needs_review';
  if (/未通过|不通过|禁止|blocked/i.test(text)) return 'blocked';
  if (/通过|passed/i.test(text)) return 'passed';
  return '';
}

function statusLabel(status: string, lang: 'zh' | 'en'): string {
  const labels: Record<string, string> = lang === 'zh'
    ? {
        not_started: '未开始',
        queued: '排队中',
        running: '质检中',
        completed: '已完成',
        failed: '失败',
        stale: '已过期',
        cancelled: '已取消',
      }
    : {
        not_started: 'Not started',
        queued: 'Queued',
        running: 'Inspecting',
        completed: 'Completed',
        failed: 'Failed',
        stale: 'Stale',
        cancelled: 'Cancelled',
      };
  return labels[status] || status || (lang === 'zh' ? '未知' : 'Unknown');
}

function optimizationLabel(status: string, lang: 'zh' | 'en'): string {
  const labels: Record<string, string> = lang === 'zh'
    ? {
        awaiting_quality: '等待质检结果',
        queued: '优化排队中',
        planning: '制定优化方案',
        rewriting: '生成优化候选',
        validating: '验证候选修改',
        evaluating: '评估候选质量',
        candidate_ready: '候选已就绪',
        applying: '应用候选中',
        completed: '优化已应用',
        needs_review: '等待人工确认',
        failed: '优化失败',
        stale: '优化已过期',
        cancelled: '优化已取消',
      }
    : {
        awaiting_quality: 'Waiting for quality check',
        queued: 'Optimization queued',
        planning: 'Planning changes',
        rewriting: 'Writing candidate',
        validating: 'Validating candidate',
        evaluating: 'Evaluating candidate',
        candidate_ready: 'Candidate ready',
        applying: 'Applying candidate',
        completed: 'Optimization applied',
        needs_review: 'Needs review',
        failed: 'Optimization failed',
        stale: 'Optimization stale',
        cancelled: 'Optimization cancelled',
      };
  return labels[status] || status || (lang === 'zh' ? '暂无优化运行' : 'No optimization run');
}

function actionError(error: unknown, fallback: string): string {
  if (error instanceof GeoFlowApiError) {
    const details = error.details;
    const fieldErrors = details && typeof details.field_errors === 'object'
      ? Object.values(details.field_errors as Record<string, unknown>).map(String).join('；')
      : '';
    return fieldErrors || error.message || fallback;
  }
  return error instanceof Error ? error.message : fallback;
}

export const ArticleQualityPanel: React.FC<ArticleQualityPanelProps> = ({
  article,
  apiClient,
  lang,
  onArticleStateChange,
}) => {
  const [snapshot, setSnapshot] = useState<ApiRecord | null>(null);
  const confirmDialog = useConfirm();
  const [candidate, setCandidate] = useState<ApiRecord | null>(null);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 人工放行必须填理由（后端会记入审计）。 */
  const [overrideReason, setOverrideReason] = useState('');
  /** 本次会话里已放行成功（外壳不一定把新投影回灌到弹窗，本地先收起来）。 */
  const [releasedLocally, setReleasedLocally] = useState(false);
  const [strategy, setStrategy] = useState<'pass' | 'excellent_80' | 'excellent_90'>('excellent_80');
  const candidateKey = useRef('');
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  const clearPoll = useCallback(() => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = null;
  }, []);

  const applyArticleRecord = useCallback(async (value: unknown) => {
    if (!onArticleStateChange) return;
    const mapped = mapArticle(record(value));
    if (mapped.id) await onArticleStateChange(mapped);
  }, [onArticleStateChange]);

  const refresh = useCallback(async (action: BusyAction = 'refresh'): Promise<ApiRecord | null> => {
    if (!mounted.current) return null;
    if (action !== null) setBusy(action);
    setError(null);
    try {
      const next = record(await apiClient.articleQualityStatus(article.id));
      if (!mounted.current) return next;
      setSnapshot(next);

      const optimization = record(next.optimization);
      const runId = number(optimization.run_id);
      const canPreview = bool(optimization.can_preview);
      const candidateHash = text(optimization.candidate_hash);
      const nextCandidateKey = runId && canPreview ? `${runId}:${candidateHash}` : '';
      if (!nextCandidateKey) {
        candidateKey.current = '';
        setCandidate(null);
      } else if (candidateKey.current !== nextCandidateKey || !candidate) {
        try {
          const loaded = await apiClient.articleOptimizationCandidate(article.id, runId);
          if (mounted.current) {
            setCandidate(record(loaded));
            candidateKey.current = nextCandidateKey;
          }
        } catch (candidateError) {
          // A worker can expose can_preview shortly before the candidate row is
          // committed. Leave the key empty so the next poll retries the read.
          candidateKey.current = '';
          if (mounted.current && !(candidateError instanceof GeoFlowApiError && candidateError.status === 409)) {
            setError(actionError(candidateError, lang === 'zh' ? '读取优化候选失败' : 'Unable to load optimization candidate'));
          }
        }
      }
      return next;
    } catch (refreshError) {
      if (mounted.current) setError(actionError(refreshError, lang === 'zh' ? '读取 AI 质检状态失败' : 'Unable to load AI quality status'));
      throw refreshError;
    } finally {
      if (mounted.current && action !== null) setBusy(null);
    }
  }, [apiClient, article.id, lang]);

  useEffect(() => {
    mounted.current = true;
    candidateKey.current = '';
    setSnapshot(null);
    setCandidate(null);
    setError(null);
    setNotice(null);
    void refresh(null).catch(() => undefined);
    return () => {
      mounted.current = false;
      clearPoll();
    };
  }, [article.id, clearPoll, refresh]);

  const quality = useMemo(() => {
    const fromSnapshot = qualityFrom(snapshot);
    if (Object.keys(fromSnapshot).length > 0) return fromSnapshot;
    return qualityFrom(article.aiQuality);
  }, [article.aiQuality, snapshot]);
  const optimization = useMemo(() => {
    const fromSnapshot = record(snapshot?.optimization);
    if (Object.keys(fromSnapshot).length > 0) return fromSnapshot;
    return record(article.aiOptimization);
  }, [article.aiOptimization, snapshot]);

  useEffect(() => {
    clearPoll();
    /*
     * 轮询必须同时覆盖「质检进行中」和「优化进行中」。
     *
     * 原先这里只看 `optimization` —— 于是点「重新质检」后，面板抓到一次进度
     * （比如 18%）就**再也不刷新**，而质检实际上十几秒就跑完了。
     * 用户看到的是进度条卡住不动 = 「质检好慢」；提交时的提示还写着
     * 「结果会自动更新」，等于给了一个不会兑现的承诺。
     */
    const currentQualityStatus = text(quality.effective_status || quality.status).toLowerCase();
    const qualityInProgress = ['queued', 'running', 'pending', 'checking'].includes(currentQualityStatus);
    const optimizationInProgress = bool(optimization.active) || bool(optimization.should_poll);
    const active = qualityInProgress || optimizationInProgress;
    if (!active || !mounted.current) return undefined;
    const delay = Math.max(1500, number(snapshot?.next_poll_ms) || 2500);
    pollTimer.current = setTimeout(() => {
      void refresh(null).catch(() => undefined);
    }, delay);
    return clearPoll;
  }, [clearPoll, optimization, quality, refresh, snapshot?.next_poll_ms]);

  const configVersion = number(quality.config_version) || article.aiQualityConfigVersion || 0;
  const qualityStatus = text(quality.effective_status || quality.status).toLowerCase();
  // 分数同理：`/ai-quality/status` 不带 score，文章投影才有（article.aiQualityScore）。
  const qualityScore = number(quality.score) ?? article.aiQualityScore ?? null;
  const qualityProgress = Math.max(0, Math.min(100, number(snapshot?.progress_percent) || 0));
  const optimizationStatus = text(optimization.status).toLowerCase();
  const runId = number(optimization.run_id);
  const candidateHash = text(optimization.candidate_hash || candidate?.candidate_hash);
  const canPublishQuality = !apiClient.session?.scopes?.length
    || apiClient.session.scopes.includes('articles:publish')
    || apiClient.session.scopes.includes('*');

  /**
   * 「跑完了」与「结论是什么」必须分开显示（2026-09-14 哥哥报的 bug：
   * status=completed 显示成「已完成」，用户以为通过，点发布却被门禁拦下）。
   * 结论优先用后端给的 `result_label`；没有才按 decision 兜底。
   */
  const qualityDecision = (
    text(article.aiQualityDecision)
    || decisionFromResultLabel(text(quality.result_label) || text(article.aiQualityResultLabel))
    || text(quality.decision)
  ).toLowerCase();
  const qualityVerdictLabel = (() => {
    if (qualityStatus !== 'completed') return statusLabel(qualityStatus, lang);
    const backendLabel = text(quality.result_label);
    if (backendLabel) return backendLabel;
    if (qualityDecision === 'passed') return lang === 'zh' ? '质检通过' : 'Passed';
    if (qualityDecision === 'needs_review') return lang === 'zh' ? '待人工复核' : 'Needs review';
    if (qualityDecision === 'blocked') return lang === 'zh' ? '质检未通过' : 'Blocked';
    return lang === 'zh' ? '已质检' : 'Checked';
  })();
  // `/ai-quality/status` 是**扁平**载荷（没有 decision / is_overridden / 放行线），
  // 这些只在文章投影里 —— 所以以 article.* 为准，状态载荷只作兜底。
  const qualityIsOverridden = article.aiQualityIsOverridden ?? bool(quality.is_overridden);
  /**
   * 为什么要人工放行——**按门禁的真实依据说**。
   *
   * 后端自动放行的条件是「整篇覆盖（coverage_meta 标记 safe_for_auto_release）+ 分数过线 + 无门禁原因」，
   * 分数只是其中一项。实测本部署 9 条质检 `coverage_meta` 全为空、`decision=passed` 为 0 条——
   * 也就是说**自动放行不可达，任何文章都要人工放行**。原来界面只写「分数 100 / 放行线 70」，
   * 把原因归到了分数上，看着就像逻辑错误（2026-09-14 哥哥指出）。
   */
  const manualReviewReason = (() => {
    const gateReasons = Array.isArray(quality.gate_reasons) ? (quality.gate_reasons as unknown[]).map(String) : [];
    const coverage = quality.coverage;
    const coverageEmpty = !coverage
      || (Array.isArray(coverage) ? coverage.length === 0 : (typeof coverage === 'object' && Object.keys(coverage as Record<string, unknown>).length === 0));
    const scope = text(quality.inspection_scope).toLowerCase();
    const passLine = article.aiQualityPassScore ?? number(quality.pass_score);
    if (scope === 'fallback_sampled') {
      return lang === 'zh'
        ? '本次质检是「抽样降级」执行——没有覆盖全文，所以不自动放行。'
        : 'This check ran in sampled fallback mode, so it is not auto-released.';
    }
    if (gateReasons.length > 0) {
      return lang === 'zh' ? `门禁判定原因：${gateReasons.join('、')}。` : `Gate reasons: ${gateReasons.join(', ')}.`;
    }
    if (coverageEmpty) {
      return lang === 'zh'
        ? '本次质检没有产出覆盖度记录，门禁无法确认它覆盖了全文，因此不自动放行——这一条与分数无关。'
        : 'This check produced no coverage record, so the gate cannot auto-release it regardless of score.';
    }
    // 知识库证据不足是**策略性**的人工复核理由（scorer 的 requiresManualReview 之一）：
    // 没有可核验的知识库证据时，文章不自动放行——这条与覆盖度、分数都无关，必须单独说。
    // ⚠️ `knowledge_coverage` **不在** `/ai-quality/status` 的扁平载荷里，只在文章投影里——
    // 从状态载荷读会静默拿到空串，这条分支就永远命中不了（本轮第二次栽在这个坑上）。
    const rawQuality = (article.aiQuality || {}) as Record<string, unknown>;
    const evidenceCoverage = (text(rawQuality.knowledge_coverage) || text(quality.knowledge_coverage)).toLowerCase();
    if (evidenceCoverage === 'insufficient' || evidenceCoverage === 'partial') {
      // 出路要写清楚：这种"不自动放行"是可以用动作解决的（换库/补内容），不是只能人工放行。
      const usedKb = (Array.isArray((article as unknown as { knowledgeBases?: unknown }).knowledgeBases)
        ? ''
        : '');
      return lang === 'zh'
        ? `本次质检在所选知识库里没找到能支撑这篇文章的资料（知识库覆盖不足），按策略不能自动放行——与分数无关。${usedKb}想让高分文章自动通过：换一个与该标题更匹配的知识库、或往知识库里补上对应资料，再点「重新质检」。`
        : 'No usable knowledge-base evidence was found for this article, so auto-release is disabled by policy. Use a better-matching knowledge base or add the source material, then re-check.';
    }
    if (passLine !== null && (qualityScore ?? 0) < passLine) {
      return lang === 'zh' ? `分数未达自动通过线（${passLine}）。` : `Score is below the auto-pass line (${passLine}).`;
    }
    return lang === 'zh' ? '自动放行条件未满足（要求整篇覆盖且无门禁原因）。' : 'Auto-release conditions were not met.';
  })();
  const overrideMinScore = article.aiQualityOverrideMinScore ?? number(quality.manual_override_min_score) ?? 70;
  const passScore = article.aiQualityPassScore ?? number(quality.pass_score);
  /** 能不能人工放行：只有「跑完 + 待人工复核 + 未放行过 + 分数够」才有这条路。 */
  const canOverride = qualityStatus === 'completed'
    && qualityDecision === 'needs_review'
    && !qualityIsOverridden
    && (qualityScore ?? 0) >= overrideMinScore
    && canPublishQuality;
  const articleIsDraft = text(article.apiStatus || article.status).toLowerCase() === 'draft'
    || article.status === 'review';
  const activeOptimization = bool(optimization.active);
  const modifications = Array.isArray(candidate?.modifications)
    ? candidate?.modifications as unknown[]
    : [];

  const run = async (
    action: Exclude<BusyAction, 'refresh' | null>,
    operation: () => Promise<unknown>,
    success: string,
  ) => {
    if (busy || !canPublishQuality) return;
    setBusy(action);
    setError(null);
    setNotice(null);
    try {
      const result = await operation();
      // Apply/rollback already mutate the article server-side. Fetch the
      // authoritative projection and update the shell without issuing a
      // second PATCH request.
      if (action === 'apply' || action === 'rollback' || action === 'override') {
        const updated = await apiClient.getArticle(article.id);
        await applyArticleRecord(updated);
      }
      await refresh(null);
      if (mounted.current) setNotice(success);
      return result;
    } catch (runError) {
      if (mounted.current) setError(actionError(runError, lang === 'zh' ? '操作失败，请稍后重试' : 'Action failed. Please retry.'));
      throw runError;
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const handleRecheck = async () => {
    let resolvedConfigVersion = configVersion;
    if (!resolvedConfigVersion) {
      // List projections may intentionally omit the optimistic-concurrency
      // version. Resolve it from the detail endpoint before rejecting the
      // operator action; the server still remains the final authority.
      try {
        const detail = mapArticle(await apiClient.getArticle(article.id));
        resolvedConfigVersion = detail.aiQualityConfigVersion || 0;
      } catch (detailError) {
        setError(actionError(detailError, lang === 'zh' ? '无法读取文章质检配置版本。' : 'Unable to read the article quality configuration version.'));
        return;
      }
    }
    if (!resolvedConfigVersion) {
      setError(lang === 'zh' ? '缺少 AI 质检配置版本，无法安全复检。' : 'The AI quality configuration version is unavailable for a safe recheck.');
      return;
    }
    await run(
      'recheck',
      () => apiClient.recheckArticleQuality(article.id, resolvedConfigVersion),
      lang === 'zh' ? '已重新提交 AI 质检，结果会自动更新。' : 'The AI quality check was queued and will update automatically.',
    );
  };

  const handleOverride = async () => {
    const reason = overrideReason.trim();
    if (!reason) {
      setError(lang === 'zh' ? '请先填写放行理由（会记入审计记录）。' : 'Enter a reason first (it is recorded in the audit trail).');
      return;
    }
    await run(
      'override',
      () => apiClient.overrideArticleAiQuality(article.id, reason),
      lang === 'zh'
        ? '已人工放行：理由已记入审计，这篇文章现在可以发布了。'
        : 'Released manually; the reason was recorded and the article can be published.',
    );
    setOverrideReason('');
    setReleasedLocally(true);
  };

  const handleStart = async () => {
    await run(
      'start',
      () => apiClient.startArticleOptimization(article.id, strategy),
      lang === 'zh' ? 'AI 优化已入队，候选生成后会显示在这里。' : 'AI optimization was queued; the candidate will appear here when ready.',
    );
  };

  const handleApply = async () => {
    if (!runId || !candidateHash) {
      setError(lang === 'zh' ? '优化候选尚未准备好，无法应用。' : 'The optimization candidate is not ready to apply.');
      return;
    }
    if (!(await confirmDialog({
      title: lang === 'zh' ? '应用候选修改？' : 'Apply this candidate?',
      description: lang === 'zh' ? '会修改文章正文，并保留可回滚记录。' : 'The article body changes; a rollback record is kept.',
      confirmLabel: lang === 'zh' ? '应用' : 'Apply',
      tone: 'primary',
    }))) return;
    await run(
      'apply',
      () => apiClient.applyArticleOptimization(article.id, runId, candidateHash),
      lang === 'zh' ? '优化候选已应用，文章内容已刷新。' : 'The optimization candidate was applied and the article was refreshed.',
    );
  };

  const handleCancel = async () => {
    if (!runId) return;
    await run(
      'cancel',
      () => apiClient.cancelArticleOptimization(article.id, runId),
      lang === 'zh' ? '优化运行已取消。' : 'The optimization run was cancelled.',
    );
  };

  const handleRollback = async () => {
    if (!runId) return;
    if (!(await confirmDialog({
      title: lang === 'zh' ? '回滚到优化前的版本？' : 'Roll back to the pre-optimization version?',
      description: lang === 'zh' ? '当前正文会恢复到优化前的状态。' : 'The article returns to its state before the optimization.',
      confirmLabel: lang === 'zh' ? '回滚' : 'Roll back',
      tone: 'danger',
    }))) return;
    await run(
      'rollback',
      () => apiClient.rollbackArticleOptimization(article.id, runId),
      lang === 'zh' ? '文章已回滚到优化前版本。' : 'The article was rolled back to its pre-optimization version.',
    );
  };

  const scoreTone = qualityScore === null
    ? 'text-slate-300 border-slate-700 bg-slate-800/60'
    : qualityScore >= 85
      ? 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10'
      : qualityScore >= 70
        ? 'text-amber-300 border-amber-500/30 bg-amber-500/10'
        : 'text-rose-300 border-rose-500/30 bg-rose-500/10';
  const qualityIcon = ['failed', 'stale'].includes(qualityStatus)
    ? <XCircle className="h-4 w-4 text-rose-400" />
    : qualityStatus === 'completed'
      ? <CheckCircle2 className="h-4 w-4 text-emerald-400" />
      : <Clock3 className="h-4 w-4 text-amber-400" />;

  return (
    <section className="space-y-4 rounded-2xl border border-slate-800 bg-slate-950/50 p-4" aria-label={lang === 'zh' ? 'AI 质检与优化' : 'AI quality and optimization'}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-bold text-white">
            <ShieldCheck className="h-4 w-4 text-red-400" />
            <span>{lang === 'zh' ? '桐灼GEO AI 质检与优化' : '桐灼GEO AI Quality & Optimization'}</span>
          </div>
          <p className="mt-1 text-[11px] leading-5 text-slate-400">
            {lang === 'zh'
              ? '结果由服务端质量门禁、知识证据和模型策略生成；页面不会使用本地评分替代后端结果。'
              : 'Results come from the server-side quality gate, evidence and model policy; no local score is used in API mode.'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh('refresh').catch(() => undefined)}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-[11px] font-semibold text-slate-200 transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === 'refresh' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          <span>{lang === 'zh' ? '刷新状态' : 'Refresh'}</span>
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className={`rounded-xl border p-3 ${scoreTone}`}>
          <div className="flex items-center justify-between text-[11px] font-semibold text-slate-400">
            <span>{lang === 'zh' ? '最新质检' : 'Latest quality check'}</span>
            {qualityIcon}
          </div>
          <div className="mt-2 text-sm font-bold" data-quality-verdict={qualityStatus === 'completed' ? (qualityDecision || 'completed') : qualityStatus}>
            {qualityVerdictLabel}
          </div>
          {qualityScore !== null && (
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className="text-2xl font-black text-white">{qualityScore}</span>
              <span className="text-[11px] font-medium text-slate-400">
                /100{passScore !== null ? `${lang === 'zh' ? ' · 通过线 ' : ' · pass '}${passScore}` : ''}
              </span>
            </div>
          )}
          {bool(snapshot?.active) && (
            <div className="mt-2 space-y-1">
              <div className="flex justify-between text-[10px] text-slate-400"><span>{text(snapshot?.phase) || (lang === 'zh' ? '处理中' : 'Working')}</span><span>{qualityProgress}%</span></div>
              <div className="h-1.5 overflow-hidden rounded-full bg-slate-800"><div className="h-full rounded-full bg-red-500 transition-all" style={{ width: `${qualityProgress}%` }} /></div>
            </div>
          )}
          {text(quality.summary) && <p className="mt-2 line-clamp-3 text-[11.5px] leading-5 text-slate-400">{text(quality.summary)}</p>}
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3 sm:col-span-2">
          <div className="flex items-center justify-between gap-2 text-[11px] font-semibold text-slate-400">
            <span>{lang === 'zh' ? '优化运行' : 'Optimization run'}</span>
            {optimizationStatus && <span className="rounded-full border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 text-blue-300">{optimizationLabel(optimizationStatus, lang)}</span>}
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
            <div><span className="text-slate-500">{lang === 'zh' ? '优化前' : 'Before'}：</span><span className="font-semibold text-slate-200">{number(candidate?.before_score ?? optimization.before_score) ?? '—'}</span></div>
            <div><span className="text-slate-500">{lang === 'zh' ? '候选后' : 'After'}：</span><span className="font-semibold text-slate-200">{number(candidate?.after_score ?? optimization.best_score) ?? '—'}</span></div>
            <div className="col-span-2 text-[10px] text-slate-500">{runId ? `Run #${runId}` : (lang === 'zh' ? '尚未启动优化运行' : 'No optimization run yet')}</div>
          </div>
          {text(optimization.stop_reason || optimization.error_code) && <p className="mt-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-2 py-1.5 text-[10px] text-amber-200">{text(optimization.stop_reason || optimization.error_code)}</p>}
        </div>
      </div>

      {/* 人工放行：后端有这条路（POST ai-quality/override），但界面从来没暴露过——
          于是「判定=待人工复核」的文章在界面上是**死胡同**：不能发布、也没有任何提示说该怎么办。 */}
      {qualityStatus === 'completed' && qualityDecision === 'needs_review' && !qualityIsOverridden && !releasedLocally && (
        <div
          data-quality-release
          className="space-y-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-3.5"
        >
          <div className="text-[13px] font-semibold text-white">
            {lang === 'zh' ? '这篇需要你人工放行，才能发布' : 'This article needs a manual release before publishing'}
          </div>
          <p className="text-[12.5px] leading-relaxed text-slate-200">
            {lang === 'zh'
              ? `质检跑完了，结论是「待人工复核」。原因：${manualReviewReason}本篇 ${qualityScore ?? '—'} 分（人工放行线 ${overrideMinScore} 分）。填写理由放行后即可发布，理由会记入审计。`
              : `Verdict: needs review. ${manualReviewReason} Manual release requires a recorded reason.`}
          </p>
          {canOverride ? (
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={overrideReason}
                onChange={(event) => setOverrideReason(event.target.value)}
                placeholder={lang === 'zh' ? '放行理由（必填，会记入审计）' : 'Release reason (required)'}
                className="h-9 min-w-[240px] flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 text-[12.5px] text-white outline-none focus:border-indigo-500"
              />
              <button
                type="button"
                disabled={busy !== null || overrideReason.trim() === ''}
                onClick={() => void handleOverride()}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-amber-600 px-3.5 text-[12.5px] font-bold text-white transition hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy === 'override' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                {lang === 'zh' ? '人工放行' : 'Release'}
              </button>
            </div>
          ) : (
            <p className="text-[12.5px] leading-relaxed text-amber-200">
              {lang === 'zh'
                ? `${manualReviewReason}分数也低于人工放行线（本篇 ${qualityScore ?? '—'} / 放行线 ${overrideMinScore}），所以不能直接放行：请点「启动 AI 优化」让模型重写后重新质检，或编辑文章补全证据。`
                : `${manualReviewReason} The score is also below the manual release threshold (${overrideMinScore}).`}
            </p>
          )}
        </div>
      )}

      {qualityIsOverridden && (
        <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] px-3.5 py-3 text-[12.5px] text-emerald-200">
          {/* 放行信息（谁、何时、为什么）只在**文章投影**里；状态接口是扁平载荷、没有这些字段，
              所以以 article.aiQuality 为准（否则提示里会出现「（— · ）：」这种空值）。 */}
          {(() => {
            const raw = (article.aiQuality || {}) as Record<string, unknown>;
            const by = text(raw.overridden_by_name) || text(quality.overridden_by_name);
            const at = text(raw.overridden_at) || text(quality.overridden_at);
            const reasonText = text(raw.override_reason) || text(quality.override_reason);
            if (!by && !reasonText) {
              return lang === 'zh' ? '已人工放行：这篇文章可以发布了。' : 'Released manually; this article can now be published.';
            }
            return lang === 'zh'
              ? `已人工放行${by ? `（${by}${at ? ` · ${at}` : ''}）` : ''}：${reasonText || '—'}`
              : `Released manually${by ? ` by ${by}` : ''}: ${reasonText || '—'}`;
          })()}
        </div>
      )}

      {candidate && (
        <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-xs font-bold text-blue-200"><Sparkles className="h-3.5 w-3.5" />{lang === 'zh' ? '候选修改预览' : 'Candidate preview'}</div>
            <span className="text-[10px] text-slate-400">{modifications.length} {lang === 'zh' ? '处修改' : 'changes'}</span>
          </div>
          {modifications.length > 0 ? (
            <div className="mt-3 space-y-2">
              {modifications.slice(0, 5).map((item, index) => {
                const modification = record(item);
                return (
                  <details key={`${text(modification.field)}-${index}`} className="rounded-lg border border-slate-800 bg-slate-950/70 p-2 text-[10px] text-slate-300">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-2 font-semibold text-slate-200"><span>{text(modification.field) || 'content'} · {text(modification.reason) || (lang === 'zh' ? '服务端候选修改' : 'Server candidate change')}</span><ChevronDown className="h-3 w-3 text-slate-500" /></summary>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2"><div className="rounded bg-rose-950/30 p-2 text-rose-200"><div className="mb-1 text-[9px] uppercase text-rose-400">{lang === 'zh' ? '修改前' : 'Before'}</div>{text(modification.before_text) || '—'}</div><div className="rounded bg-emerald-950/30 p-2 text-emerald-200"><div className="mb-1 text-[9px] uppercase text-emerald-400">{lang === 'zh' ? '修改后' : 'After'}</div>{text(modification.after_text) || '—'}</div></div>
                  </details>
                );
              })}
            </div>
          ) : <p className="mt-2 text-[11px] text-slate-400">{lang === 'zh' ? '服务端没有返回可展示的修改明细。' : 'The server returned no displayable change details.'}</p>}
        </div>
      )}

      {(error || notice) && (
        <div role={error ? 'alert' : 'status'} aria-live="polite" className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-[11px] ${error ? 'border-rose-500/30 bg-rose-950/30 text-rose-200' : 'border-emerald-500/30 bg-emerald-950/30 text-emerald-200'}`}>
          {error ? <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
          <span>{error || notice}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-slate-800 pt-3">
        <button
          type="button"
          onClick={() => void handleRecheck().catch(() => undefined)}
          disabled={busy !== null || !canPublishQuality || !configVersion || activeOptimization}
          title={!canPublishQuality ? (lang === 'zh' ? '当前 Token 缺少 articles:publish 权限' : 'Token lacks articles:publish scope') : undefined}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-[11px] font-bold text-slate-200 transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === 'recheck' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          <span>{lang === 'zh' ? '重新质检' : 'Recheck quality'}</span>
        </button>

        <label className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-[10px] text-slate-400">
          <span>{lang === 'zh' ? '策略' : 'Strategy'}</span>
          <select value={strategy} onChange={(event) => setStrategy(event.target.value as typeof strategy)} disabled={busy !== null || activeOptimization || !articleIsDraft || !canPublishQuality} className="bg-transparent text-[11px] font-semibold text-slate-200 outline-none">
            <option value="pass">{lang === 'zh' ? '达到通过线' : 'Pass threshold'}</option>
            <option value="excellent_80">{lang === 'zh' ? '优秀 80' : 'Excellent 80'}</option>
            <option value="excellent_90">{lang === 'zh' ? '优秀 90' : 'Excellent 90'}</option>
          </select>
        </label>

        <button
          type="button"
          onClick={() => void handleStart().catch(() => undefined)}
          disabled={busy !== null || !canPublishQuality || !articleIsDraft || activeOptimization}
          title={!articleIsDraft ? (lang === 'zh' ? '只有草稿文章可以启动优化' : 'Only draft articles can be optimized') : undefined}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-[11px] font-bold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === 'start' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
          <span>{lang === 'zh' ? '启动 AI 优化' : 'Start AI optimization'}</span>
        </button>

        {bool(optimization.can_apply) && candidateHash && runId && (
          <button type="button" onClick={() => void handleApply().catch(() => undefined)} disabled={busy !== null || !canPublishQuality} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-[11px] font-bold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50">
            {busy === 'apply' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            <span>{lang === 'zh' ? '应用候选' : 'Apply candidate'}</span>
          </button>
        )}

        {bool(optimization.can_cancel) && runId && (
          <button type="button" onClick={() => void handleCancel().catch(() => undefined)} disabled={busy !== null || !canPublishQuality} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-[11px] font-bold text-slate-200 transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50">
            {busy === 'cancel' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
            <span>{lang === 'zh' ? '取消优化' : 'Cancel'}</span>
          </button>
        )}

        {bool(optimization.can_rollback) && runId && (
          <button type="button" onClick={() => void handleRollback().catch(() => undefined)} disabled={busy !== null || !canPublishQuality} className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] font-bold text-amber-200 transition hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-50">
            {busy === 'rollback' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
            <span>{lang === 'zh' ? '回滚优化' : 'Rollback'}</span>
          </button>
        )}
      </div>

      {!canPublishQuality && <p className="text-[10px] text-amber-300">{lang === 'zh' ? '当前登录 Token 没有 articles:publish 权限，质检写入与优化操作已禁用。' : 'The current token lacks articles:publish; quality mutations and optimization are disabled.'}</p>}
    </section>
  );
};
