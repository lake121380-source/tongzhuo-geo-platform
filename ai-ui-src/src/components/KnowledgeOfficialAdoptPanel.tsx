import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, PackageCheck } from 'lucide-react';
import { ApiRecord, GeoFlowApiClient } from '../api/geoflowClient';
import { describeApiError } from '../api/permissions';

interface KnowledgeOfficialAdoptPanelProps {
  apiClient: GeoFlowApiClient;
  lang: 'zh' | 'en';
  knowledgeBaseId: string | number;
  canWrite: boolean;
}

const record = (value: unknown): ApiRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as ApiRecord : {};
const text = (value: unknown): string => (value === undefined || value === null ? '' : String(value));

/**
 * 系统知识库的「采纳官方版本」。
 *
 * 产品升级带来新官方内容后**必须走这条**，否则 `system_health` 会一直报「有官方更新可用」。
 * **旧的「恢复历史修订」替代不了**：它只在内容哈希恰好等于绑定记录时才清 `customized_at`，
 * 不刷新 `official_version`——采纳新版本这件事它做不到。
 *
 * 只有系统托管的知识库才渲染这块；普通知识库没有「官方版本」这个概念。
 */
const KnowledgeOfficialAdoptPanel: React.FC<KnowledgeOfficialAdoptPanelProps> = ({
  apiClient, lang, knowledgeBaseId, canWrite,
}) => {
  const zh = lang === 'zh';
  const [item, setItem] = useState<ApiRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await apiClient.getKnowledgeBase(knowledgeBaseId);
      setItem(record(data.item ?? data));
    } catch {
      // 读不到就不渲染这块——它只是详情里的一个附加操作。
      setItem(null);
    }
  }, [apiClient, knowledgeBaseId]);

  useEffect(() => { void load(); }, [load]);

  if (!item || item.is_system_managed !== true) return null;

  const health = record(item.system_health);
  const customized = text(health.customized_at) !== '' || health.customized === true;
  const updateAvailable = health.update_available === true;

  const adopt = async () => {
    if (busy || !canWrite) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await apiClient.adoptKnowledgeBaseOfficial(knowledgeBaseId, { idempotencyKey: `adopt-official-${knowledgeBaseId}-${Date.now()}` });
      setNotice(zh
        ? (result.content_changed === true ? '已采纳当前官方版本，正文已重置；相关文章的 AI 质检结论已作废。' : '已采纳当前官方版本（正文无变化）。')
        : 'Official version adopted.');
      await load();
    } catch (cause) {
      setError(describeApiError(cause, zh ? '采纳官方版本失败' : 'Unable to adopt the official version', lang));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded-xl border border-cyan-500/30 bg-slate-950/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <PackageCheck className="h-3.5 w-3.5 text-cyan-400" />
        <span className="text-xs font-semibold text-slate-200">{zh ? '官方版本' : 'Official version'}</span>
        {updateAvailable
          ? <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-300">{zh ? '有官方更新可用' : 'Update available'}</span>
          : <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">{zh ? '已是最新' : 'Up to date'}</span>}
        {customized && <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">{zh ? '有本地改动' : 'Locally modified'}</span>}
      </div>
      <p className="text-[10px] leading-relaxed text-slate-500">
        {zh
          ? '采纳会把正文重置为随包发布的官方内容，并刷新版本与哈希；正文有变时，按旧内容得出的文章质检结论会一并作废。'
          : 'Adopting resets the content to the bundled official version and refreshes version and hash; if the content changes, existing quality findings are invalidated.'}
      </p>
      {error && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-950/30 px-3 py-2 text-[11px] text-rose-200">{error}</div>}
      {notice && <div className="rounded-lg border border-emerald-500/30 bg-emerald-950/30 px-3 py-2 text-[11px] text-emerald-200">{notice}</div>}
      {canWrite && (
        <button type="button" onClick={() => void adopt()} disabled={busy} className="inline-flex items-center gap-1 rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-cyan-500 disabled:opacity-50">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PackageCheck className="h-3.5 w-3.5" />}{zh ? '采纳官方版本' : 'Adopt official version'}
        </button>
      )}
    </div>
  );
};

export default KnowledgeOfficialAdoptPanel;
