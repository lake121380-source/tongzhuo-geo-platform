import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  FolderKanban,
  Image as ImageIcon,
  Loader2,
  Plus,
  Upload,
  RefreshCw,
  Search,
  Tag,
  Trash2,
  Layers,
  UserRound,
  X,
} from 'lucide-react';
import { ApiRecord, GeoFlowApiClient } from '../api/geoflowClient';
import { describeApiError } from '../api/permissions';
import PermissionNotice from './PermissionNotice';
import UrlImportPanel from './UrlImportPanel';
import ImageLibraryPanel from './ImageLibraryPanel';
import TitleGenerationPanel from './TitleGenerationPanel';
import AuthorRecentArticles from './AuthorRecentArticles';
import LibraryImportDialog from './LibraryImportDialog';
import KnowledgeOfficialAdoptPanel from './KnowledgeOfficialAdoptPanel';
import { PageHeader } from './PageHeader';
import { Button, EmptyState } from './ui';

type MaterialType =
  | 'categories'
  | 'authors'
  | 'keyword-libraries'
  | 'title-libraries'
  | 'image-libraries'
  | 'knowledge-bases';

type ItemType = 'keyword-libraries' | 'title-libraries';

type Material = ApiRecord & { id: string | number };

type MaterialSummary = {
  type: MaterialType;
  count: number;
};

interface MaterialsViewProps {
  apiClient: GeoFlowApiClient;
  lang: 'zh' | 'en';
  canRead?: boolean;
  canWrite?: boolean;
  /**
   * 打开时默认选中的资产类型。生成弹窗的「去补充标题 →」会带 `title-libraries` 进来——
   * 标题库是「生成文章」的前置条件，用户点了那个链接就该直接看到标题库，而不是
   * 落在「分类」上再自己找（本组件每次切页签都会重新挂载，用初始值即可）。
   */
  initialType?: MaterialType;
}

const MATERIAL_TYPES: MaterialType[] = [
  'categories',
  'authors',
  'keyword-libraries',
  'title-libraries',
  'image-libraries',
  'knowledge-bases',
];

const ITEM_TYPES = new Set<ItemType>(['keyword-libraries', 'title-libraries']);

const labels: Record<MaterialType, { zh: string; en: string; icon: React.ElementType }> = {
  categories: { zh: '分类', en: 'Categories', icon: FolderKanban },
  authors: { zh: '作者', en: 'Authors', icon: UserRound },
  'keyword-libraries': { zh: '关键词库', en: 'Keyword libraries', icon: Tag },
  'title-libraries': { zh: '标题库', en: 'Title libraries', icon: BookOpen },
  'image-libraries': { zh: '图片库', en: 'Image libraries', icon: ImageIcon },
  'knowledge-bases': { zh: '知识库', en: 'Knowledge bases', icon: BookOpen },
};

const emptyForm: Record<string, string> = {
  name: '',
  description: '',
  slug: '',
  sort_order: '0',
  email: '',
  bio: '',
  avatar: '',
  website: '',
  social_links: '',
  content: '',
  file_type: 'markdown',
};

function text(record: ApiRecord | undefined, key: string, fallback = ''): string {
  const value = record?.[key];
  return value === undefined || value === null ? fallback : String(value);
}

function number(record: ApiRecord | undefined, key: string): number {
  const value = Number(record?.[key]);
  return Number.isFinite(value) ? value : 0;
}

function materialId(record: ApiRecord): string {
  return String(record.id ?? '');
}

function pageItems(value: unknown): Material[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const items = (value as ApiRecord).items;
  return Array.isArray(items)
    ? items.filter((item): item is Material => Boolean(item && typeof item === 'object' && !Array.isArray(item) && 'id' in item))
    : [];
}

