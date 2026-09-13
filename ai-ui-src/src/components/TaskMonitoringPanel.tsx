import React, { useCallback, useEffect, useState } from 'react';
import { Activity, Loader2, RefreshCw } from 'lucide-react';
import { ApiRecord } from '../api/geoflowClient';
import { describeApiError } from '../api/permissions';

interface TaskMonitoringPanelProps {
  /** 与 TasksView 既有的 onLoadWorkers 同风格：数据由 App 取，组件只渲染。 */
  onLoadHealth: () => Promise<ApiRecord>;
  onLoadRecentRuns: () => Promise<ApiRecord>;
  lang: 'zh' | 'en';
}

const record = (value: unknown): ApiRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as ApiRecord : {};
const text = (value: unknown): string => (value === undefined || value === null ? '' : String(value));

const RUN_STATUS: Record<string, { zh: string; en: string }> = {
  queued: { zh: '排队', en: 'Queued' },
  running: { zh: '运行中', en: 'Running' },
  completed: { zh: '完成', en: 'Completed' },
  failed: { zh: '失败', en: 'Failed' },
  cancelled: { zh: '取消', en: 'Cancelled' },
};

/**
 * 任务与队列的全局视角。
 *
 * 任务页本身有实时状态，但看不到「队列堵没堵、Worker 在不在、最近整体跑了什么」——
 * 这正是旧后台 `tasks/health-check` 与 `tasks/jobs` 两个页面的作用。退役后不能只剩
 * 「单个任务」的视角，所以这两块并列放在任务页顶部。
 *
 * 数据全部来自服务端的既有查询服务，前端不做二次推断（比如 Worker 是否失联由
 * 服务端的 `is_stale` 判定，不在这里按心跳时间自己算）。
 */
const TaskMonitoringPanel: React.FC<TaskMonitoringPanelProps> = ({ onLoadHealth, onLoadRecentRuns, lang }) => {
  const zh = lang === 'zh';
  const [health, setHealth] = useState<ApiRecord | null>(null);
  const [runs, setRuns] = useState<ApiRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [healthData, runsData] = await Promise.all([onLoadHealth(), onLoadRecentRuns()]);
      setHealth(record(healthData));
      setRuns(Array.isArray(runsData.items) ? (runsData.items as ApiRecord[]).map(record) : []);
    } catch (cause) {
      setError(describeApiError(cause, zh ? '读取队列与运行概览失败' : 'Unable to load queue overview', lang));
    } finally {
      setLoading(false);
    }
  }, [onLoadHealth, onLoadRecentRuns, lang, zh]);

  useEffect(() => { void load(); }, [load]);

  const summary = health ? record(health.task_summary) : {};
  const queue = health ? record(health.queue_overview) : {};
  const workers = health ? (Array.isArray(health.worker_overview) ? health.worker_overview as ApiRecord[] : []) : [];
  const staleWorkers = workers.filter((worker) => worker.is_stale === true).length;

  return (
    <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/80 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-bold text-white">
          <Activity className="h-4 w-4 text-emerald-400" />
          {zh ? '队列与最近运行' : 'Queue & recent runs'}
        </h3>
        <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2.5 py-1.5 text-[11px] text-slate-200 hover:bg-slate-800 disabled:opacity-50">
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />{zh ? '刷新' : 'Refresh'}
        </button>
      </div>

      {error && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">{error}</div>}

      {loading && !health ? (
        <div className="flex min-h-16 items-center justify-center text-xs text-slate-500"><Loader2 className="mr-2 h-4 w-4 animate-spin" />{zh ? '读取中…' : 'Loading…'}</div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              // 键名以 `TaskMonitoringQueryService` 的实际投影为准：任务总数在 `task_summary.total_tasks`，
              // 「运行中」在 `queue_overview.running`（是**队列里正在执行**的，不是「启用中的任务」）。
              // 旧后台 `admin/tasks/index.blade.php` 也是这两个来源、同样的语义，可对照。
              { label: zh ? '任务总数' : 'Tasks', value: summary.total_tasks },
              { label: zh ? '运行中' : 'Running', value: queue.running },
              { label: zh ? '队列积压' : 'Queued', value: queue.pending ?? queue.size ?? queue.waiting },
              { label: zh ? '失联 Worker' : 'Stale workers', value: staleWorkers },
            ].map((tile) => (
              <div key={tile.label} className="rounded-lg border border-slate-800 bg-slate-950/60 p-2">
                <div className="text-[10px] text-slate-500">{tile.label}</div>
                <div className="mt-0.5 text-base font-bold tabular-nums text-white">{tile.value === undefined || tile.value === null ? '—' : String(tile.value)}</div>
              </div>
            ))}
          </div>

          {staleWorkers > 0 && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-950/25 px-3 py-2 text-[11px] text-amber-200">
              {zh ? `${staleWorkers} 个 Worker 心跳已过期——队列可能没人消费。` : `${staleWorkers} worker(s) look stale; the queue may not be consumed.`}
            </div>
          )}

          <div className="space-y-1">
            <div className="text-[11px] font-semibold text-slate-300">{zh ? '最近运行（全部任务）' : 'Recent runs (all tasks)'}</div>
            {runs.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-800 px-3 py-4 text-center text-[11px] text-slate-500">{zh ? '还没有运行记录' : 'No runs yet'}</div>
            ) : (
              <div className="max-h-56 space-y-1 overflow-y-auto pr-1">
                {runs.map((run) => {
                  const status = text(run.status);
                  const task = record(run.task);
                  const article = record(run.article);
                  return (
                    <div key={text(run.id)} className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2 text-[11px]">
                      <span className="min-w-0 flex-1 truncate text-slate-300">
                        {text(task.name) || text(article.title) || `#${text(run.task_id)}`}
                      </span>
                      <span className={status === 'failed' ? 'shrink-0 text-rose-300' : status === 'completed' ? 'shrink-0 text-emerald-300' : 'shrink-0 text-amber-300'}>
                        {RUN_STATUS[status]?.[lang] ?? status}
                      </span>
                      <span className="shrink-0 text-slate-600">{text(run.created_at).slice(5, 16)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
};

export default TaskMonitoringPanel;
