import React, { useCallback, useEffect, useState } from 'react';
import { Image as ImageIcon, Loader2, Search, Trash2, Upload } from 'lucide-react';
import { ApiRecord, GeoFlowApiClient } from '../api/geoflowClient';
import { describeApiError } from '../api/permissions';
import { getPaginationMeta } from '../api/mappers';

interface ImageLibraryPanelProps {
  apiClient: GeoFlowApiClient;
  lang: 'zh' | 'en';
  libraryId: string | number;
  canWrite: boolean;
}

/**
 * 上传预检阈值，**镜像后端** `ImageLibraryUploadPolicy`（`GEOFLOW_MAX_UPLOAD_BYTES`，默认 10MB）。
 * 这里只为「请求发出去之前就说清楚」；真超限时后端也会回中文原因，前端照常展示。
 */
const MAX_IMAGE_MB = 10;
const MAX_IMAGE_BYTES = MAX_IMAGE_MB * 1024 * 1024;
/** 一次提交的总量上限：低于 PHP post_max_size（64M），避免整个请求体被丢掉后只能回「请选择图片」。 */
const MAX_BATCH_BYTES = 40 * 1024 * 1024;

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
  /** 服务端报告的图片总数（列表一次只取 100 张）。 */
  const [total, setTotal] = useState<number | undefined>(undefined);

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
      // 服务端总数（一次只取 100 张，超出的部分以前既不显示也删不掉）。
      setTotal(typeof getPaginationMeta(result)?.total === 'number' ? Number(getPaginationMeta(result)?.total) : items.length);
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
    const picked = Array.from(files);

    // 上传前的预检。以前这里什么都不查：一张手机拍的 5MB 照片会被后端以「参数校验
    // 失败」（那会儿后端还没配中文原因）挡回来，运营看不出是尺寸问题。现在后端上限
    // 已与图片编辑器对齐到 10MB、且会回中文原因，这里只为了**在发出请求之前**就说清楚。
    const tooLarge = picked.filter((file) => file.size > MAX_IMAGE_BYTES);
    if (tooLarge.length > 0) {
      setError(zh
        ? `这些图片超过 ${MAX_IMAGE_MB} MB，没有上传：${tooLarge.map((file) => file.name).join('、')}`
        : `${tooLarge.map((file) => file.name).join(', ')} exceed ${MAX_IMAGE_MB} MB and were not uploaded.`);
      return;
    }
    const totalBytes = picked.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > MAX_BATCH_BYTES) {
      setError(zh
        ? `一次选中的图片总量约 ${Math.round(totalBytes / 1048576)} MB，请分批上传（每次不超过 ${Math.round(MAX_BATCH_BYTES / 1048576)} MB）`
        : `The selection is about ${Math.round(totalBytes / 1048576)} MB; please upload in smaller batches.`);
      return;
    }

    setBusy('upload');
    setError('');
    setNotice('');
    try {
      const data = await apiClient.uploadMaterialImages(libraryId, picked, {
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
          {zh ? '图片' : 'Images'} <span className="text-slate-500">({total ?? images.length})</span>
          {/* 一次只取 100 张：超过就在表头说明，别让「图片 (100)」冒充全部。 */}
          {typeof total === 'number' && images.length < total && (
            <span className="ml-1 text-slate-500">
              {zh ? `· 已显示前 ${images.length} 张` : `· showing first ${images.length}`}
            </span>
          )}
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
              {zh ? `上传图片（可多选，单张 ≤ ${MAX_IMAGE_MB} MB）` : `Upload images (each ≤ ${MAX_IMAGE_MB} MB)`}
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