function summaryItems(value: unknown): MaterialSummary[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const types = (value as ApiRecord).types;
  if (!Array.isArray(types)) return [];
  return types
    .filter((item): item is ApiRecord => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    .map((item) => ({
      type: String(item.type) as MaterialType,
      count: number(item, 'count'),
    }))
    .filter((item) => MATERIAL_TYPES.includes(item.type));
}

function formatDate(value: unknown): string {
  const raw = String(value ?? '').trim();
  return raw || '—';
}

function errorText(error: unknown, fallback: string, lang: 'zh' | 'en'): string {
  return describeApiError(error, fallback, lang);
}

export const MaterialsView: React.FC<MaterialsViewProps> = ({
  apiClient,
  lang,
  canRead = true,
  canWrite = true,
  initialType,
}) => {
  const [activeType, setActiveType] = useState<MaterialType>(initialType ?? 'categories');
  const [records, setRecords] = useState<Record<MaterialType, Material[]>>({
    categories: [],
    authors: [],
    'keyword-libraries': [],
    'title-libraries': [],
    'image-libraries': [],
    'knowledge-bases': [],
  });
  const [counts, setCounts] = useState<Record<MaterialType, number>>({
    categories: 0,
    authors: 0,
    'keyword-libraries': 0,
    'title-libraries': 0,
    'image-libraries': 0,
    'knowledge-bases': 0,
  });
  const [selectedId, setSelectedId] = useState<string>('');
  const [items, setItems] = useState<Material[]>([]);
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [itemError, setItemError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<Material | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<Record<string, string>>(emptyForm);
  const [itemDraft, setItemDraft] = useState({ keyword: '', title: '', relatedKeyword: '' });
  const [importOpen, setImportOpen] = useState(false);

  const activeRecords = records[activeType] || [];
  const activeRecord = activeRecords.find((row) => materialId(row) === selectedId) || null;
  const activeItemsEnabled = ITEM_TYPES.has(activeType as ItemType);

  const visibleRecords = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    if (!normalized) return activeRecords;
    return activeRecords.filter((record) => {
      const haystack = [
        text(record, 'name'),
        text(record, 'slug'),
        text(record, 'description'),
        text(record, 'email'),
        text(record, 'bio'),
      ].join(' ').toLowerCase();
      return haystack.includes(normalized);
    });
  }, [activeRecords, search]);

  const loadMaterials = async (keepSelection = true) => {
    if (!canRead) {
      setLoading(false);
      setError(lang === 'zh' ? '权限不足（403）：素材库需要「materials:read」权限。' : 'Permission denied (403): this page requires the “materials:read” scope.');
      return;
    }
    setLoading(true);
    setError('');
    setNotice('');
    try {
      const [summaryResult, ...pages] = await Promise.all([
        apiClient.materialSummary().catch(() => null),
        ...MATERIAL_TYPES.map((type) => apiClient.listMaterials(type, { page: 1, per_page: 100 })),
      ]);
      const nextRecords = { ...records };
      const nextCounts = { ...counts };
      pages.forEach((page, index) => {
        const type = MATERIAL_TYPES[index];
        nextRecords[type] = pageItems(page);
        const pagination = page && typeof page === 'object' && !Array.isArray(page)
          ? (page as ApiRecord).pagination
          : null;
        const total = pagination && typeof pagination === 'object' && !Array.isArray(pagination)
          ? Number((pagination as ApiRecord).total)
          : NaN;
        nextCounts[type] = Number.isFinite(total) ? total : nextRecords[type].length;
      });
      const summary = summaryItems(summaryResult);
      summary.forEach((entry) => { nextCounts[entry.type] = entry.count; });
      setRecords(nextRecords);
      setCounts(nextCounts);
      if (keepSelection) {
        const selectedStillExists = nextRecords[activeType].some((row) => materialId(row) === selectedId);
        if (!selectedStillExists) setSelectedId(materialId(nextRecords[activeType][0] || {}));
      } else {
        setSelectedId(materialId(nextRecords[activeType][0] || {}));
      }
    } catch (loadError) {
      setError(errorText(loadError, lang === 'zh' ? '加载素材库失败' : 'Unable to load material libraries', lang));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadMaterials(false);
    // The API client is stable for the lifetime of the shell.  Re-run when
    // the permission changes so a token refresh can recover the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiClient, canRead]);

  useEffect(() => {
    setSearch('');
    setSelectedItemIds(new Set());
    setEditing(null);
    setFormOpen(false);
    setForm({ ...emptyForm });
    const first = records[activeType]?.[0];
    setSelectedId(first ? materialId(first) : '');
  }, [activeType]);

  /** 重新拉一次库内条目。导入 / 生成完成后要能立刻看到新内容。 */
  const refreshItems = useCallback(async () => {
    if (!activeItemsEnabled || !selectedId || !canRead) {
      setItems([]);
      setItemsLoading(false);
      return;
    }
    setItemsLoading(true);
    setItemError('');
    try {
      const result = await apiClient.listMaterialItems(activeType, selectedId, { page: 1, per_page: 100 });
      setItems(pageItems(result));
    } catch (loadError) {
      setItemError(errorText(loadError, lang === 'zh' ? '加载库内条目失败' : 'Unable to load library items', lang));
    } finally {
      setItemsLoading(false);
    }
  }, [activeItemsEnabled, activeType, apiClient, canRead, lang, selectedId]);

  useEffect(() => { void refreshItems(); }, [refreshItems]);

  const beginCreate = () => {
    setEditing(null);
    setFormOpen(true);
    setForm({ ...emptyForm });
    setNotice('');
  };

  const beginEdit = async (record: Material) => {
    setBusy('detail');
    setNotice('');
    let source = record;
    try {
      // List responses intentionally truncate knowledge content.  Always
      // hydrate the detail before opening its editor so a save can never
      // accidentally replace a full knowledge base with the 4k preview.
      if (activeType === 'knowledge-bases') {
        const result = await apiClient.getMaterial(activeType, record.id);
        source = (result.item || result) as Material;
      }
    } catch (detailError) {
      setNotice(errorText(detailError, lang === 'zh' ? '读取素材详情失败' : 'Unable to load material details', lang));
      setBusy('');
      return;
    }
    setEditing(source);
    setFormOpen(true);
    setForm({
      ...emptyForm,
      name: text(source, 'name'),
      description: text(source, 'description'),
      slug: text(source, 'slug'),
      sort_order: String(number(source, 'sort_order')),
      email: text(source, 'email'),
      bio: text(source, 'bio'),
      avatar: text(source, 'avatar'),
      website: text(source, 'website'),
      social_links: text(source, 'social_links'),
      content: text(source, 'content'),
      file_type: text(source, 'file_type', 'markdown'),
    });
    setBusy('');
  };

  const setField = (key: string, value: string) => setForm((previous) => ({ ...previous, [key]: value }));

  const materialPayload = (): ApiRecord => {
    if (activeType === 'categories') {
      return {
        name: form.name.trim(),
        slug: form.slug.trim(),
        description: form.description.trim(),
        sort_order: Math.max(0, Number(form.sort_order) || 0),
      };
    }
    if (activeType === 'authors') {
      return {
        name: form.name.trim(),
        email: form.email.trim(),
        bio: form.bio.trim(),
        avatar: form.avatar.trim(),
        website: form.website.trim(),
        social_links: form.social_links.trim(),
      };
    }
    if (activeType === 'knowledge-bases') {
      return {
        name: form.name.trim(),
        description: form.description.trim(),
        content: form.content,
        file_type: form.file_type || 'markdown',
      };
    }
    return { name: form.name.trim(), description: form.description.trim() };
  };

  const saveMaterial = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canWrite) {
      setNotice(lang === 'zh' ? '权限不足（403）：写入素材库需要「materials:write」权限。' : 'Permission denied (403): writing materials requires the “materials:write” scope.');
      return;
    }
    if (!form.name.trim()) {
      setNotice(lang === 'zh' ? '名称不能为空' : 'Name is required');
      return;
    }
    if (activeType === 'knowledge-bases' && !editing && !form.content.trim()) {
      setNotice(lang === 'zh' ? '知识库正文不能为空' : 'Knowledge base content is required');
      return;
    }
    const operation = editing
      ? () => apiClient.updateMaterial(activeType, editing.id, materialPayload())
      : () => apiClient.createMaterial(activeType, materialPayload());
    setBusy('material');
    setNotice('');
    try {
      const result = await operation();
      const next = (result.item || result) as Material;
      const nextId = materialId(next);
      setRecords((previous) => ({
        ...previous,
        [activeType]: editing
          ? previous[activeType].map((row) => materialId(row) === nextId ? next : row)
          : [next, ...previous[activeType]],
      }));
      setCounts((previous) => ({ ...previous, [activeType]: editing ? previous[activeType] : previous[activeType] + 1 }));
      setSelectedId(nextId);
      setEditing(null);
      setFormOpen(false);
      setForm({ ...emptyForm });
      setNotice(lang === 'zh' ? (editing ? '素材库已更新' : '素材库已创建') : (editing ? 'Library updated' : 'Library created'));
    } catch (saveError) {
      setNotice(errorText(saveError, lang === 'zh' ? '保存素材库失败' : 'Unable to save material library', lang));
    } finally {
      setBusy('');
    }
  };

  const deleteMaterial = async (record: Material) => {
    if (!canWrite) {
      setNotice(lang === 'zh' ? '权限不足（403）：删除素材库需要「materials:write」权限。' : 'Permission denied (403): deleting materials requires the “materials:write” scope.');
      return;
    }
    const name = text(record, 'name') || materialId(record);
    if (typeof window !== 'undefined' && !window.confirm(lang === 'zh' ? `确定删除「${name}」吗？该操作不可撤销。` : `Delete “${name}”? This cannot be undone.`)) return;
    setBusy(`delete-${materialId(record)}`);
    setNotice('');
    try {
      await apiClient.deleteMaterial(activeType, record.id);
      const nextRecords = records[activeType].filter((row) => materialId(row) !== materialId(record));
      setRecords((previous) => ({ ...previous, [activeType]: nextRecords }));
      setCounts((previous) => ({ ...previous, [activeType]: Math.max(0, previous[activeType] - 1) }));
      setSelectedId(materialId(nextRecords[0] || {}));
      setNotice(lang === 'zh' ? '素材库已删除' : 'Library deleted');
    } catch (deleteError) {
      setNotice(errorText(deleteError, lang === 'zh' ? '删除素材库失败' : 'Unable to delete material library', lang));
    } finally {
      setBusy('');
    }
  };

  const createItem = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canWrite || !activeRecord || !activeItemsEnabled) return;
    const payload = activeType === 'keyword-libraries'
      ? { keyword: itemDraft.keyword.trim() }
      : { title: itemDraft.title.trim(), keyword: itemDraft.relatedKeyword.trim() };
    const value = activeType === 'keyword-libraries' ? itemDraft.keyword : itemDraft.title;
    if (!value.trim()) {
      setItemError(lang === 'zh' ? '条目内容不能为空' : 'Item content is required');
      return;
    }
    setBusy('item-create');
    setItemError('');
    try {
      const result = await apiClient.createMaterialItem(activeType, activeRecord.id, payload);
      const created = (result.item || result) as Material;
      setItems((previous) => [created, ...previous]);
      setRecords((previous) => ({
        ...previous,
        [activeType]: previous[activeType].map((record) => materialId(record) === materialId(activeRecord)
          ? {
              ...record,
              item_count: number(record, 'item_count') + 1,
              ...(activeType === 'keyword-libraries' ? { keyword_count: number(record, 'keyword_count') + 1 } : {}),
              ...(activeType === 'title-libraries' ? { title_count: number(record, 'title_count') + 1 } : {}),
            }
          : record),
      }));
      setItemDraft({ keyword: '', title: '', relatedKeyword: '' });
      setNotice(lang === 'zh' ? '条目已添加' : 'Item added');
    } catch (createError) {
      setItemError(errorText(createError, lang === 'zh' ? '添加条目失败' : 'Unable to add item', lang));
    } finally {
      setBusy('');
    }
  };

  const toggleItem = (id: string) => {
    setSelectedItemIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const deleteItems = async () => {
    if (!canWrite || !activeRecord || !activeItemsEnabled || selectedItemIds.size === 0) return;
    setBusy('item-delete');
    setItemError('');
    try {
      const result = await apiClient.deleteMaterialItems(activeType, activeRecord.id, { ids: Array.from(selectedItemIds).map(Number) });
      const deletedCount = Math.max(0, Number(result.deleted_count) || selectedItemIds.size);
      setItems((previous) => previous.filter((item) => !selectedItemIds.has(materialId(item))));
      setRecords((previous) => ({
        ...previous,
        [activeType]: previous[activeType].map((record) => materialId(record) === materialId(activeRecord)
          ? {
              ...record,
              item_count: Math.max(0, number(record, 'item_count') - deletedCount),
              ...(activeType === 'keyword-libraries' ? { keyword_count: Math.max(0, number(record, 'keyword_count') - deletedCount) } : {}),
              ...(activeType === 'title-libraries' ? { title_count: Math.max(0, number(record, 'title_count') - deletedCount) } : {}),
            }
          : record),
      }));
      setSelectedItemIds(new Set());
      setNotice(lang === 'zh' ? '已删除所选条目' : 'Selected items deleted');
    } catch (deleteError) {
      setItemError(errorText(deleteError, lang === 'zh' ? '删除条目失败' : 'Unable to delete items', lang));
    } finally {
      setBusy('');
    }
  };

  const summaryCount = (type: MaterialType): number => counts[type] ?? 0;
  const label = labels[activeType][lang];
  const ActiveIcon = labels[activeType].icon;

  if (!canRead) {
    return (
      <div className="space-y-8">
        <PageHeading lang={lang} />
        <PermissionNotice lang={lang} mode="read" requiredScope="materials:read" />
      </div>
    );
  }

  return (
    <div className="space-y-8 pb-8">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <PageHeading lang={lang} />
        <div className="flex flex-wrap items-center gap-2">
          {!canWrite && <PermissionNotice lang={lang} requiredScope="materials:write" />}
          <button
            type="button"
            onClick={() => void loadMaterials(true)}
            disabled={loading}
            className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 text-[13px] font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            {lang === 'zh' ? '刷新' : 'Refresh'}
          </button>
          {canWrite && (
            <button
              type="button"
              onClick={beginCreate}
              className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 text-[13px] font-bold text-white hover:bg-indigo-500"
            >
              <Plus className="h-3.5 w-3.5" />
              {lang === 'zh' ? `新建${label}` : `New ${label}`}
            </button>
          )}
        </div>
      </div>

      {error && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-950/30 px-3 py-2 text-[13px] text-rose-200">{error}</div>}
      {notice && <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-3 py-2 text-[13px] text-indigo-200">{notice}</div>}

      {/* URL 采集是低频功能：默认收起，不让它占掉首屏一半（审计 P1-3）。
          面板仍照常挂载、照常加载任务列表，展开即用。 */}
      <details className="group rounded-2xl bg-slate-900/80">
        <summary className="flex cursor-pointer select-none items-center justify-between gap-3 px-5 py-4 [&::-webkit-details-marker]:hidden">
          <span className="flex items-center gap-2 text-section-title">
            <Upload className="h-[18px] w-[18px] text-slate-400" />
            {lang === 'zh' ? 'URL 智能采集与入库' : 'URL import'}
          </span>
          <span className="flex items-center gap-2 text-caption">
            {lang === 'zh' ? '低频：抓取公开网页 → AI 预览 → 确认入库' : 'Fetch a page, preview, then import'}
            <ChevronDown className="h-4 w-4 text-slate-400 transition-transform group-open:rotate-180" />
          </span>
        </summary>
        <div className="px-5 pb-5">
          <UrlImportPanel apiClient={apiClient} lang={lang} canRead={canRead} canWrite={canWrite} />
        </div>
      </details>

      {/* 2026-09-19 版式对齐设计稿：**横排的类型格改成卡片内的左栏「知识目录」树**，
          目录树与右侧内容区共处一张卡（原来是「横排 6 格 + 两张独立卡」三块并列）。
          窄屏下目录树退化成横向可滑的一排，不占掉首屏。 */}
      <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
        <div className="flex flex-col xl:flex-row">
          <div className="shrink-0 border-b border-slate-800 p-3 xl:w-56 xl:border-b-0 xl:border-r">
            <div className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              {lang === 'zh' ? '知识目录' : 'Catalog'}
            </div>
            <div className="flex gap-1 overflow-x-auto xl:flex-col xl:overflow-visible">
              {MATERIAL_TYPES.map((type) => {
                const Icon = labels[type].icon;
                const active = activeType === type;
                return (
                  <button
                    type="button"
                    key={type}
                    onClick={() => setActiveType(type)}
                    className={`flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-lg px-2.5 py-2 text-[13px] font-medium transition xl:w-full ${active ? 'bg-slate-800 text-white' : 'text-slate-400 hover:bg-slate-800/60 hover:text-white'}`}
                  >
                    <Icon className={`h-4 w-4 shrink-0 ${active ? 'text-indigo-400' : 'text-slate-500'}`} />
                    <span className="truncate">{labels[type][lang]}</span>
                    <span className="ml-auto text-[11px] tabular-nums text-slate-500">{summaryCount(type)}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="min-w-0 flex-1 p-5">
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
        <section className="min-h-[420px] rounded-xl bg-slate-800/40 p-5 xl:col-span-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <ActiveIcon className="h-4 w-4 shrink-0 text-indigo-400" />
              <h2 className="truncate text-section-title">{label}</h2>
              <span className="text-caption">{counts[activeType]}</span>
            </div>
            <div className="relative w-44 max-w-[48%]">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={lang === 'zh' ? '搜索' : 'Search'}
                className="h-10 w-full rounded-xl border border-slate-700 bg-slate-900 py-0 pl-8 pr-3 text-[13px] text-white outline-none transition focus:border-indigo-500"
              />
            </div>
          </div>

          {loading && activeRecords.length === 0 ? (
            <div className="flex min-h-64 items-center justify-center text-[13px] text-slate-500"><Loader2 className="mr-2 h-4 w-4 animate-spin" />{lang === 'zh' ? '加载中…' : 'Loading…'}</div>
          ) : visibleRecords.length === 0 ? (
            <div className="flex min-h-64 items-center justify-center">
              <EmptyState
                compact
                icon={FolderKanban}
                title={search
                  ? (lang === 'zh' ? '没有匹配结果' : 'No matching results')
                  : (lang === 'zh' ? `还没有${label}` : `No ${label} yet`)}
                description={search
                  ? (lang === 'zh' ? '换个关键词，或清空搜索框看全部。' : 'Try another keyword, or clear the search.')
                  : (lang === 'zh' ? `点右上角「新建${label}」创建第一条。` : `Create one to get started.`)}
                action={!search && canWrite ? (
                  <Button variant="secondary" icon={Plus} onClick={beginCreate}>
                    {lang === 'zh' ? `新建${label}` : `New ${label}`}
                  </Button>
                ) : undefined}
              />
            </div>
          ) : (
            <div className="max-h-[620px] space-y-2 overflow-y-auto pr-1">
              {visibleRecords.map((record) => {
                const id = materialId(record);
                const selected = id === selectedId;
                return (
                  <div key={id} className={`group flex items-start gap-2 rounded-xl px-4 py-3 transition ${selected ? 'bg-indigo-500/10 ring-1 ring-indigo-500/50' : 'bg-slate-950/40 hover:bg-slate-800/40'}`}>
                    <button type="button" onClick={() => setSelectedId(id)} className="min-w-0 flex-1 text-left">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[13px] font-semibold text-white">{text(record, 'name') || text(record, 'title') || `#${id}`}</span>
                        {activeType === 'categories' && <span className="shrink-0 text-[12.5px] text-slate-500">{number(record, 'article_count')} 篇</span>}
                        {activeType === 'authors' && <span className="shrink-0 text-[12.5px] text-slate-500">{number(record, 'article_count')} 篇</span>}
                        {activeType === 'keyword-libraries' && <span className="shrink-0 text-[12.5px] text-indigo-300">{number(record, 'item_count') || number(record, 'keyword_count')} 词</span>}
                        {activeType === 'title-libraries' && <span className="shrink-0 text-[12.5px] text-indigo-300">{number(record, 'item_count') || number(record, 'title_count')} 条</span>}
                        {activeType === 'knowledge-bases' && <span className="shrink-0 text-[12.5px] text-emerald-300">{number(record, 'chunk_count')} 切片</span>}
                      </div>
                      <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-slate-500">{text(record, 'description') || text(record, 'email') || (lang === 'zh' ? '暂无描述' : 'No description')}</p>
                      <div className="mt-2 text-[12.5px] text-slate-500">{formatDate(record.updated_at || record.created_at)}</div>
                    </button>
                    {canWrite && (
                      <div className="flex shrink-0 items-center gap-1 opacity-70 transition group-hover:opacity-100">
                        <button type="button" title={lang === 'zh' ? '编辑' : 'Edit'} onClick={() => beginEdit(record)} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-800 hover:text-white">✎</button>
                        <button type="button" title={lang === 'zh' ? '删除' : 'Delete'} onClick={() => void deleteMaterial(record)} disabled={busy === `delete-${id}`} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-rose-400 transition hover:bg-rose-950/50 disabled:opacity-40"><Trash2 className="h-3.5 w-3.5" /></button>
                      </div>
                    )}
                    {selected && <ChevronRight className="mt-1 h-3.5 w-3.5 shrink-0 text-indigo-400" />}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="space-y-5 xl:col-span-7">
          {(formOpen && canWrite) && (
            <form onSubmit={saveMaterial} className="rounded-2xl bg-slate-900/80 p-6">
              <div className="mb-4 flex items-center justify-between border-b border-slate-800 pb-3">
                <h3 className="text-section-title">{editing ? (lang === 'zh' ? `编辑${label}` : `Edit ${label}`) : (lang === 'zh' ? `新建${label}` : `New ${label}`)}</h3>
                <button type="button" onClick={() => { setEditing(null); setFormOpen(false); setForm({ ...emptyForm }); }} className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-white"><X className="h-4 w-4" /></button>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label={lang === 'zh' ? '名称' : 'Name'} required value={form.name} onChange={(value) => setField('name', value)} />
                {activeType === 'categories' && <Field label="Slug" value={form.slug} onChange={(value) => setField('slug', value)} />}
                {activeType === 'categories' && <Field label={lang === 'zh' ? '排序' : 'Sort order'} value={form.sort_order} onChange={(value) => setField('sort_order', value)} type="number" />}
                {activeType === 'authors' && <Field label="Email" value={form.email} onChange={(value) => setField('email', value)} type="email" />}
                {activeType === 'authors' && <Field label={lang === 'zh' ? '网站' : 'Website'} value={form.website} onChange={(value) => setField('website', value)} />}
                {activeType === 'authors' && <Field label={lang === 'zh' ? '头像 URL' : 'Avatar URL'} value={form.avatar} onChange={(value) => setField('avatar', value)} />}
                {activeType === 'knowledge-bases' && <label className="text-[13px] text-slate-400">{lang === 'zh' ? '文件类型' : 'File type'}<select value={form.file_type} onChange={(event) => setField('file_type', event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500"><option value="markdown">Markdown</option><option value="text">Text</option><option value="word">Word</option></select></label>}
                <label className="text-[13px] text-slate-400 sm:col-span-2">{lang === 'zh' ? '描述' : 'Description'}<textarea value={form.description} onChange={(event) => setField('description', event.target.value)} rows={3} className="mt-1 w-full resize-y rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-[13px] text-white outline-none transition focus:border-indigo-500" /></label>
                {activeType === 'authors' && <label className="text-[13px] text-slate-400 sm:col-span-2">{lang === 'zh' ? '简介' : 'Bio'}<textarea value={form.bio} onChange={(event) => setField('bio', event.target.value)} rows={3} className="mt-1 w-full resize-y rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-[13px] text-white outline-none transition focus:border-indigo-500" /></label>}
                {activeType === 'authors' && <label className="text-[13px] text-slate-400 sm:col-span-2">{lang === 'zh' ? '社交链接（JSON 或文本）' : 'Social links (JSON or text)'}<textarea value={form.social_links} onChange={(event) => setField('social_links', event.target.value)} rows={2} className="mt-1 w-full resize-y rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-[13px] text-white outline-none transition focus:border-indigo-500" /></label>}
                {activeType === 'knowledge-bases' && (!editing || form.content !== '') && <label className="text-[13px] text-slate-400 sm:col-span-2">{lang === 'zh' ? '正文' : 'Content'}<textarea required={!editing} value={form.content} onChange={(event) => setField('content', event.target.value)} rows={8} className="mt-1 w-full resize-y rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-[13px] text-white outline-none transition focus:border-indigo-500" /></label>}
              </div>
              <div className="mt-4 flex justify-end gap-2 border-t border-slate-800 pt-3">
                <button type="button" onClick={() => { setEditing(null); setFormOpen(false); setForm({ ...emptyForm }); }} className="inline-flex h-9 items-center rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 text-[13px] font-semibold text-slate-200 hover:bg-slate-800">{lang === 'zh' ? '取消' : 'Cancel'}</button>
                <button type="submit" disabled={busy === 'material'} className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 text-[13px] font-bold text-white hover:bg-indigo-500 disabled:opacity-50"><Plus className="h-3.5 w-3.5" />{busy === 'material' ? (lang === 'zh' ? '保存中…' : 'Saving…') : (lang === 'zh' ? '保存' : 'Save')}</button>
              </div>
            </form>
          )}

          <div className="rounded-2xl bg-slate-900/80 p-6">
            <div className="mb-4 flex items-start justify-between gap-3 border-b border-slate-800 pb-3">
              <div className="min-w-0">
                <h3 className="truncate text-section-title">{activeRecord ? text(activeRecord, 'name') : label}</h3>
                <p className="mt-1 text-caption">{activeRecord ? (text(activeRecord, 'description') || (lang === 'zh' ? '暂无描述' : 'No description')) : (lang === 'zh' ? '选择左侧素材库查看详情' : 'Select a library to inspect its details')}</p>
              </div>
              {activeRecord && <span className="shrink-0 rounded-lg bg-slate-800 px-2 py-1 text-[12.5px] text-slate-400">ID {materialId(activeRecord)}</span>}
            </div>

            {activeRecord && !activeItemsEnabled && (
              <div className="grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-3">
                <Stat label={lang === 'zh' ? '关联文章' : 'Articles'} value={number(activeRecord, 'article_count')} />
                {activeType === 'knowledge-bases' && <Stat label={lang === 'zh' ? '字符数' : 'Characters'} value={number(activeRecord, 'character_count')} />}
                {activeType === 'knowledge-bases' && <Stat label={lang === 'zh' ? '切片数' : 'Chunks'} value={number(activeRecord, 'chunk_count')} />}
                {activeType === 'authors' && <Stat label={lang === 'zh' ? '已删除文章' : 'Trashed articles'} value={number(activeRecord, 'trashed_count')} />}
                {activeType === 'categories' && <Stat label={lang === 'zh' ? '排序' : 'Sort'} value={number(activeRecord, 'sort_order')} />}
              </div>
            )}

            {activeRecord && activeType === 'image-libraries' && (
              <ImageLibraryPanel apiClient={apiClient} lang={lang} libraryId={materialId(activeRecord)} canWrite={canWrite} />
            )}

            {activeRecord && activeType === 'authors' && (
              <AuthorRecentArticles apiClient={apiClient} lang={lang} authorId={materialId(activeRecord)} />
            )}

            {activeRecord && activeType === 'knowledge-bases' && (
              <KnowledgeOfficialAdoptPanel apiClient={apiClient} lang={lang} knowledgeBaseId={materialId(activeRecord)} canWrite={canWrite} />
            )}

            {activeRecord && activeItemsEnabled && (
              <div className="space-y-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-[13px] font-semibold text-slate-200">{activeType === 'keyword-libraries' ? (lang === 'zh' ? '关键词条目' : 'Keywords') : (lang === 'zh' ? '标题条目' : 'Titles')} <span className="text-caption">({items.length})</span></div>
                  <div className="flex items-center gap-2">
                  {canWrite && <button type="button" onClick={() => setImportOpen(true)} className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-indigo-500/40 px-3 text-[13px] font-semibold text-indigo-300 transition hover:bg-indigo-500/10"><Upload className="h-3.5 w-3.5" />{lang === 'zh' ? '批量导入' : 'Bulk import'}</button>}
                  {canWrite && selectedItemIds.size > 0 && <button type="button" onClick={() => void deleteItems()} disabled={busy === 'item-delete'} className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-rose-500/40 px-3 text-[13px] font-semibold text-rose-300 transition hover:bg-rose-500/10 disabled:opacity-50"><Trash2 className="h-3.5 w-3.5" />{lang === 'zh' ? `删除所选 (${selectedItemIds.size})` : `Delete selected (${selectedItemIds.size})`}</button>}
                </div>
                {canWrite && <form onSubmit={createItem} className="rounded-xl bg-slate-950/40 px-4 py-3"><div className="flex flex-col gap-2 sm:flex-row"><input value={activeType === 'keyword-libraries' ? itemDraft.keyword : itemDraft.title} onChange={(event) => setItemDraft((previous) => activeType === 'keyword-libraries' ? { ...previous, keyword: event.target.value } : { ...previous, title: event.target.value })} placeholder={activeType === 'keyword-libraries' ? (lang === 'zh' ? '输入关键词' : 'Keyword') : (lang === 'zh' ? '输入标题' : 'Title')} className="h-10 min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500" />{activeType === 'title-libraries' && <input value={itemDraft.relatedKeyword} onChange={(event) => setItemDraft((previous) => ({ ...previous, relatedKeyword: event.target.value }))} placeholder={lang === 'zh' ? '关联关键词（可选）' : 'Related keyword (optional)'} className="h-10 min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500" />}<button type="submit" disabled={busy === 'item-create'} className="inline-flex h-10 items-center justify-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 text-[13px] font-bold text-white hover:bg-indigo-500 disabled:opacity-50"><Plus className="h-3.5 w-3.5" />{lang === 'zh' ? '添加' : 'Add'}</button></div></form>}
                  </div>
                  {activeType === 'title-libraries' && <TitleGenerationPanel apiClient={apiClient} lang={lang} libraryId={materialId(activeRecord)} libraryName={text(activeRecord, 'name')} canWrite={canWrite} onGenerated={() => { void refreshItems(); }} />}
                {itemError && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-950/30 px-3 py-2 text-[13px] text-rose-200">{itemError}</div>}
                {itemsLoading ? <div className="flex min-h-32 items-center justify-center text-[13px] text-slate-500"><Loader2 className="mr-2 h-4 w-4 animate-spin" />{lang === 'zh' ? '读取条目…' : 'Loading items…'}</div> : items.length === 0 ? <EmptyState compact icon={Tag} title={lang === 'zh' ? '此库暂无条目' : 'This library has no items yet'} description={lang === 'zh' ? '用上面的输入框添加，或点「批量导入」一次贴一批。' : 'Add one above, or use bulk import.'} /> : <div className="max-h-[390px] space-y-2 overflow-y-auto pr-1">{items.map((item) => { const id = materialId(item); const itemText = activeType === 'keyword-libraries' ? text(item, 'keyword') : text(item, 'title'); return <label key={id} className="flex cursor-pointer items-start gap-2 rounded-xl bg-slate-950/40 px-4 py-3 transition hover:bg-slate-800/40"><input type="checkbox" checked={selectedItemIds.has(id)} onChange={() => toggleItem(id)} className="mt-0.5 accent-indigo-500" /><span className="min-w-0 flex-1"><span className="block break-words text-[13px] text-slate-200">{itemText || `#${id}`}</span>{activeType === 'title-libraries' && text(item, 'keyword') && <span className="mt-1 block text-[12.5px] text-slate-500">{lang === 'zh' ? '关键词：' : 'Keyword: '}{text(item, 'keyword')}</span>}<span className="mt-1 block text-[12.5px] text-slate-500">{formatDate(item.created_at)}</span></span></label>; })}</div>}
              </div>
            )}

            {/* 空态（照设计稿）：大图标 + 标题 + 说明 + 一块**虚线动作区**。
                ⚠️ 不写「拖拽文件到此处」——我们的上传没实现拖拽，写上去是假承诺。
                虚线框给的是**真的下一步**（新建 / 批量导入），不是装饰。 */}
            {!activeRecord && !formOpen && (
              <div className="flex min-h-[380px] flex-col items-center justify-center px-6 py-14 text-center">
                <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-xl bg-slate-800/60 text-slate-400">
                  <FolderKanban className="h-8 w-8" />
                </div>
                <h3 className="text-[15px] font-bold text-white">
                  {lang === 'zh' ? '这一类还没有内容' : 'Nothing here yet'}
                </h3>
                <p className="mt-2 max-w-md text-[13px] leading-relaxed text-slate-400">
                  {lang === 'zh'
                    ? '写文章要用的「配料」都在这里：标题库（写什么题）、分类、作者、关键词、图片。先在左边的知识目录里挑一类，或直接新建。'
                    : 'Titles, categories, authors, keywords and images all live here. Pick a type on the left, or create one.'}
                </p>

                {canWrite && (
                  <div className="mt-7 w-full max-w-md rounded-xl border border-dashed border-slate-700 px-6 py-7">
                    <Layers className="mx-auto h-6 w-6 text-slate-500" />
                    <p className="mt-2.5 text-[13px] font-medium text-slate-300">
                      {lang === 'zh' ? '先建一个库，再往里放内容' : 'Create a library first'}
                    </p>
                    <p className="mt-1 text-[12px] leading-relaxed text-slate-500">
                      {lang === 'zh'
                        ? '标题库和关键词库建好后支持「批量导入」，一次贴一批；图片库支持直接上传图片。'
                        : 'Title and keyword libraries support bulk import; image libraries accept uploads.'}
                    </p>
                  </div>
                )}

                {canWrite && activeItemsEnabled && (
                  <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                    <span className="text-[12px] text-slate-500">{lang === 'zh' ? '快速开始：' : 'Quick start: '}</span>
                    <button type="button" onClick={() => setFormOpen(true)} className="rounded-lg border border-slate-700 px-2.5 py-1 text-[12px] font-medium text-slate-300 transition hover:bg-slate-800">
                      {lang === 'zh' ? '新建' : 'New'}
                    </button>
                    {(activeType === 'keyword-libraries' || activeType === 'title-libraries') && (
                      <button type="button" onClick={() => setImportOpen(true)} className="rounded-lg border border-slate-700 px-2.5 py-1 text-[12px] font-medium text-slate-300 transition hover:bg-slate-800">
                        {lang === 'zh' ? '批量导入' : 'Bulk import'}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      </div>
          </div>
        </div>
      </div>

      {importOpen && activeRecord && (activeType === 'keyword-libraries' || activeType === 'title-libraries') && (
        <LibraryImportDialog
          apiClient={apiClient}
          lang={lang}
          type={activeType}
          libraryId={materialId(activeRecord)}
          libraryName={text(activeRecord, 'name')}
          onDone={() => { void refreshItems(); }}
          onClose={() => setImportOpen(false)}
        />
      )}
    </div>
  );
};

const PageHeading: React.FC<{ lang: 'zh' | 'en' }> = ({ lang }) => (
  <PageHeader
    icon={FolderKanban}
    group={lang === 'zh' ? '内容中心' : 'Content'}
    title={lang === 'zh' ? '素材库' : 'Materials'}
    description={lang === 'zh'
      ? '写文章要用到的「配料」都在这里：标题库（写什么题）、分类、作者、关键词、图片。'
      : 'Everything article generation needs: title libraries, categories, authors, keywords, images.'}
  />
);

const Field: React.FC<{ label: string; value: string; onChange: (value: string) => void; required?: boolean; type?: string }> = ({ label, value, onChange, required = false, type = 'text' }) => (
  <label className="text-[13px] text-slate-400">{label}{required && <span className="ml-1 text-rose-400">*</span>}<input required={required} type={type} value={value} onChange={(event) => onChange(event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500" /></label>
);

const Stat: React.FC<{ label: string; value: number }> = ({ label, value }) => (
  <div className="rounded-xl bg-slate-950/40 px-4 py-3"><div className="text-caption">{label}</div><div className="mt-1 text-lg font-bold tabular-nums text-white">{value}</div></div>
);

export default MaterialsView;
