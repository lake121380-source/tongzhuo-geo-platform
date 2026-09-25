import React from 'react';

/**
 * 后端枚举 → 中文状态徽标。
 *
 * 为什么要有这个文件：列表里直接渲染后端字段（`completed` / `limit_reached` /
 * `brand_not_configured`…）是这个后台「用户看不懂」的主要来源之一——枚举值是给机器看的，
 * 不是给运营看的。全部映射集中在这里，页面不要各自翻译。
 *
 * 约定：未知值**原样显示**而不是吞掉（宁可露出一个生词，也不要假装认识它）。
 */

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

const TONE_CLASS: Record<Tone, string> = {
  success: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  warning: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  danger: 'bg-rose-500/10 text-rose-400 border-rose-500/20',
  info: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  neutral: 'bg-slate-800 text-slate-300 border-slate-700',
};

interface BadgeSpec {
  label: { zh: string; en: string };
  tone: Tone;
}

/** 文章生命周期状态（`articles.status`）。 */
export function articleStatusSpec(status: string | undefined): BadgeSpec {
  switch (String(status || '').toLowerCase()) {
    case 'published':
      return { label: { zh: '已发布', en: 'Published' }, tone: 'success' };
    case 'review':
      return { label: { zh: '待审核', en: 'In review' }, tone: 'warning' };
    case 'draft':
      return { label: { zh: '草稿', en: 'Draft' }, tone: 'neutral' };
    default:
      return { label: { zh: status || '未知', en: status || 'Unknown' }, tone: 'neutral' };
  }
}

/**
 * AI 质检徽标。
 *
 * **关键：显示「判定」而不是「跑没跑完」。** 后端把两件事分开存：
 *   - `status`   ：queued / running / completed / failed（这次检查跑完了吗）
 *   - `decision` ：passed / needs_review / blocked（结论是什么）
 * 实测有文章 `status=completed` 但 `decision=needs_review`——只显示「已完成」会让用户
 * 以为通过了，点发布却被门禁拦下（2026-09-14 哥哥报的 bug）。
 * 所以：跑完以后一律按 decision 显示；只有「还没跑完」才显示进行中/排队。
 */
/**
 * 质检状态徽标。
 *
 * `options.degraded` = 这次质检是**抽样**跑的（`inspection_scope=fallback_sampled`），
 * 没有覆盖全文。抽样结果**不能授权发布**（后端 `ArticleAiQualityGate` 会强制转 stale 并
 * 排队全文质检），所以它绝不能显示成绿色的「质检通过」——否则审核人信了绿灯点
 * 「通过终审并上线」，只会在原地吃一个 409。
 */
export function qualityStatusSpec(
  status: string | undefined,
  decision?: string,
  options: { degraded?: boolean } = {},
): BadgeSpec {
  const run = String(status || '').toLowerCase();
  const verdict = String(decision || '').toLowerCase();
  switch (run) {
    case 'failed':
      return { label: { zh: '质检失败', en: 'Check failed' }, tone: 'danger' };
    case 'running':
    case 'processing':
      return { label: { zh: '质检中', en: 'Checking' }, tone: 'info' };
    case 'queued':
    case 'pending':
      return { label: { zh: '待质检', en: 'Queued' }, tone: 'neutral' };
    case 'completed':
      switch (verdict) {
        case 'passed':
          return options.degraded
            ? { label: { zh: '抽样质检通过（未覆盖全文）', en: 'Sampled pass (partial coverage)' }, tone: 'warning' }
            : { label: { zh: '质检通过', en: 'Passed' }, tone: 'success' };
        case 'needs_review':
          return { label: { zh: '待人工复核', en: 'Needs review' }, tone: 'warning' };
        case 'blocked':
          return { label: { zh: '质检未通过', en: 'Blocked' }, tone: 'danger' };
        default:
          return { label: { zh: '已质检', en: 'Checked' }, tone: 'neutral' };
      }
    case '':
      return { label: { zh: '未质检', en: 'Not checked' }, tone: 'neutral' };
    default:
      return { label: { zh: status || '未质检', en: status || 'Not checked' }, tone: 'neutral' };
  }
}

/** 任务作业状态（`tasks.latest_job_status` 等）。 */
export function jobStatusSpec(status: string | undefined): BadgeSpec {
  switch (String(status || '').toLowerCase()) {
    case 'completed':
    case 'succeeded':
      return { label: { zh: '已完成', en: 'Completed' }, tone: 'success' };
    case 'limit_reached':
      return { label: { zh: '已达生成上限', en: 'Limit reached' }, tone: 'warning' };
    case 'failed':
      return { label: { zh: '失败', en: 'Failed' }, tone: 'danger' };
    case 'running':
    case 'processing':
      return { label: { zh: '生成中', en: 'Running' }, tone: 'info' };
    case 'pending':
    case 'queued':
      return { label: { zh: '排队中', en: 'Queued' }, tone: 'neutral' };
    case 'cancelled':
      return { label: { zh: '已取消', en: 'Cancelled' }, tone: 'neutral' };
    case 'idle':
      return { label: { zh: '空闲', en: 'Idle' }, tone: 'neutral' };
    default:
      return { label: { zh: status || '—', en: status || '—' }, tone: 'neutral' };
  }
}

/** 知识库同步状态（mappers 映射出的联合类型：indexed / processing / ready / failed）。 */
export function kbStatusSpec(status: string | undefined): BadgeSpec {
  switch (String(status || '').toLowerCase()) {
    case 'indexed':
    case 'ready':
      return { label: { zh: '已就绪', en: 'Ready' }, tone: 'success' };
    case 'processing':
      return { label: { zh: '同步中', en: 'Syncing' }, tone: 'info' };
    case 'failed':
      return { label: { zh: '同步失败', en: 'Failed' }, tone: 'danger' };
    default:
      return { label: { zh: status || '—', en: status || '—' }, tone: 'neutral' };
  }
}

interface StatusBadgeProps {
  spec: BadgeSpec;
  lang: 'zh' | 'en';
  /** 追加类名（例如加图标时留出间距）。 */
  className?: string;
  icon?: React.ReactNode;
}

/** 统一的圆角徽标。`data-tone` 便于测试与审计定位。 */
export const StatusBadge: React.FC<StatusBadgeProps> = ({ spec, lang, className = '', icon }) => (
  <span
    data-tone={spec.tone}
    className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold ${TONE_CLASS[spec.tone]} ${className}`}
  >
    {icon}
    {lang === 'zh' ? spec.label.zh : spec.label.en}
  </span>
);
