import React, { useCallback, useEffect, useState } from 'react';
import { Image as ImageIcon, Loader2, Search, Trash2, Upload } from 'lucide-react';
import { ApiRecord, GeoFlowApiClient } from '../api/geoflowClient';
import { describeApiError } from '../api/permissions';

interface ImageLibraryPanelProps {
  apiClient: GeoFlowApiClient;
  lang: 'zh' | 'en';
  libraryId: string | number;
  canWrite: boolean;
}

function idempotencyKey(prefix: string): string {
  const uuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${uuid}`;
}

function text(record: ApiRecord | undefined, key: string, fallback = ''): string {
  const value = record?.[key];
  return value === undefined || value === null ? fallback : String(value);
}

function num(record: ApiRecord | undefined, key: string): number {
  const value = Number(record?.[key]);
  return Number.isFinite(value) ? value : 0;
}

function formatSize(bytes: number): string {
  if (bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 图片库的图片管理。
 *
 * 上传是**一次多图、逐张独立成败**（对齐旧后台上传页）：一张失败不牵连其余，
 * 所以结果必须分开报「成功 N 张 / 跳过 M 张」并列出失败的文件名——把它们合并成
 * 一句「上传失败」会让运营方丢掉那批里已经成功的部分。
 *
 * 搜索走服务端（按文件名），不是在前端过滤当前页——否则「搜不到」可能只是没翻页。
 */
const ImageLibraryPanel: React.FC<ImageLibraryPanelProps> = ({ apiClient, lang, libraryId, canWrite }) => {
  const zh = lang === 'zh';
  const [images, setImages] = useState<ApiRecord[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = useCallback(async (keyword: string) => {
    setLoading(true);
    setError('');
    try {
      const result = await apiClient.listMaterialItems('image-libraries', libraryId, {
        page: 1,
        per_page: 100,
        ...(keyword.trim() === '' ? {} : { search: keyword.trim() }),
      });
      const items = (result as { items?: ApiRecord[] }).items ?? [];
      setImages(items);
      setSelected(new Set());
    } catch (loadError) {
      setError(describeApiError(loadError, zh ? '读取图片失败' : 'Unable to load images', lang));
    } finally {
      setLoading(false);
    }
  }, [apiClient, lang, libraryId, zh]);

  useEffect(() => { void load(''); }, [load]);

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0 || busy) return;
    setBusy('upload');
    setError('');
    setNotice('');
    try {
      const data = await apiClient.uploadMaterialImages(libraryId, Array.from(files), {
        idempotencyKey: idempotencyKey(`image-upload-${libraryId}`),
      });
      const uploaded = Number(data.uploaded ?? 0);
      const skipped = Number(data.skipped ?? 0);
      const failed = Array.isArray(data.failed_names) ? (data.failed_names as string[]) : [];
      setNotice(zh
        ? `成功 ${uploaded} 张${skipped > 0 ? `，跳过 ${skipped} 张${failed.length ? `（${failed.join('、')}）` : ''}` : ''}。`
        : `Uploaded ${uploaded}${skipped > 0 ? `, skipped ${skipped}${failed.length ? ` (${failed.join(', ')})` : ''}` : ''}.`);
      await load(search);
    } catch (uploadError) {
      setError(describeApiError(uploadError, zh ? '上传失败' : 'Upload failed', lang));
    } finally {
      setBusy('');
    }
  };

  const removeSelected = async () => {
    if (selected.size === 0 || busy) return;
    setBusy('delete');
    setError('');
    setNotice('');
    try {
      await apiClient.deleteMaterialItems('image-libraries', libraryId, { ids: Array.from(selected).map(Number) });
      setNotice(zh ? `已删除 ${selected.size} 张。` : `Deleted ${selected.size}.`);
      await load(search);
    } catch (deleteError) {
      setError(describeApiError(deleteError, zh ? '删除失败' : 'Delete failed', lang));
    } finally {
      setBusy('');
    }
  };

  const toggle = (id: string) => setSelected((previous) => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-xs font-semibold text-slate-300">
          {zh ? '图片' : 'Images'} <span className="text-slate-500">({images.length})</span>
        </div>
        <div className="flex items-center gap-2">
          {canWrite && selected.size > 0 && (
            <button type="button" onClick={() => void removeSelected()} disabled={busy === 'delete'} className="inline-flex items-center gap-1 rounded-lg border border-rose-500/40 px-2.5 py-1.5 text-[11px] text-rose-300 hover:bg-rose-950/30 disabled:opacity-50">
              <Trash2 className="h-3 w-3" />{zh ? `删除所选 (${selected.size})` : `Delete selected (${selected.size})`}
            </button>
          )}
          {canWrite && (
            <label className="inline-flex cursor-pointer items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-indigo-500">
              {busy === 'upload' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
              {zh ? '上传图片（可多选）' : 'Upload images'}
              <input type="file" accept="image/jpeg,image/png,image/gif,image/webp" multiple className="hidden" onChange={(event) => { void upload(event.target.files); event.target.value = ''; }} />
            </label>
          )}
        </div>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void load(search); }}
          placeholder={zh ? '按文件名搜索，回车执行' : 'Search by file name, press Enter'}
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-2 pl-8 text-xs text-white outline-none focus:border-indigo-500"
        />
      </div>

      {error && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-950/30 px-3 py-2 text-[11px] text-rose-200">{error}</div>}
      {notice && <div className="rounded-lg border border-emerald-500/30 bg-emerald-950/30 px-3 py-2 text-[11px] text-emerald-200">{notice}</div>}

      {loading ? (
        <div className="flex min-h-32 items-center justify-center text-xs text-slate-500"><Loader2 className="mr-2 h-4 w-4 animate-spin" />{zh ? '读取图片…' : 'Loading images…'}</div>
      ) : images.length === 0 ? (
        <div className="flex min-h-32 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-800 px-4 py-10 text-center text-xs text-slate-500">
          <ImageIcon className="h-8 w-8 text-slate-700" />
          <span>{search.trim() === '' ? (zh ? '此图片库还没有图片' : 'This library has no images yet') : (zh ? '没有匹配的图片' : 'No matching image')}</span>
        </div>
      ) : (
        <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
          {images.map((image) => {
            const id = String(image.id);
            return (
              <label key={id} className="flex cursor-pointer items-center gap-3 rounded-lg border border-slate-800 bg-slate-950/50 p-3 hover:border-slate-700">
                <input type="checkbox" checked={selected.has(id)} onChange={() => toggle(id)} className="accent-indigo-500" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-slate-200">{text(image, 'original_name') || `#${id}`}</span>
                  <span className="mt-1 block text-[10px] text-slate-500">
                    {num(image, 'width')}×{num(image, 'height')} · {formatSize(num(image, 'file_size'))} · {text(image, 'mime_type') || '—'}
                  </span>
                </span>
                <span className="shrink-0 text-[10px] text-slate-600">{text(image, 'used_count') !== '' ? `${zh ? '已用' : 'used'} ${num(image, 'used_count')}` : ''}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default ImageLibraryPanel;
