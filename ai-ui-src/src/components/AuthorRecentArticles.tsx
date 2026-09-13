import React, { useEffect, useState } from 'react';
import { FileText, Loader2 } from 'lucide-react';
import { ApiRecord, GeoFlowApiClient } from '../api/geoflowClient';
import { describeApiError } from '../api/permissions';

interface AuthorRecentArticlesProps {
  apiClient: GeoFlowApiClient;
  lang: 'zh' | 'en';
  authorId: string | number;
}

const STATUS_LABELS: Record<string, { zh: string; en: string }> = {
  draft: { zh: '草稿', en: 'Draft' },
  pending: { zh: '待审', en: 'Pending' },
  published: { zh: '已发布', en: 'Published' },
  offline: { zh: '已下线', en: 'Offline' },
};

function text(record: ApiRecord, key: string): string {
  const value = record[key];
  return value === undefined || value === null ? '' : String(value);
}

/**
 * 某作者最近的文章。
 *
 * 与旧后台作者详情页同一口径：最近 10 篇、**不含回收站**。默认条数由服务端给，
 * 前端不自己写死一个数——否则「页面显示 10 篇、这里显示 20 篇」就会对不上。
 */
const AuthorRecentArticles: React.FC<AuthorRecentArticlesProps> = ({ apiClient, lang, authorId }) => {
  const zh = lang === 'zh';
  const [articles, setArticles] = useState<ApiRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    void apiClient.listAuthorArticles(authorId)
      .then((data) => {
        if (!cancelled) setArticles(Array.isArray(data.articles) ? (data.articles as ApiRecord[]) : []);
      })
      .catch((loadError) => {
        if (!cancelled) setError(describeApiError(loadError, zh ? '读取最近文章失败' : 'Unable to load recent articles', lang));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [apiClient, authorId, lang, zh]);

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
      <div className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
        <FileText className="h-3.5 w-3.5 text-indigo-400" />
        {zh ? '最近文章' : 'Recent articles'}
      </div>
      {error && <div role="alert" className="mt-2 rounded-lg border border-rose-500/30 bg-rose-950/30 px-3 py-2 text-[11px] text-rose-200">{error}</div>}
      {loading ? (
        <div className="mt-2 flex items-center gap-2 text-[11px] text-slate-500"><Loader2 className="h-3.5 w-3.5 animate-spin" />{zh ? '读取中…' : 'Loading…'}</div>
      ) : articles.length === 0 ? (
        <div className="mt-2 text-[11px] text-slate-500">{zh ? '该作者还没有文章' : 'This author has no articles yet'}</div>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {articles.map((article) => {
            const status = text(article, 'status');
            return (
              <li key={text(article, 'id')} className="flex items-start justify-between gap-2 text-[11px]">
                <span className="min-w-0 flex-1 truncate text-slate-300">{text(article, 'title') || `#${text(article, 'id')}`}</span>
                <span className="shrink-0 text-slate-500">{STATUS_LABELS[status]?.[lang] ?? status}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

export default AuthorRecentArticles;
