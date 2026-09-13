import React, { useState } from 'react';
import { Loader2, Upload } from 'lucide-react';
import { GeoFlowApiClient } from '../api/geoflowClient';
import { describeApiError } from '../api/permissions';

interface LibraryImportDialogProps {
  apiClient: GeoFlowApiClient;
  lang: 'zh' | 'en';
  /** 只有关键词库与标题库支持粘贴导入。 */
  type: 'keyword-libraries' | 'title-libraries';
  libraryId: string | number;
  libraryName: string;
  onDone?: () => void;
  onClose: () => void;
}

function idempotencyKey(prefix: string): string {
  const uuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${uuid}`;
}

/**
 * 批量导入：把运营方手上已有的词表 / 标题表整段粘进来。
 *
 * 切分与去重规则全在服务端，前端不预切——否则「后台能导 1000 条、界面导 200 条」
 * 这种漂移迟早出现。`skipped` 是**重复条目**而不是错误，必须分开报，不然运营方会
 * 以为导入失败而反复重试。
 */
const LibraryImportDialog: React.FC<LibraryImportDialogProps> = ({
  apiClient, lang, type, libraryId, libraryName, onDone, onClose,
}) => {
  const zh = lang === 'zh';
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ imported: number; skipped: number } | null>(null);

  const isKeywords = type === 'keyword-libraries';

  const submit = async () => {
    if (busy || text.trim() === '') return;
    setBusy(true);
    setError('');
    try {
      const data = await apiClient.importLibraryText(type, libraryId, text, {
        idempotencyKey: idempotencyKey(`library-import-${type}-${libraryId}`),
      });
      setResult({
        imported: Number(data.imported ?? 0),
        skipped: Number(data.skipped ?? 0),
      });
      setText('');
      onDone?.();
    } catch (importError) {
      setError(describeApiError(importError, zh ? '导入失败' : 'Import failed', lang));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4">
      <div className="w-full max-w-2xl space-y-4 rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <div>
          <h3 className="text-sm font-bold text-white">
            {zh ? `批量导入到「${libraryName}」` : `Bulk import into "${libraryName}"`}
          </h3>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
            {isKeywords
              ? (zh ? '每行一个关键词，也可以用逗号分隔；重复的条目会被跳过。' : 'One keyword per line, or comma separated. Duplicates are skipped.')
              : (zh ? '每行一个标题；需要同时指定关键词时写成「标题|关键词」。重复的标题会被跳过。' : 'One title per line. Use "title|keyword" to attach a keyword. Duplicate titles are skipped.')}
          </p>
        </div>

        {error && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">{error}</div>}

        {result && (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-200">
            {zh
              ? `已导入 ${result.imported} 条，跳过重复 ${result.skipped} 条。`
              : `Imported ${result.imported}, skipped ${result.skipped} duplicates.`}
          </div>
        )}

        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={12}
          placeholder={isKeywords
            ? (zh ? 'GEO 优化\nAI 内容生成\n品牌可见度' : 'GEO optimization\nAI content\nBrand visibility')
            : (zh ? '如何做好 GEO 优化|GEO 优化\nAI 内容生成的三个误区' : 'How to do GEO|GEO optimization\nThree myths of AI content')}
          className="w-full rounded-xl border border-slate-700 bg-slate-950 p-3 font-mono text-xs text-slate-200 outline-none focus:border-indigo-500"
        />

        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-xs text-slate-400 hover:text-slate-200">
            {zh ? '关闭' : 'Close'}
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || text.trim() === ''}
            className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            {zh ? '开始导入' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default LibraryImportDialog;
