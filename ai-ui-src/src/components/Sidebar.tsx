import React, { useState } from 'react';
import {
  LayoutDashboard,
  FileText,
  Database,
  FolderKanban,
  Radio,
  BarChart3,
  Sliders,
  Eye,
  Search,
  Layers,
  TrendingUp,
  ChevronDown,
  Activity,
  Settings,
  ClipboardCheck,
  ContactRound,
  Bot,
  RefreshCw,
  Sparkles,
} from 'lucide-react';

interface SidebarProps {
  currentTab: string;
  onSelectTab: (tab: string) => void;
  lang: 'zh' | 'en';
  badgeCounts: {
    articles: number;
    tasks: number;
    channels: number;
  };
  /**
   * 首轮数据还在读取。为 true 时**不渲染数字徽标**——那时的 0 不是「确认没有」，
   * 而是「还没读到」，显示出来就是假计数（与仪表盘骨架同一原则）。
   */
  badgesLoading?: boolean;
  /** Tabs without a real 桐灼GEO API v1 contract are visibly disabled. */
  disabledTabs?: string[];
  /**
   * 本部署有没有 AI 助手。它是**特性开关**控制的能力
   * （`GEOFLOW_AI_WORKSPACE_RUNTIME_ENABLED`，生产默认关），
   * 关掉的部署里**不渲染这个入口**——有入口却用不了比没有入口更糟。
   *
   * `null` = 还没问到（请求未回）。与 `false`（后端明确说关了）区分开，
   * 因为调用方要靠这个区别决定「深链要不要退回总览」。
   */
  aiWorkspaceEnabled?: boolean | null;
  /**
   * 那次能力探测**没问到**（请求失败），与「后端明确回答没开」区分开。
   * 对入口显隐两者一样（都藏），但深链的去向相反——调用方靠 `data-ai-ws` 的取值区分，
   * 冒烟测试也靠它断言「没问到时不改写地址」。
   */
  aiWorkspaceProbeFailed?: boolean;
  mode?: 'demo' | 'geoflow';
}

interface NavItem {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** 只有「需要用户处理的数量」才配数字徽标。 */
  badge?: number;
  /**
   * 也认作本项「当前页」的其它页签 id。
   * 用于合并后的入口：`robots_policy` / `llmstxt` 打开的仍是「站点 SEO」那一页
   * （只是默认页签不同），高亮必须落在「站点 SEO」上，否则深链进来侧栏一个都不亮。
   */
  alsoMatches?: string[];
}

/**
 * 侧边栏**选中态**：浅主色底 + 主色字 + 左侧 3px 指示条。
 *
 * 原来是一整块饱和靛蓝实底（`bg-indigo-600 text-white`）——整屏只有它最亮，
 * 视觉压迫感重，是「消费级 AI 产品」观感的主要来源之一。品牌色还在，
 * 只是从「实心色块」降成「浅底 + 指示条」。
 *
 * **必须带 `dark:` 变体**：这套浅底样式是给亮色做的，深色下 `indigo-100` 仍是
 * Tailwind 原值（近白），会渲染成「深色侧栏里浮出一块浅紫」——本次只重做亮色，
 * 深色必须保持原样。
 *
 * 同时挂 `data-active`：冒烟测试靠它定位当前高亮项（比扫 className 稳定）。
 */
const ACTIVE_NAV_CLASS =
  'relative bg-indigo-100 text-indigo-700 before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[3px] before:rounded-full before:bg-indigo-600 '
  + 'dark:bg-indigo-600 dark:text-white dark:before:bg-indigo-300 dark:before:opacity-70';

/** 选中项图标的配色，与上面配套。 */
const ACTIVE_ICON_CLASS = 'text-indigo-700 dark:text-white';

interface NavGroup {
  groupKey: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  items: NavItem[];
}

/**
 * 一级导航按「用户要完成的任务」组织，不按系统实现分层。
 * 共 6 个一级入口：总览（单页）+ 5 个可折叠分组。
 * tab id 一律不动 —— 深链、权限 scope 与路由都挂在 id 上。
 */
