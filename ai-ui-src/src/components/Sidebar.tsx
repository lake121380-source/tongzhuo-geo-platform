import React, { useState } from 'react';
import {
  LayoutDashboard,
  Sparkles,
  FileText,
  Workflow,
  Database,
  FolderKanban,
  Radio,
  BarChart3,
  Sliders,
  Eye,
  FileCode2,
  Compass,
  Flame,
  Search,
  Globe,
  ShieldCheck,
  Layers,
  Award,
  TrendingUp,
  ChevronDown,
  Activity,
  Settings,
  ClipboardCheck,
  ContactRound,
  Bot,
  RefreshCw,
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
  /** Tabs without a real 桐灼GEO API v1 contract are visibly disabled. */
  disabledTabs?: string[];
  mode?: 'demo' | 'geoflow';
}

interface NavItem {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** 只有「需要用户处理的数量」才配数字徽标。 */
  badge?: number;
}

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
  disabledTabs = [],
  mode = 'demo',
}) => {
  const zh = lang === 'zh';

  const navGroups: NavGroup[] = [
    {
      groupKey: 'diagnosis',
      label: zh ? 'GEO 诊断' : 'Diagnosis',
      icon: Activity,
      items: [
        { id: 'brand_entity', label: zh ? '品牌实体' : 'Brand Entity', icon: Award },
        { id: 'seo_dashboard', label: zh ? 'SEO 总览' : 'SEO Overview', icon: Activity },
        { id: 'url_scanner', label: zh ? '页面体检' : 'Page Inspector', icon: Globe },
        { id: 'seo_foundation', label: zh ? '站点 SEO' : 'Site SEO', icon: Layers },
        { id: 'robots_policy', label: zh ? '爬虫策略' : 'Crawler Policy', icon: ShieldCheck },
        { id: 'llmstxt', label: zh ? 'llms.txt' : 'llms.txt', icon: FileCode2 },
      ],
    },
    {
      groupKey: 'content',
      label: zh ? '内容中心' : 'Content',
      icon: Sparkles,
      items: [
        { id: 'generator', label: zh ? '写文章' : 'Write', icon: Sparkles },
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
        { id: 'tasks', label: zh ? '生成任务' : 'Generation Tasks', icon: Workflow, badge: badgeCounts.tasks },
        { id: 'manual-publications', label: zh ? '手动发布' : 'Manual Publish', icon: ClipboardCheck },
      ],
    },
    {
      groupKey: 'results',
      label: zh ? 'GEO 效果' : 'Results',
      icon: TrendingUp,
      items: [
        { id: 'query_radar', label: zh ? 'AI 问答监测' : 'AI Answer Tracking', icon: Search },
        { id: 'competitor', label: zh ? '竞品对比' : 'Competitors', icon: Flame },
        { id: 'sandbox', label: zh ? '引用测试' : 'Citation Test', icon: Compass },
        { id: 'analytics', label: zh ? '数据分析' : 'Analytics', icon: BarChart3 },
        { id: 'attribution_funnel', label: zh ? 'AI 引流与转化' : 'AI Traffic & Conversion', icon: TrendingUp },
        { id: 'leads', label: zh ? '线索' : 'Leads', icon: ContactRound },
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
        { id: 'ai-workspace', label: zh ? 'AI 助手' : 'AI Assistant', icon: Bot },
      ],
    },
  ];

  // 用户手动展开/收起会覆盖默认；默认只展开「当前页所在的那一组」。
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const containsActive = (group: NavGroup) => group.items.some((item) => item.id === currentTab);
  const isOpen = (group: NavGroup) => overrides[group.groupKey] ?? containsActive(group);
  const toggle = (group: NavGroup) =>
    setOverrides((prev) => ({ ...prev, [group.groupKey]: !(prev[group.groupKey] ?? containsActive(group)) }));

  const renderItem = (item: NavItem) => {
    const Icon = item.icon;
    const isActive = currentTab === item.id;
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
        className={`w-full flex items-center justify-between pl-8 pr-2.5 py-2 rounded-lg text-xs font-medium transition-all ${
          isActive
            ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-600/30'
            : isDisabled
              ? 'cursor-not-allowed text-slate-600 opacity-60'
              : 'text-slate-300 hover:bg-slate-800/80 hover:text-white'
        }`}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-white' : 'text-slate-400'}`} />
          <span className="truncate">{item.label}</span>
        </div>

        <div className="flex items-center gap-1 shrink-0 ml-1">
          {item.badge !== undefined && item.badge > 0 && (
            <span
              className={`text-[10px] px-1.5 py-0.2 rounded-full font-bold tabular-nums ${
                isActive ? 'bg-indigo-700 text-white' : 'bg-slate-800 text-slate-300'
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

  return (
    <aside className="w-64 border-r border-slate-800 bg-slate-900/90 p-3 flex flex-col justify-between shrink-0 self-stretch overflow-hidden select-none">
      <div className="space-y-1 overflow-y-auto pr-1 flex-1 custom-scrollbar">
        {/* ① 总览 —— 单页，直接进入 */}
        <button
          type="button"
          onClick={() => onSelectTab('dashboard')}
          className={`w-full flex items-center justify-between px-2.5 py-2 rounded-lg text-xs font-semibold transition-all ${
            overviewActive
              ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-600/30'
              : 'text-slate-200 hover:bg-slate-800/80 hover:text-white'
          }`}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <LayoutDashboard className={`w-4 h-4 shrink-0 ${overviewActive ? 'text-white' : 'text-slate-400'}`} />
            <span className="truncate">{zh ? '总览' : 'Overview'}</span>
          </div>
        </button>

        {/* ②–⑥ 其余五个一级入口可展开/收起 */}
        {navGroups.map((group) => {
          const GroupIcon = group.icon;
          const open = isOpen(group);
          const active = containsActive(group);
          return (
            <div key={group.groupKey}>
              <button
                type="button"
                onClick={() => toggle(group)}
                aria-expanded={open}
                className={`w-full flex items-center justify-between px-2.5 py-2 rounded-lg text-xs font-semibold transition-all ${
                  active && !open
                    ? 'text-white bg-slate-800/60'
                    : 'text-slate-200 hover:bg-slate-800/80 hover:text-white'
                }`}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <GroupIcon className={`w-4 h-4 shrink-0 ${active ? 'text-indigo-300' : 'text-slate-400'}`} />
                  <span className="truncate">{group.label}</span>
                </div>
                <ChevronDown
                  className={`w-3.5 h-3.5 shrink-0 text-slate-500 transition-transform ${open ? '' : '-rotate-90'}`}
                />
              </button>

              {open && <div className="space-y-0.5 mt-0.5">{group.items.map(renderItem)}</div>}
            </div>
          );
        })}
      </div>

      {/* System Status Footer */}
      <div className="pt-3 border-t border-slate-800 shrink-0">
        <div className="p-2.5 bg-slate-800/50 rounded-lg border border-slate-800 text-xs">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
              <span className="text-slate-200 font-semibold text-xs">
                {mode === 'geoflow' ? (zh ? '已连接后台服务' : 'Backend connected') : zh ? '演示模式' : 'Demo mode'}
              </span>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
};
