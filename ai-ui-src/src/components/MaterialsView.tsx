import React, { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { useConfirm } from './ui';
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

/** 图标收窄成「组件」而不是 `React.ElementType`：后者含字符串标签，
 *  传给 `EmptyState` 的 `icon`（要求 ComponentType）会被 tsc 挡下来。 */
const labels: Record<MaterialType, { zh: string; en: string; icon: React.ComponentType<{ className?: string }> }> = {
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
  const confirmDialog = useConfirm();
  const [editing, setEditing] = useState<Material | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<Record<string, string>>(emptyForm);
  const [itemDraft, setItemDraft] = useState({ keyword: '', title: '', relatedKeyword: '' });
  const [importOpen, setImportOpen] = useState(false);
  /** 列表型（分类 / 作者）里「哪一行展开着」。与 `selectedId` 分开：
   *  `selectedId` 是容器型选中哪个库，会被自动填成第一项；
   *  列表型如果复用它，进页面就会自动展开第一行——那是噪音，不是信息。 */
  const [expandedId, setExpandedId] = useState('');

  const activeRecords = records[activeType] || [];
  const activeRecord = activeRecords.find((row) => materialId(row) === selectedId) || null;
  const activeItemsEnabled = ITEM_TYPES.has(activeType as ItemType);

  const localVisibleRecords = useMemo(() => {
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

  /**
   * 服务端搜索结果（为 null 表示「没在搜索」）。
   *
   * 六类库都只加载前 100 条，原来的搜索是在这 100 条里本地过滤：第 101 条之后的记录
   * 「搜不到」，界面却回「没有匹配结果」——运营会以为它被删了。后端一直支持 `search`。
   */
  const [serverRows, setServerRows] = useState<Material[] | null>(null);
  const [serverSearching, setServerSearching] = useState(false);
  useEffect(() => {
    const term = search.trim();
    if (!canRead || term === '') {
      setServerRows(null);
      setServerSearching(false);
      return undefined;
    }
    let cancelled = false;
    setServerSearching(true);
    const timer = window.setTimeout(() => {
      apiClient.listMaterials(activeType, { page: 1, per_page: 100, search: term })
        // 与 `loadMaterials` 同一份投影，只是多了 `search`：类型断言只为对齐 `Material`。
        .then((page) => { if (!cancelled) { setServerRows(pageItems(page) as unknown as Material[]); setServerSearching(false); } })
        .catch(() => { if (!cancelled) { setServerRows(null); setServerSearching(false); } });
    }, 350);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [apiClient, activeType, canRead, search]);

  const serverSearchActive = serverRows !== null;
  const visibleRecords = serverRows ?? localVisibleRecords;

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
    setExpandedId('');
    const first = records[activeType]?.[0];
    setSelectedId(first ? materialId(first) : '');
  }, [activeType]);

  /**
   * 切换类型时**必须把选中项一起换掉**，不能只 `setActiveType` 让下面那个 effect 去补。
   * 两个 effect 的声明顺序是「先重置选中项、后拉条目」，同一次提交里后者仍拿着**上一类的 id**
   * 先发一次必然 404 的请求——界面上就是条目区冒一条红色的「素材不存在」。
   * 在事件处理器里一起设，React 会合成一次渲染，条目请求拿到的就是新 id。
   */
  const selectType = (type: MaterialType) => {
    setActiveType(type);
    const first = records[type]?.[0];
    setSelectedId(first ? materialId(first) : '');
  };

  /**
   * 竞态守卫：给每次条目请求打一个 `类型:id` 的 key，回来时对不上就整个丢弃。
   *
   * 不这么做会看到**上一个库的条目出现在这个库里**——切库时旧请求后到，
   * `setItems` 就把新库的结果覆盖掉了（`itemsLoading` 也被它提前置回 false，
   * 于是界面显示的是「加载完成」的旧数据，最容易被当成真数据读）。
   */
  const itemsRequestKey = useRef('');

  /** 重新拉一次库内条目。导入 / 生成完成后要能立刻看到新内容。 */
  const refreshItems = useCallback(async () => {
    const key = `${activeType}:${selectedId}`;
    itemsRequestKey.current = key;
    if (!activeItemsEnabled || !selectedId || !canRead) {
      setItems([]);
      setItemsLoading(false);
      return;
    }
    setItemsLoading(true);
    setItemError('');
    try {
      const result = await apiClient.listMaterialItems(activeType, selectedId, { page: 1, per_page: 100 });
      if (itemsRequestKey.current !== key) return;
      setItems(pageItems(result));
    } catch (loadError) {
      if (itemsRequestKey.current !== key) return;
      setItemError(errorText(loadError, lang === 'zh' ? '加载库内条目失败' : 'Unable to load library items', lang));
    } finally {
      if (itemsRequestKey.current === key) setItemsLoading(false);
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
    // 用 ConfirmDialog 而不是 window.confirm：原生 confirm 在部分内嵌浏览器里**根本不渲染**，
    // 1ms 就返回 false，表现成「点了删除没反应」（2026-09-20 哥哥就是这么撞上的）。
    if (!(await confirmDialog({
      title: lang === 'zh' ? `删除「${name}」？` : `Delete "${name}"?`,
      description: lang === 'zh' ? '该操作不可撤销。' : 'This cannot be undone.',
      confirmLabel: lang === 'zh' ? '删除' : 'Delete',
      tone: 'danger',
    }))) return;
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
        {!canWrite && <PermissionNotice lang={lang} requiredScope="materials:write" />}
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

      {/* 2026-09-19 版式重做（哥哥：「你重新设计一个行不行」）——
          原来是「左目录 | 库列表 | 库详情」三栏并列。三栏的真问题在中间那栏：
          「分类」「作者」这两类**下面并没有库**，却被硬塞进「库列表 → 库详情」的模子里；
          库少时那栏几乎是空的，空态还写着「先建一个库，再往里放内容」——分类没有"往里放"这回事。
          改成两栏：左目录不动，右侧按**这一类的形状**渲染两种主体——
          ① 列表型（分类 / 作者）：一张表，选中行就地展开，统计与相关面板挂在那一行下面；
          ② 容器型（关键词库 / 标题库 / 图片库 / 知识库）：一条库切换条 + 当前库的工作区。
          两者共用同一个页头行（图标 + 名称 + 计数 + 搜索 + 刷新 + 新建）。 */}
      <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
        <div className="flex flex-col xl:flex-row">
          {/* 左：知识目录（六类，带计数） */}
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
                    onClick={() => selectType(type)}
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

          {/* 右：内容区 */}
          <div className="min-w-0 flex-1 p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4">
              <div className="flex min-w-0 items-center gap-2">
                <ActiveIcon className="h-4 w-4 shrink-0 text-indigo-400" />
                <h2 className="truncate text-section-title">{label}</h2>
                <span className="shrink-0 rounded-md bg-slate-800 px-2 py-0.5 text-[12px] tabular-nums text-slate-400">{summaryCount(activeType)}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative w-44">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={lang === 'zh' ? '搜索' : 'Search'}
                    className="h-9 w-full rounded-xl border border-slate-700 bg-slate-900 py-0 pl-8 pr-3 text-[13px] text-white outline-none transition focus:border-indigo-500"
                  />
                </div>
                {search.trim() !== '' && (
                  <span className="text-[12px] text-slate-500">
                    {serverSearching
                      ? (lang === 'zh' ? '正在全库搜索…' : 'Searching all records…')
                      : serverSearchActive
                        ? (lang === 'zh' ? `全库命中 ${visibleRecords.length} 条` : `${visibleRecords.length} matched`)
                        : ''}
                  </span>
                )}
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

            {(formOpen && canWrite) && (
              <form onSubmit={saveMaterial} className="mb-4 rounded-2xl bg-slate-950/40 p-5">
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

            {loading && activeRecords.length === 0 ? (
              <div className="flex min-h-64 items-center justify-center text-[13px] text-slate-500"><Loader2 className="mr-2 h-4 w-4 animate-spin" />{lang === 'zh' ? '加载中…' : 'Loading…'}</div>
            ) : visibleRecords.length === 0 ? (
              <EmptyState
                compact
                icon={search ? Search : labels[activeType].icon}
                title={search ? (lang === 'zh' ? '没有匹配结果' : 'No matching results') : emptyCopy(activeType, lang).title}
                description={search ? (lang === 'zh' ? '已在全部记录里搜索（不只是当前页），换个关键词试试，或清空搜索框看全部。' : 'Searched all records (not just this page); try another keyword or clear the search.') : emptyCopy(activeType, lang).hint}
                action={!search && canWrite ? (
                  <Button variant="secondary" icon={Plus} onClick={beginCreate}>
                    {lang === 'zh' ? `新建${label}` : `New ${label}`}
                  </Button>
                ) : undefined}
              />
            ) : LIST_TYPES.has(activeType) ? (
              /* ① 列表型：分类 / 作者 —— 这一类的下一层就是文章，没有「库」，所以给一张表；
                    统计与相关面板挂在选中行下面（行内展开），不再单独占一栏。 */
              <div className="overflow-hidden rounded-xl border border-slate-800">
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead className="bg-slate-950/50 text-[12px] text-slate-500">
                      <tr>
                        <th className="px-4 py-2.5 font-medium">{lang === 'zh' ? '名称' : 'Name'}</th>
                        <th className="w-24 px-4 py-2.5 font-medium">{lang === 'zh' ? '关联文章' : 'Articles'}</th>
                        <th className="w-24 px-4 py-2.5 font-medium">{activeType === 'categories' ? (lang === 'zh' ? '排序' : 'Sort') : (lang === 'zh' ? '已删除' : 'Trashed')}</th>
                        <th className="w-32 px-4 py-2.5 font-medium">{lang === 'zh' ? '更新时间' : 'Updated'}</th>
                        <th className="w-20 px-4 py-2.5" />
                      </tr>
                    </thead>
                    <tbody>
                      {visibleRecords.map((record) => {
                        const id = materialId(record);
                        const open = id === expandedId;
                        return (
                          <Fragment key={id}>
                            <tr className={`border-t border-slate-800 transition ${open ? 'bg-slate-800/40' : 'hover:bg-slate-800/20'}`}>
                              <td className="px-4 py-3">
                                <button type="button" onClick={() => setExpandedId(open ? '' : id)} className="flex w-full min-w-0 items-center gap-2 text-left">
                                  <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform ${open ? 'rotate-90' : ''}`} />
                                  <span className="min-w-0 flex-1">
                                    <span className="block truncate text-[13px] font-semibold text-white">{text(record, 'name') || `#${id}`}</span>
                                    <span className="mt-0.5 block truncate text-[12px] text-slate-500">{text(record, 'description') || text(record, 'email') || (lang === 'zh' ? '暂无描述' : 'No description')}</span>
                                  </span>
                                </button>
                              </td>
                              <td className="px-4 py-3 text-[13px] tabular-nums text-slate-300">{number(record, 'article_count')}</td>
                              <td className="px-4 py-3 text-[13px] tabular-nums text-slate-300">{activeType === 'categories' ? number(record, 'sort_order') : number(record, 'trashed_count')}</td>
                              <td className="px-4 py-3 text-[12.5px] text-slate-500">{formatDate(record.updated_at || record.created_at)}</td>
                              <td className="px-4 py-3">
                                {canWrite && (
                                  <div className="flex items-center justify-end gap-1">
                                    <button type="button" title={lang === 'zh' ? '编辑' : 'Edit'} onClick={() => void beginEdit(record)} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-800 hover:text-white">✎</button>
                                    <button type="button" title={lang === 'zh' ? '删除' : 'Delete'} onClick={() => void deleteMaterial(record)} disabled={busy === `delete-${id}`} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-rose-400 transition hover:bg-rose-950/50 disabled:opacity-40"><Trash2 className="h-3.5 w-3.5" /></button>
                                  </div>
                                )}
                              </td>
                            </tr>
                            {open && (
                              <tr className="border-t border-slate-800 bg-slate-950/40">
                                <td colSpan={5} className="px-4 py-4">
                                  <div className="grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
                                    <Stat label={lang === 'zh' ? '关联文章' : 'Articles'} value={number(record, 'article_count')} />
                                    {activeType === 'categories' && <Stat label={lang === 'zh' ? '排序' : 'Sort'} value={number(record, 'sort_order')} />}
                                    {activeType === 'authors' && <Stat label={lang === 'zh' ? '已删除文章' : 'Trashed articles'} value={number(record, 'trashed_count')} />}
                                  </div>
                                  {activeType === 'categories' && text(record, 'slug') && (
                                    <p className="mt-3 text-[12.5px] text-slate-500">Slug <span className="font-mono text-slate-400">{text(record, 'slug')}</span></p>
                                  )}
                                  {activeType === 'authors' && (
                                    <div className="mt-4"><AuthorRecentArticles apiClient={apiClient} lang={lang} authorId={id} /></div>
                                  )}
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              /* ② 容器型：关键词库 / 标题库 / 图片库 / 知识库 —— 库确实存在，所以给一条切换条；
                    选中库的工作区在下面（条目列表 / 图片面板 / 官方知识采纳 / AI 生成标题）。 */
              <>
                <div className="mb-4 flex flex-wrap gap-2">
                  {visibleRecords.map((record) => {
                    const id = materialId(record);
                    const selected = id === selectedId;
                    const badge = recordBadge(activeType, record, lang);
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setSelectedId(id)}
                        title={text(record, 'description')}
                        className={`inline-flex max-w-[15rem] items-center gap-2 rounded-xl border px-3 py-2 text-[13px] font-medium transition ${selected ? 'border-indigo-500/60 bg-indigo-500/10 text-white' : 'border-slate-800 bg-slate-950/40 text-slate-300 hover:border-slate-700 hover:bg-slate-800/60'}`}
                      >
                        <span className="truncate">{text(record, 'name') || `#${id}`}</span>
                        {badge && <span className="shrink-0 text-[11px] tabular-nums text-slate-500">{badge}</span>}
                      </button>
                    );
                  })}
                </div>

                {activeRecord && (
                  <div className="rounded-2xl bg-slate-950/40 p-5">
                    <div className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-slate-800 pb-4">
                      <div className="min-w-0">
                        <h3 className="truncate text-section-title">{text(activeRecord, 'name')}</h3>
                        <p className="mt-1 text-caption">
                          {text(activeRecord, 'description') || (lang === 'zh' ? '暂无描述' : 'No description')}
                          <span className="ml-2 text-slate-500">{formatDate(activeRecord.updated_at || activeRecord.created_at)}</span>
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <span className="rounded-lg bg-slate-800 px-2 py-1 text-[12.5px] text-slate-400">ID {materialId(activeRecord)}</span>
                        {canWrite && <button type="button" title={lang === 'zh' ? '编辑' : 'Edit'} onClick={() => void beginEdit(activeRecord)} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-800 hover:text-white">✎</button>}
                        {canWrite && <button type="button" title={lang === 'zh' ? '删除' : 'Delete'} onClick={() => void deleteMaterial(activeRecord)} disabled={busy === `delete-${materialId(activeRecord)}`} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-rose-400 transition hover:bg-rose-950/50 disabled:opacity-40"><Trash2 className="h-3.5 w-3.5" /></button>}
                      </div>
                    </div>

                    <div className="mb-4 grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
                      <Stat label={lang === 'zh' ? '关联文章' : 'Articles'} value={number(activeRecord, 'article_count')} />
                      {activeType === 'knowledge-bases' && <Stat label={lang === 'zh' ? '字符数' : 'Characters'} value={number(activeRecord, 'character_count')} />}
                      {activeType === 'knowledge-bases' && <Stat label={lang === 'zh' ? '切片数' : 'Chunks'} value={number(activeRecord, 'chunk_count')} />}
                    </div>

                    {activeType === 'image-libraries' && (
                      <ImageLibraryPanel apiClient={apiClient} lang={lang} libraryId={materialId(activeRecord)} canWrite={canWrite} />
                    )}

                    {activeType === 'knowledge-bases' && (
                      <KnowledgeOfficialAdoptPanel apiClient={apiClient} lang={lang} knowledgeBaseId={materialId(activeRecord)} canWrite={canWrite} />
                    )}

                    {activeItemsEnabled && (
                      <div className="space-y-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="whitespace-nowrap text-[13px] font-semibold text-slate-200">{activeType === 'keyword-libraries' ? (lang === 'zh' ? '关键词条目' : 'Keywords') : (lang === 'zh' ? '标题条目' : 'Titles')} <span className="text-caption">({items.length})</span></div>
                          <div className="flex items-center gap-2">
                          {canWrite && <button type="button" onClick={() => setImportOpen(true)} className="inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-xl border border-indigo-500/40 px-3 text-[13px] font-semibold text-indigo-300 transition hover:bg-indigo-500/10"><Upload className="h-3.5 w-3.5" />{lang === 'zh' ? '批量导入' : 'Bulk import'}</button>}
                          {canWrite && selectedItemIds.size > 0 && <button type="button" onClick={() => void deleteItems()} disabled={busy === 'item-delete'} className="inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-xl border border-rose-500/40 px-3 text-[13px] font-semibold text-rose-300 transition hover:bg-rose-500/10 disabled:opacity-50"><Trash2 className="h-3.5 w-3.5" />{lang === 'zh' ? `删除所选 (${selectedItemIds.size})` : `Delete selected (${selectedItemIds.size})`}</button>}
                          </div>
                        </div>
                        {/* 新增条目的表单**单独成行**，不挤在标题行里——挤在一起时 1024px 下
                            「标题条目 (26)」和「批量导入」都会断成两行（实测）。 */}
                        {canWrite && <form onSubmit={createItem} className="rounded-xl bg-slate-900/60 px-4 py-3"><div className="flex flex-col gap-2 sm:flex-row"><input value={activeType === 'keyword-libraries' ? itemDraft.keyword : itemDraft.title} onChange={(event) => setItemDraft((previous) => activeType === 'keyword-libraries' ? { ...previous, keyword: event.target.value } : { ...previous, title: event.target.value })} placeholder={activeType === 'keyword-libraries' ? (lang === 'zh' ? '输入关键词' : 'Keyword') : (lang === 'zh' ? '输入标题' : 'Title')} className="h-10 min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500" />{activeType === 'title-libraries' && <input value={itemDraft.relatedKeyword} onChange={(event) => setItemDraft((previous) => ({ ...previous, relatedKeyword: event.target.value }))} placeholder={lang === 'zh' ? '关联关键词（可选）' : 'Related keyword (optional)'} className="h-10 min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500" />}<button type="submit" disabled={busy === 'item-create'} className="inline-flex h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl bg-indigo-600 px-3.5 text-[13px] font-bold text-white hover:bg-indigo-500 disabled:opacity-50"><Plus className="h-3.5 w-3.5" />{lang === 'zh' ? '添加' : 'Add'}</button></div></form>}
                          {activeType === 'title-libraries' && <TitleGenerationPanel apiClient={apiClient} lang={lang} libraryId={materialId(activeRecord)} libraryName={text(activeRecord, 'name')} canWrite={canWrite} onGenerated={() => { void refreshItems(); }} />}
                        {itemError && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-950/30 px-3 py-2 text-[13px] text-rose-200">{itemError}</div>}
                        {itemsLoading ? <div className="flex min-h-32 items-center justify-center text-[13px] text-slate-500"><Loader2 className="mr-2 h-4 w-4 animate-spin" />{lang === 'zh' ? '读取条目…' : 'Loading items…'}</div> : items.length === 0 ? <EmptyState compact icon={Tag} title={lang === 'zh' ? '此库暂无条目' : 'This library has no items yet'} description={lang === 'zh' ? '用上面的输入框添加，或点「批量导入」一次贴一批。' : 'Add one above, or use bulk import.'} /> : <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">{items.map((item) => { const id = materialId(item); const itemText = activeType === 'keyword-libraries' ? text(item, 'keyword') : text(item, 'title'); return <label key={id} className="flex cursor-pointer items-start gap-2 rounded-xl bg-slate-900/60 px-4 py-3 transition hover:bg-slate-800/40"><input type="checkbox" checked={selectedItemIds.has(id)} onChange={() => toggleItem(id)} className="mt-0.5 accent-indigo-500" /><span className="min-w-0 flex-1"><span className="block break-words text-[13px] text-slate-200">{itemText || `#${id}`}</span>{activeType === 'title-libraries' && text(item, 'keyword') && <span className="mt-1 block text-[12.5px] text-slate-500">{lang === 'zh' ? '关键词：' : 'Keyword: '}{text(item, 'keyword')}</span>}<span className="mt-1 block text-[12.5px] text-slate-500">{formatDate(item.created_at)}</span></span></label>; })}</div>}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
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

/** 「分类」「作者」这两类的下一层直接是文章——它们自己没有「库」这一层，
 *  所以渲染成一张表（选中行就地展开），而不是「库切换条 + 工作区」。
 *  其余四类（关键词库 / 标题库 / 图片库 / 知识库）下面确实有库，走容器型。 */
const LIST_TYPES = new Set<MaterialType>(['categories', 'authors']);

/** 空态文案按类型给。改用这条之前，六类共用同一句「先建一个库，再往里放内容」——
 *  对分类和作者是错的：它们没有「往里放」这回事。 */
function emptyCopy(type: MaterialType, lang: 'zh' | 'en'): { title: string; hint: string } {
  const zh = lang === 'zh';
  switch (type) {
    case 'categories':
      return { title: zh ? '还没有分类' : 'No categories yet', hint: zh ? '分类用来给文章归档，每篇文章都要归到一个分类下。' : 'Categories file your articles.' };
    case 'authors':
      return { title: zh ? '还没有作者' : 'No authors yet', hint: zh ? '作者关联文章——展开一行可以看到该作者最近的文章。' : 'Authors are linked to articles.' };
    case 'keyword-libraries':
      return { title: zh ? '还没有关键词库' : 'No keyword libraries yet', hint: zh ? '建好之后可以用「批量导入」一次贴一批关键词。' : 'Bulk import is available once created.' };
    case 'title-libraries':
      return { title: zh ? '还没有标题库' : 'No title libraries yet', hint: zh ? '生成任务按标题库选题——没有它，生成任务不知道每篇文章该写什么。' : 'Generation tasks pick titles from a library.' };
    case 'image-libraries':
      return { title: zh ? '还没有图片库' : 'No image libraries yet', hint: zh ? '建好之后可以直接往里面传图片。' : 'Image libraries accept uploads.' };
    default:
      return { title: zh ? '还没有知识库' : 'No knowledge bases yet', hint: zh ? '知识库可供正文引用，内容会切成片段入库。' : 'Knowledge bases are chunked and referenced when writing.' };
  }
}

/** 库切换条上那个小计数。图片库没有可显示的计数，返回空串（不画假的 0）。 */
function recordBadge(type: MaterialType, record: ApiRecord, lang: 'zh' | 'en'): string {
  const zh = lang === 'zh';
  switch (type) {
    case 'keyword-libraries':
      return `${number(record, 'item_count') || number(record, 'keyword_count')} ${zh ? '词' : 'kw'}`;
    case 'title-libraries':
      return `${number(record, 'item_count') || number(record, 'title_count')} ${zh ? '条' : 'items'}`;
    case 'knowledge-bases':
      return `${number(record, 'chunk_count')} ${zh ? '切片' : 'chunks'}`;
    case 'image-libraries':
      // 后端投影早就给了 `image_count` / `item_count`，这里却一直返回空串——
      // 「这库有多少图」在库切换条上完全看不到。
      return `${number(record, 'image_count') || number(record, 'item_count')} ${zh ? '张' : 'images'}`;
    default:
      return '';
  }
}

export default MaterialsView;
