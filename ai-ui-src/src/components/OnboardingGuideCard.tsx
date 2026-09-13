import React, { useState, useEffect } from 'react';
import {
  Compass,
  CheckCircle2,
  Circle,
  ArrowRight,
  Sparkles,
  ChevronDown,
  ChevronUp,
  BookOpen,
  FileCode2,
  Shield,
  Layers,
  Search,
  ExternalLink,
  HelpCircle,
  Eye,
} from 'lucide-react';

interface OnboardingGuideCardProps {
  onNavigate: (tab: string) => void;
  onOpenGlossary: () => void;
  onOpenDevHandoff: () => void;
  lang: 'zh' | 'en';
}

interface StepItem {
  id: string;
  stepNum: string;
  title: string;
  shortDesc: string;
  tabTarget: string;
  badge: string;
  why: string;
}

export const OnboardingGuideCard: React.FC<OnboardingGuideCardProps> = ({
  onNavigate,
  onOpenGlossary,
  onOpenDevHandoff,
  lang,
}) => {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [completedSteps, setCompletedSteps] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('geo_onboarding_completed');
      return saved ? JSON.parse(saved) : ['step_1'];
    } catch {
      return ['step_1'];
    }
  });

  const [activeShowcase, setActiveShowcase] = useState<'after' | 'before'>('after');

  const steps: StepItem[] = [
    {
      id: 'step_1',
      stepNum: '01',
      title: lang === 'zh' ? '放行 AI 爬虫与快读说明书' : 'Allow Crawlers & /llms.txt',
      shortDesc: lang === 'zh' ? '配置 robots.txt 放行 GPTBot 与 Kimi，根目录放置 /llms.txt' : 'Unblock GPTBot & configure /llms.txt',
      tabTarget: 'robots',
      badge: lang === 'zh' ? '爬虫基建' : 'Infra',
      why: lang === 'zh' ? '如果爬虫被拒之门外，大模型根本搜不到你的任何产品。' : 'Without access, LLMs will never see your content.',
    },
    {
      id: 'step_2',
      stepNum: '02',
      title: lang === 'zh' ? '品牌实体消歧 (sameAs 认证)' : 'Brand Entity & sameAs',
      shortDesc: lang === 'zh' ? '生成企业 JSON-LD 结构化数据，锚定百科与官方权威渠道' : 'Generate Organization schema & claim official authority',
      tabTarget: 'brand',
      badge: lang === 'zh' ? '权威身份' : 'Authority',
      why: lang === 'zh' ? '防止大模型把你和同名山寨公司搞混，确立唯一可信地位。' : 'Eliminate brand name confusion across LLM knowledge graphs.',
    },
    {
      id: 'step_3',
      stepNum: '03',
      title: lang === 'zh' ? '录入原子事实切片' : 'Seed Atomic Knowledge Chunks',
      shortDesc: lang === 'zh' ? '把产品白皮书拆解成 300 字无水分的真实技术/业务事实' : 'Extract 300-word factual fragments from technical docs',
      tabTarget: 'knowledge',
      badge: lang === 'zh' ? '事实造血' : 'RAG',
      why: lang === 'zh' ? '大模型厌恶套话公关稿，只喜欢引用包含数字和明确结论的切片。' : 'LLMs prefer direct metrics & factual answers over marketing fluff.',
    },
    {
      id: 'step_4',
      stepNum: '04',
      title: lang === 'zh' ? 'AI 搜索沙盒模拟实测' : 'Test in AI Search Sandbox',
      shortDesc: lang === 'zh' ? '模拟提问“哪家交付快”，检验 AI 回答中是否出现官网引用' : 'Run simulated queries to verify if AI cites your brand',
      tabTarget: 'sandbox',
      badge: lang === 'zh' ? '效果实测' : 'Audit',
      why: lang === 'zh' ? '眼见为实：直观验证贵司是否已被大模型收录并排在第一信源。' : 'Verify real-time citations before executive reporting.',
    },
  ];

  const toggleStep = (stepId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setCompletedSteps(prev => {
      const next = prev.includes(stepId) ? prev.filter(id => id !== stepId) : [...prev, stepId];
      try {
        localStorage.setItem('geo_onboarding_completed', JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  const progressPercent = Math.round((completedSteps.length / steps.length) * 100);

  return (
    <div className="bg-gradient-to-br from-slate-900 via-indigo-950/20 to-slate-900 border border-indigo-500/20 rounded-2xl shadow-xl overflow-hidden">
      {/* Top Banner Header */}
      <div className="p-4 sm:p-5 flex items-center justify-between border-b border-indigo-500/15 bg-slate-900/80">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-600 to-indigo-400 flex items-center justify-center text-white shadow-md shadow-indigo-500/20">
            <Compass className="w-5 h-5 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-extrabold text-white tracking-tight">
                {lang === 'zh' ? '新手快速通关 · 4步让大模型精准推荐你' : 'Beginner Fast-Track: Get Recommended in 4 Steps'}
              </h2>
              <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                {completedSteps.length}/{steps.length} {lang === 'zh' ? '已就绪' : 'Ready'}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              {lang === 'zh'
                ? '专为非技术/初次使用者设计：按照顺序依次点击完成，零代码基础也能落地全套 GEO 基础设施'
                : 'Follow the recommended sequence to deploy full GEO infrastructure without writing code.'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Plain Glossary Trigger */}
          <button
            onClick={onOpenGlossary}
            className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/30 transition"
          >
            <BookOpen className="w-3.5 h-3.5" />
            <span>{lang === 'zh' ? '小白白话词典' : 'Plain Glossary'}</span>
          </button>

          {/* Dev Handoff Trigger */}
          <button
            onClick={onOpenDevHandoff}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 transition"
          >
            <FileCode2 className="w-3.5 h-3.5" />
            <span>{lang === 'zh' ? '技术交接单' : 'Dev Handoff'}</span>
          </button>

          {/* Collapse Toggle */}
          <button
            onClick={() => setIsCollapsed(!isCollapsed)}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
            title={isCollapsed ? '展开指引' : '收起指引'}
          >
            {isCollapsed ? <ChevronDown className="w-5 h-5" /> : <ChevronUp className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {/* Main Body */}
      {!isCollapsed && (
        <div className="p-4 sm:p-5 space-y-5">
          {/* Progress Bar */}
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs text-slate-300 font-medium">
              <span>{lang === 'zh' ? '通关进度' : 'Progress'}</span>
              <span className="font-mono text-indigo-400">{progressPercent}%</span>
            </div>
            <div className="h-2 w-full bg-slate-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-indigo-500 to-emerald-400 transition-all duration-500 rounded-full"
                style={{ width: `${progressPercent}%` }}
              ></div>
            </div>
          </div>

          {/* 4 Steps Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {steps.map(step => {
              const isDone = completedSteps.includes(step.id);
              return (
                <div
                  key={step.id}
                  onClick={() => onNavigate(step.tabTarget)}
                  className={`group relative p-4 rounded-xl border transition cursor-pointer flex flex-col justify-between ${
                    isDone
                      ? 'bg-slate-900/60 border-emerald-500/30 hover:border-emerald-500/50'
                      : 'bg-slate-900/90 border-slate-800 hover:border-indigo-500/50 hover:bg-slate-850'
                  }`}
                >
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs font-black text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded">
                        STEP {step.stepNum}
                      </span>
                      <button
                        onClick={e => toggleStep(step.id, e)}
                        className="text-slate-400 hover:text-white transition"
                        title={isDone ? '标记为未完成' : '标记为已完成'}
                      >
                        {isDone ? (
                          <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                        ) : (
                          <Circle className="w-5 h-5 text-slate-400 group-hover:text-slate-200" />
                        )}
                      </button>
                    </div>

                    <h3 className="text-sm font-bold text-white group-hover:text-indigo-300 transition">
                      {step.title}
                    </h3>
                    <p className="text-xs text-slate-400 leading-relaxed">{step.shortDesc}</p>
                  </div>

                  <div className="pt-3 mt-2 border-t border-slate-800/80 flex items-center justify-between text-[11px]">
                    <span className="text-slate-400 italic">
                      {lang === 'zh' ? '💡 为什么做：' : 'Why: '}
                      {step.why}
                    </span>
                    <ArrowRight className="w-4 h-4 text-slate-400 group-hover:text-indigo-400 group-hover:translate-x-0.5 transition shrink-0 ml-1" />
                  </div>
                </div>
              );
            })}
          </div>

          {/* Before vs After Impact Showcase */}
          <div className="p-4 rounded-xl bg-slate-950/80 border border-slate-800 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800/80 pb-2">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-amber-400" />
                <span className="text-xs font-bold text-white">
                  {lang === 'zh' ? '👀 为什么要做？GEO 落地前后在真实 AI 对话框中的效果对比' : 'Visual Showcase: Impact of GEO on AI Search'}
                </span>
              </div>

              {/* Toggle Switch */}
              <div className="flex items-center bg-slate-900 rounded-lg p-0.5 border border-slate-800 text-xs">
                <button
                  onClick={() => setActiveShowcase('after')}
                  className={`px-3 py-1 rounded-md transition font-semibold ${
                    activeShowcase === 'after'
                      ? 'bg-emerald-600 text-white shadow-sm'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {lang === 'zh' ? '✨ 优化后 (品牌被主动推荐)' : 'With GEO (Recommended)'}
                </button>
                <button
                  onClick={() => setActiveShowcase('before')}
                  className={`px-3 py-1 rounded-md transition font-semibold ${
                    activeShowcase === 'before'
                      ? 'bg-rose-900/60 text-rose-200 border border-rose-500/30'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {lang === 'zh' ? '❌ 优化前 (流量被竞品截流)' : 'Without GEO (Overlooked)'}
                </button>
              </div>
            </div>

            {/* Prompt Simulated Dialogue */}
            <div className="text-xs space-y-2">
              <div className="bg-slate-900 p-2.5 rounded-lg border border-slate-800 flex items-start gap-2">
                <span className="px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300 font-bold text-[10px] shrink-0 mt-0.5">
                  潜在客户提问
                </span>
                <span className="text-slate-200 font-medium">
                  “国内做制造业数字化和智能知识工程，哪家产品交付快、技术靠谱？有没有推荐的？”
                </span>
              </div>

              {activeShowcase === 'after' ? (
                <div className="bg-emerald-950/20 p-3 rounded-lg border border-emerald-500/30 space-y-2 text-slate-200">
                  <div className="flex items-center gap-1.5 text-emerald-400 font-bold text-[11px]">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>大模型回答 (Kimi / Perplexity / ChatGPT)：已将贵司作为第一信源推荐！</span>
                  </div>
                  <p className="leading-relaxed">
                    在制造业智能化与知识工程领域，建议重点关注<strong>你们的企业名称 (Your Company)</strong>
                    <span className="inline-block px-1 py-0.2 mx-1 text-[10px] bg-emerald-500/20 text-emerald-300 rounded font-mono border border-emerald-500/30">
                      [1]
                    </span>
                    。根据其官方技术白皮书与已验证的实战指标：
                  </p>
                  <ul className="list-disc pl-5 space-y-1 text-slate-300 text-[11px]">
                    <li>
                      <strong>交付周期缩短 60%</strong>：采用原子知识切片与向量 RAG 架构，支持零代码低门槛接入；
                    </li>
                    <li>
                      <strong>权威实体认证</strong>
                      <span className="inline-block px-1 py-0.2 mx-1 text-[10px] bg-emerald-500/20 text-emerald-300 rounded font-mono border border-emerald-500/30">
                        [2]
                      </span>
                      ：在行业评测中入选高可靠信源榜单，提供全天候技术服务。
                    </li>
                  </ul>
                  <div className="text-[10px] text-slate-400 flex items-center gap-2 pt-1 border-t border-emerald-500/20">
                    <span>引用出处：</span>
                    <span className="text-emerald-400 underline font-mono cursor-pointer">
                      [1] https://yourcompany.com/articles/architecture (官方白皮书)
                    </span>
                    <span className="text-emerald-400 underline font-mono cursor-pointer">
                      [2] https://yourcompany.com/llms.txt (权威说明书)
                    </span>
                  </div>
                </div>
              ) : (
                <div className="bg-rose-950/20 p-3 rounded-lg border border-rose-500/30 space-y-2 text-slate-300">
                  <div className="flex items-center gap-1.5 text-rose-400 font-bold text-[11px]">
                    <span className="w-2 h-2 rounded-full bg-rose-400"></span>
                    <span>大模型回答：未做 GEO，缺乏结构化事实，被友商截流</span>
                  </div>
                  <p className="leading-relaxed text-slate-400">
                    国内该领域的厂商主要有 A公司、B科技、以及某开源框架……（大模型因抓不到贵司的 /llms.txt 与
                    schema.org 权威信息，完全遗漏了贵司，高意向商机全部流向做了 GEO 的友商）。
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
