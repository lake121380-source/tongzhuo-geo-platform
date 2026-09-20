import React, { useMemo } from 'react';
import { Button, Card, DataTable, EmptyState, TrendChart } from './ui';
import type { DataTableColumn } from './ui';
import { ApiRecord } from '../api/geoflowClient';
import { AlertTriangle, ArrowRight, ScanSearch, TrendingUp } from 'lucide-react';

/**
 * 「数据分析 → AI 可见度」栏目——**见度数据版**（2026-09-20 拍板「替换」）。
 *
 * 数据来自见度GEO 检测系统（经由本系统后端实时拉取，浏览器不直连见度）。
 * 三种状态：
 *  · 未连接 → 引导去「AI 模型与提示词 → 见度对接」完成一次性连接；
 *  · 已连接但有错（连接失效/见度不可达）→ 如实展示原因 + 重连引导；
 *  · 正常 → 提及率/推荐率 KPI、趋势、平台表现、检测批次、检测报告。
 *
 * 口径纪律：见度在零样本时各比率返回字面的 0——后端已翻成 null，这里 null
 * 一律显示「—」（「没测出来」不是「测出来是 0」）。
 */

interface AiVisibilityJianduSectionProps {
  payload: ApiRecord;
  lang: 'zh' | 'en';
  onNavigate?: (tab: string) => void;
}

function asRecord(value: unknown): ApiRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as ApiRecord) : {};
}