export const Sidebar: React.FC<SidebarProps> = ({
  currentTab,
  onSelectTab,
  lang,
  badgeCounts,
  badgesLoading = false,
  disabledTabs = [],
  aiWorkspaceEnabled = false,
  aiWorkspaceProbeFailed = false,
  mode = 'demo',
}) => {
  const zh = lang === 'zh';

  const navGroups: NavGroup[] = [
    {
      groupKey: 'content',
      label: zh ? '内容中心' : 'Content',
      icon: FileText,
      items: [
        // 「写文章」= 生成流水线（原「生成任务」）。放内容中心，因为它是**写作**，
        // 不是发布动作——原来挂在「发布中心」里，用户写文章时找不到它。
        { id: 'tasks', label: zh ? '写文章' : 'Write', icon: Sparkles, badge: badgeCounts.tasks },
        // 「文章与审核」= 原「文章」（列表 + 审核 + 回收站）。
        { id: 'articles', label: zh ? '文章与审核' : 'Articles & Review', icon: FileText, badge: badgeCounts.articles },
        { id: 'knowledge', label: zh ? '知识库' : 'Knowledge', icon: Database },
        { id: 'materials', label: zh ? '素材库' : 'Materials', icon: FolderKanban },
      ],
    },
    {
      groupKey: 'publish',
      label: zh ? '发布中心' : 'Publishing',
      icon: Radio,
      items: [
        { id: 'distribution', label: zh ? '分发渠道' : 'Channels', icon: Radio, badge: badgeCounts.channels },
        { id: 'manual-publications', label: zh ? '手动发布' : 'Manual Publish', icon: ClipboardCheck },
      ],
    },
    {
      groupKey: 'results',
      label: zh ? 'GEO 效果' : 'Results',
      icon: TrendingUp,
      items: [
        // 三个"AI 怎么回答、引用了谁"的页面合成一个入口，内部 Tab 切换。
        // 被并入的 competitor / sandbox 仍是有效深链（见 tabs.ts 的 MERGED_VIEWS）。
        { id: 'query_radar', label: zh ? 'AI 引用监测' : 'AI Citations', icon: Search, alsoMatches: ['competitor', 'sandbox'] },
        { id: 'analytics', label: zh ? '数据分析' : 'Analytics', icon: BarChart3 },
        // 归因与线索说的是同一件事（AI 带来的访问有没有变成客户）。
        { id: 'attribution_funnel', label: zh ? '转化与线索' : 'Conversion & Leads', icon: ContactRound, alsoMatches: ['leads'] },
      ],
    },
    {
      groupKey: 'diagnosis',
      label: zh ? 'GEO 诊断' : 'Diagnosis',
      icon: Activity,
      items: [
        // 检查类：总览 + 页面体检（原「SEO 总览」「页面体检」）
        { id: 'seo_dashboard', label: zh ? '可发现性总览' : 'Discoverability', icon: Activity, alsoMatches: ['url_scanner'] },
        // 配置类：站点 SEO（robots/sitemap/llms）+ 品牌实体
        { id: 'seo_foundation', label: zh ? '站点与品牌设置' : 'Site & Brand', icon: Layers, alsoMatches: ['brand_entity', 'robots_policy', 'llmstxt'] },
      ],
    },
    {
      groupKey: 'settings',
      label: zh ? '设置' : 'Settings',
      icon: Settings,
      items: [
        { id: 'ai-models', label: zh ? 'AI 模型与提示词' : 'Models & Prompts', icon: Sliders },
        { id: 'admin-settings', label: zh ? '系统设置' : 'System Settings', icon: Settings },
        { id: 'system-updates', label: zh ? '备份与更新' : 'Backup & Update', icon: RefreshCw },
        { id: 'preview', label: zh ? '站点预览' : 'Site Preview', icon: Eye },
      ],
    },
  ];

  // 用户手动展开/收起会覆盖默认；默认只展开「当前页所在的那一组」。
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const itemMatches = (item: NavItem) =>
    item.id === currentTab || (item.alsoMatches ?? []).includes(currentTab);
  const containsActive = (group: NavGroup) => group.items.some(itemMatches);
  const isOpen = (group: NavGroup) => overrides[group.groupKey] ?? containsActive(group);
  const toggle = (group: NavGroup) =>
    setOverrides((prev) => ({ ...prev, [group.groupKey]: !(prev[group.groupKey] ?? containsActive(group)) }));

  const renderItem = (item: NavItem) => {
    const Icon = item.icon;
    const isActive = itemMatches(item);
    const isDisabled = disabledTabs.includes(item.id);
    return (
      <button
        key={item.id}
        type="button"
        disabled={isDisabled}
        onClick={() => onSelectTab(item.id)}
        title={
          isDisabled
            ? zh
              ? '数据口径与业务语义正在核验'
              : 'Data semantics are under verification'
            : undefined
        }
        className={`mb-0.5 w-full flex items-center justify-between rounded-xl py-2.5 pl-10 pr-3 text-[13.5px] transition-colors ${
          isActive
            ? `${ACTIVE_NAV_CLASS} font-semibold`
            : isDisabled
              ? 'cursor-not-allowed text-slate-600 opacity-60'
              : 'font-medium text-slate-600 hover:bg-slate-800/70 hover:text-white'
        }`}
        data-active={isActive}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <Icon className={`h-[18px] w-[18px] shrink-0 ${isActive ? ACTIVE_ICON_CLASS : 'text-slate-400'}`} />
          <span className="truncate">{item.label}</span>
        </div>

        <div className="flex items-center gap-1 shrink-0 ml-1">
          {!badgesLoading && item.badge !== undefined && item.badge > 0 && (
            <span
              className={`text-[10px] px-1.5 py-0.2 rounded-full font-bold tabular-nums ${
                isActive ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300'
              }`}
            >
              {item.badge}
            </span>
          )}
          {isDisabled && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-600 border border-slate-700">
              {zh ? '核验中' : 'Verifying'}
            </span>
          )}
        </div>
      </button>
    );
  };

  const overviewActive = currentTab === 'dashboard';

  // 给冒烟测试的钩子：入口的可见性由后端开关决定，测试要能区分
  // 「后端说没开」（false）、「还没问到」（unknown）和「问了但没问到答案」（probe-failed）
  // ——否则它只能靠等固定秒数来绕过竞态，也测不出「探测失败不该改写深链」这条行为。
  const aiWorkspaceFlagAttr = aiWorkspaceProbeFailed
    ? 'probe-failed'
    : aiWorkspaceEnabled === null
      ? 'unknown'
      : aiWorkspaceEnabled ? 'true' : 'false';

  return (
    <aside data-ai-ws={aiWorkspaceFlagAttr} className="app-sidebar w-64 border-r border-slate-800 p-3 flex flex-col justify-between shrink-0 self-stretch overflow-hidden select-none">
      <div className="space-y-1.5 overflow-y-auto pr-1 flex-1 custom-scrollbar">
        {/* ① 总览 —— 单页，直接进入 */}
        <button
          type="button"
          onClick={() => onSelectTab('dashboard')}
          className={`mb-0.5 w-full flex items-center justify-between rounded-xl px-3 py-2.5 text-[13.5px] transition-colors ${
            overviewActive
              ? `${ACTIVE_NAV_CLASS} font-semibold`
              : 'font-semibold text-slate-200 hover:bg-slate-800/70 hover:text-white'
          }`}
          data-active={overviewActive}
        >
          <div className="flex items-center gap-3 min-w-0">
            <LayoutDashboard className={`w-[18px] h-[18px] shrink-0 ${overviewActive ? ACTIVE_ICON_CLASS : 'text-slate-400'}`} />
            <span className="truncate">{zh ? '工作台' : 'Workspace'}</span>
          </div>
        </button>

        {/* ② AI 助手 —— 单页，紧跟总览（哥哥 2026-09-13：从「设置」里提出来）。
            它是特性开关控制的能力，部署里没开就整个不渲染；还没问到（null）同样不渲染，
            等后端回答了再出现。 */}
        {aiWorkspaceEnabled === true && (
        <button
          type="button"
          onClick={() => onSelectTab('ai-workspace')}
          className={`mb-0.5 w-full flex items-center justify-between rounded-xl px-3 py-2.5 text-[13.5px] transition-colors ${
            currentTab === 'ai-workspace'
              ? `${ACTIVE_NAV_CLASS} font-semibold`
              : 'font-semibold text-slate-200 hover:bg-slate-800/70 hover:text-white'
          }`}
          data-active={currentTab === 'ai-workspace'}
        >
          <div className="flex items-center gap-3 min-w-0">
            <Bot className={`w-[18px] h-[18px] shrink-0 ${currentTab === 'ai-workspace' ? ACTIVE_ICON_CLASS : 'text-slate-400'}`} />
            <span className="truncate">{zh ? 'AI 助手' : 'AI Assistant'}</span>
          </div>
        </button>
        )}

        {/* ③–⑦ 其余分组可展开/收起。分组之间一条极淡的分隔线——
            视觉重设计：让「7 个入口」分段可读，而不是一路平铺。 */}
        {navGroups.map((group, index) => {
          const GroupIcon = group.icon;
          const open = isOpen(group);
          const active = containsActive(group);
          return (
            <div key={group.groupKey} className={index === 0 ? 'pt-1' : 'mt-3 border-t border-slate-800/60 pt-3'}>
              <button
                type="button"
                onClick={() => toggle(group)}
                aria-expanded={open}
                className={`w-full flex items-center justify-between rounded-lg px-3 pb-1.5 pt-2.5 text-[12px] font-semibold tracking-[0.06em] transition-colors ${
                  active ? 'text-indigo-600' : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <GroupIcon className={`h-4 w-4 shrink-0 ${active ? 'text-indigo-500' : 'text-slate-400'}`} />
                  <span className="truncate">{group.label}</span>
                </div>
                <ChevronDown
                  className={`w-4 h-4 shrink-0 text-slate-500 transition-transform ${open ? '' : '-rotate-90'}`}
                />
              </button>

              {open && <div className="space-y-0.5 mt-1">{group.items.map(renderItem)}</div>}
            </div>
          );
        })}
      </div>

      {/* System Status Footer */}
      <div className="pt-3 border-t border-slate-800 shrink-0">
        <div className="flex items-center gap-2 px-3 pb-1 pt-2 text-[11px] text-slate-500">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          <span className="truncate">
            {mode === 'geoflow' ? (zh ? '已连接后台服务' : 'Backend connected') : zh ? '演示模式' : 'Demo mode'}
          </span>
        </div>
      </div>
    </aside>
  );
};