function asList(value: unknown): ApiRecord[] {
  return Array.isArray(value) ? value.filter((item): item is ApiRecord => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : [];
}

function pct(value: unknown): string {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${numeric}%` : '—';
}

function count(value: unknown): string {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? String(numeric) : '—';
}

function timeText(value: unknown): string {
  const text = typeof value === 'string' ? value : '';
  if (!text) return '—';
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : parsed.toLocaleString();
}

/** 报告 GEO 分三态（与见度控制台同一套判据）：未启用 / 暂无数据 / 分数。 */
function geoScoreText(row: ApiRecord, zh: boolean): string {
  if (String(row.geo_score_status || '') !== 'final') return zh ? '未启用' : 'n/a';
  const total = Number(row.sampled);
  const score = Number(row.geo_score);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(score)) return zh ? '暂无数据' : 'no data';
  return `${score} / 100`;
}

function statusLabel(status: unknown, zh: boolean): string {
  const labels: Record<string, [string, string]> = {
    completed: ['已完成', 'Completed'],
    partial: ['部分完成', 'Partial'],
    failed: ['失败', 'Failed'],
    cancelled: ['已取消', 'Cancelled'],
    running: ['进行中', 'Running'],
    queued: ['排队中', 'Queued'],
    pending: ['等待中', 'Pending'],
  };
  const value = String(status || '');
  const pair = labels[value];
  if (pair) return zh ? pair[0] : pair[1];
  return value || '—';
}

export const AiVisibilityJianduSection: React.FC<AiVisibilityJianduSectionProps> = ({ payload, lang, onNavigate }) => {
  const zh = lang === 'zh';
  const root = payload;
  const connected = root.connected === true;
  const error = typeof root.error === 'string' && root.error !== '' ? root.error : '';

  const kpis = useMemo(() => asRecord(root.kpis), [root]);
  const trend = useMemo(() => asList(root.trend), [root]);
  const platforms = useMemo(() => asList(root.platforms), [root]);
  const detections = useMemo(() => asList(root.detections), [root]);
  const reports = useMemo(() => asList(root.reports), [root]);
  const quota = useMemo(() => asRecord(root.quota), [root]);
  const project = useMemo(() => asRecord(root.project), [root]);
  const hasSamples = root.has_samples === true;

  // 未连接 → 引导
  if (!connected) {
    return (
      <Card padding={6} className="max-w-2xl">
        <EmptyState
          icon={ScanSearch}
          title={zh ? '连接见度GEO，这里就有真实的 AI 提及率' : 'Connect Jiandu to see real AI mention rates'}
          description={zh
            ? '在「AI 模型与提示词 → 见度对接」里把见度账号登录一次即可——之后这个栏目直接展示见度的提及率、平台表现、检测批次与报告，检测每天自动跑。'
            : 'Sign in once under “Models & Prompts → Jiandu”. This section will then show mention rates, platforms, runs and reports; detection runs daily.'}
          action={(
            <Button variant="primary" icon={ArrowRight} onClick={() => onNavigate?.('ai-models')}>
              {zh ? '去连接见度' : 'Connect Jiandu'}
            </Button>
          )}
        />
      </Card>
    );
  }

  // 已连接但上游出错
  if (error) {
    return (
      <Card padding={5} className="max-w-3xl">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <div className="space-y-3">
            <div>
              <div className="text-sm font-semibold text-white">{zh ? '见度数据暂时取不到' : 'Jiandu data is temporarily unavailable'}</div>
              <p className="mt-1 text-[13px] leading-6 text-slate-400">{error}</p>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" icon={ArrowRight} onClick={() => onNavigate?.('ai-models')}>
                {root.needs_reconnect === true ? (zh ? '重新连接见度' : 'Reconnect Jiandu') : (zh ? '去查看见度对接' : 'Open Jiandu settings')}
              </Button>
            </div>
          </div>
        </div>
      </Card>
    );
  }

  const kpiCards: Array<{ key: string; label: string; value: string }> = [
    { key: 'mention_rate', label: zh ? '提及率' : 'Mention rate', value: pct(kpis.mention_rate) },
    { key: 'recommend_rate', label: zh ? '推荐率' : 'Recommend rate', value: pct(kpis.recommend_rate) },
    { key: 'positive_rate', label: zh ? '正面率' : 'Positive rate', value: pct(kpis.positive_rate) },
    { key: 'geo_score', label: zh ? 'GEO 综合可见度' : 'GEO score', value: count(kpis.geo_score) },
    { key: 'sampled_answers', label: zh ? '样本回答' : 'Answers sampled', value: count(kpis.sampled_answers) },
  ];

  const platformColumns: DataTableColumn<ApiRecord>[] = [
    { key: 'name', header: zh ? '平台' : 'Platform', render: (row) => <span>{String(row.name || '—')}</span> },
    { key: 'mention_rate', header: zh ? '提及率' : 'Mention', render: (row) => <span className="font-semibold tabular-nums text-white">{pct(row.mention_rate)}</span> },
    { key: 'sampled', header: zh ? '样本' : 'Samples', render: (row) => <span className="tabular-nums">{count(row.sampled)}</span> },
  ];

  const detectionColumns: DataTableColumn<ApiRecord>[] = [
    { key: 'created_at', header: zh ? '检测时间' : 'Run time', render: (row) => <span className="text-slate-400">{timeText(row.created_at)}</span> },
    { key: 'status', header: zh ? '状态' : 'Status', render: (row) => <span>{statusLabel(row.status, zh)}</span> },
    { key: 'sampled', header: zh ? '样本' : 'Samples', render: (row) => <span className="tabular-nums">{count(row.sampled)}</span> },
    { key: 'mention_rate', header: zh ? '提及率' : 'Mention', render: (row) => <span className="font-semibold tabular-nums text-white">{pct(row.mention_rate)}</span> },
    { key: 'recommend_rate', header: zh ? '推荐率' : 'Recommend', render: (row) => <span className="tabular-nums">{pct(row.recommend_rate)}</span> },
  ];

  const reportColumns: DataTableColumn<ApiRecord>[] = [
    { key: 'title', header: zh ? '报告' : 'Report', render: (row) => <span className="text-white">{String(row.title || row.id || '—')}</span> },
    { key: 'created_at', header: zh ? '生成时间' : 'Created', render: (row) => <span className="text-slate-400">{timeText(row.created_at)}</span> },
    { key: 'geo_score', header: zh ? 'GEO 分' : 'GEO', render: (row) => <span className="font-semibold tabular-nums text-white">{geoScoreText(row, zh)}</span> },
    { key: 'mention_rate', header: zh ? '提及率' : 'Mention', render: (row) => <span className="tabular-nums">{pct(row.mention_rate)}</span> },
    { key: 'recommend_rate', header: zh ? '推荐率' : 'Recommend', render: (row) => <span className="tabular-nums">{pct(row.recommend_rate)}</span> },
    { key: 'sampled', header: zh ? '样本' : 'Samples', render: (row) => <span className="tabular-nums">{count(row.sampled)}</span> },
  ];

  return (
    <>
      {/* 来源与项目信息条：数据来自见度，可追溯 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-2xl bg-slate-900/80 px-5 py-3.5 text-[13px]">
        <span className="flex items-center gap-2 font-semibold text-white">
          <ScanSearch className="h-4 w-4 text-emerald-400" />
          {zh ? '见度GEO 检测数据' : 'Jiandu detection data'}
        </span>
        <span className="text-slate-300">
          {zh ? '项目' : 'Project'} {String(project.name || project.brand_name || project.id || '—')}
        </span>
        {typeof root.plan_name === 'string' && root.plan_name !== '' && <span className="text-slate-500">{zh ? '套餐' : 'Plan'} {root.plan_name}</span>}
        {Number.isFinite(Number(quota.used)) && Number.isFinite(Number(quota.total)) && (
          <span className="text-slate-500">{zh ? '本月检测' : 'Used'} {count(quota.used)}/{count(quota.total)}</span>
        )}
        <span className="ml-auto text-caption">
          {zh ? '数据来自见度GEO 检测系统' : 'From the Jiandu system'}
          {root.fetched_at ? ` · ${zh ? '拉取于' : 'fetched'} ${timeText(root.fetched_at)}` : ''}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {kpiCards.map((card) => (
          <div key={card.key} className="rounded-2xl bg-slate-900/80 p-5 transition hover:shadow-md">
            <div className="text-caption">{card.label}</div>
            <div className="mt-1.5 text-[24px] font-black leading-none tabular-nums text-white">{card.value}</div>
          </div>
        ))}
      </div>

      {!hasSamples && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[13px] text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{zh
            ? '该项目还没有成功检测样本——指标为「—」表示没有数据，不是 0。检测每天自动跑，也可以到见度系统里手动跑一次。'
            : 'No successful samples yet; "—" means no data, not zero.'}</span>
        </div>
      )}

      <Card>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold text-white">{zh ? '提及率 / 推荐率趋势' : 'Mention & recommend trend'}</h2>
          <span className="text-caption">{zh ? '按天 · 数据来自见度' : 'daily · from Jiandu'}</span>
        </div>
        {trend.length < 2 ? (
          <EmptyState
            compact
            icon={TrendingUp}
            title={zh ? '样本还不足以画趋势' : 'Not enough samples for a trend yet'}
            description={zh ? '至少需要两天、每天有成功检测样本；一个点画不出趋势。' : 'At least two days with samples are needed.'}
          />
        ) : (
          <TrendChart
            labels={trend.map((row) => String(row.date || ''))}
            series={[
              { name: zh ? '提及率' : 'Mention', values: trend.map((row) => (Number.isFinite(Number(row.mention_rate)) ? Number(row.mention_rate) : 0)), tone: 'text-emerald-500' },
              { name: zh ? '推荐率' : 'Recommend', values: trend.map((row) => (Number.isFinite(Number(row.recommend_rate)) ? Number(row.recommend_rate) : 0)), tone: 'text-amber-400' },
            ]}
          />
        )}
      </Card>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Card>
          <h2 className="mb-3 text-sm font-bold text-white">{zh ? '各平台表现' : 'By platform'}</h2>
          {platforms.length === 0 ? (
            <EmptyState compact icon={ScanSearch} title={zh ? '当前时间范围暂无平台数据' : 'No platform data in this range'} description={zh ? '换个时间范围或跑一次检测再看。' : 'Try another range or run a detection.'} />
          ) : (
            <DataTable columns={platformColumns} rows={platforms} rowKey={(row) => String(row.name || Math.random())} dense />
          )}
        </Card>
        <Card>
          <h2 className="mb-3 text-sm font-bold text-white">{zh ? '最近检测批次' : 'Recent detection runs'}</h2>
          {detections.length === 0 ? (
            <EmptyState compact icon={ScanSearch} title={zh ? '还没有检测批次' : 'No detection runs yet'} description={zh ? '检测每天自动跑；也可以在见度系统里手动触发一次。' : 'Runs daily; you can also trigger one in Jiandu.'} />
          ) : (
            <DataTable columns={detectionColumns} rows={detections} rowKey={(row) => String(row.id || Math.random())} dense />
          )}
        </Card>
      </div>

      <Card>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold text-white">{zh ? '检测报告' : 'Detection reports'}</h2>
          <span className="text-caption">{zh ? '来自见度 · 任务完成后自动生成' : 'from Jiandu · created after a run'}</span>
        </div>
        {reports.length === 0 ? (
          <EmptyState compact icon={ScanSearch} title={zh ? '还没有检测报告' : 'No reports yet'} description={zh ? '见度侧检测任务完成后会自动生成报告，这里就能看到。' : 'Reports appear here once a run completes in Jiandu.'} />
        ) : (
          <DataTable columns={reportColumns} rows={reports} rowKey={(row) => String(row.id || Math.random())} dense />
        )}
      </Card>
    </>
  );
};

