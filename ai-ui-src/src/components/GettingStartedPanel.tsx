import React, { useEffect, useState } from 'react';
import { CheckCircle2, Circle, ChevronDown, ChevronRight, Rocket, AlertTriangle } from 'lucide-react';

/** 「开始使用」清单里的一步。`done` 一律由**真实业务数据**推导，不写死。 */
export interface GettingStartedStep {
  key: string;
  title: string;
  /** 当前的真实状态，一句话；已配好时也要能看见「配了什么」。 */
  detail: string;
  done: boolean;
  /** 未完成时的去处。缺省表示这一步没有可跳转的页面（例如「生成第一篇文章」只能在这里点）。 */
  action?: { label: string; onClick: () => void };
  /** 步骤本身无法完成的原因（例如没有权限），显示为提示而非去路。 */
  blockedReason?: string;
}

interface GettingStartedPanelProps {
  steps: GettingStartedStep[];
  lang: 'zh' | 'en';
}

const COLLAPSE_KEY = 'geoflow.gettingStarted.collapsed';

/**
 * 总览页顶部的「开始使用」清单。
 *
 * ## 为什么是清单而不是弹窗向导
 *
 * 原本的设想是「首次登录弹一个 4 步向导」。没这么做，原因有两条：
 *
 * 1. **「首次」没有诚实的判据。** 服务端没有「这个管理员看过向导了」的记录，
 *    只能用 localStorage 记。换个浏览器、换台机器就会再弹一次，而用户其实早配好了
 *    ——弹窗拦在总览前面又没法解释自己为什么出现。这里改成由**真实就绪度**驱动：
 *    配齐了它自己消失，没配齐才出现，判据本身就是事实。
 * 2. **弹窗里的表单必然与真实页面漂移。** 向导如果要内嵌「选模型/建知识库/加标题」，
 *    就是第二套表单，改一边忘一边是迟早的事。这里每一步只显示真实状态 + 一个
 *    「去配置 →」跳到既有页面，**不自己造任何输入控件**，所以永远不会与真实页面不一致。
 *
 * 另外它顺手解决了「总览只有数字、没有入口」：清单本身就是按顺序的快捷入口。
 *
 * ## 手动收起
 *
 * 收起状态存 localStorage——那是个**界面偏好**，不是业务事实，用它记不影响任何判断。
 * 收起后仍留一条带进度的细条，用户想接着配时找得到。
 */
export const GettingStartedPanel: React.FC<GettingStartedPanelProps> = ({ steps, lang }) => {
  const zh = lang === 'zh';
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === '1');
    } catch {
      // 隐私模式下 localStorage 会抛异常；收不起来自动展开即可，不影响功能。
    }
  }, []);

  const toggle = (next: boolean) => {
    setCollapsed(next);
    try {
      window.localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
    } catch {
      // 同上：存不下就只在本次会话里生效。
    }
  };

  const doneCount = steps.filter((step) => step.done).length;
  const total = steps.length;
  // 全部配齐就整块消失——常驻的「开始使用」会变成另一种噪音。
  if (total === 0 || doneCount === total) return null;

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => toggle(false)}
        className="w-full flex items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-900/80 px-4 py-2.5 text-left transition hover:border-indigo-500/40"
      >
        <span className="flex items-center gap-2 text-xs font-semibold text-slate-300">
          <Rocket className="h-4 w-4 text-indigo-400" />
          {zh ? `开始使用（${doneCount} / ${total}）` : `Getting started (${doneCount}/${total})`}
        </span>
        <ChevronRight className="h-4 w-4 text-slate-500" />
      </button>
    );
  }

  return (
    <section
      data-getting-started
      className="rounded-2xl border border-indigo-500/30 bg-indigo-500/5 p-4 space-y-3"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Rocket className="h-4 w-4 shrink-0 text-indigo-400" />
          <h2 className="text-sm font-bold text-white">{zh ? '开始使用' : 'Getting started'}</h2>
          <span className="text-[11px] text-slate-400 tabular-nums">
            {doneCount} / {total}
          </span>
        </div>
        <button
          type="button"
          onClick={() => toggle(true)}
          className="flex items-center gap-1 text-[11px] text-slate-400 transition hover:text-slate-200"
        >
          <ChevronDown className="h-3.5 w-3.5 rotate-180" />
          {zh ? '收起' : 'Collapse'}
        </button>
      </div>

      <ol className="space-y-1.5">
        {steps.map((step, index) => (
          <li
            key={step.key}
            data-step={step.key}
            data-done={step.done}
            className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2.5"
          >
            <div className="flex items-start gap-2.5 min-w-0">
              {step.done
                ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />}
              <div className="min-w-0">
                <div className={`text-xs font-semibold ${step.done ? 'text-slate-400 line-through' : 'text-white'}`}>
                  {index + 1}. {step.title}
                </div>
                <div className="mt-0.5 text-[11px] leading-relaxed text-slate-400">{step.detail}</div>
                {step.blockedReason && !step.done && (
                  <div className="mt-1 flex items-start gap-1 text-[11px] leading-relaxed text-amber-300">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>{step.blockedReason}</span>
                  </div>
                )}
              </div>
            </div>
            {/* 被拦住时只显示原因（上面那条），不给按钮——否则用户点进一个永远提交不了的弹窗。 */}
            {!step.done && step.action && !step.blockedReason && (
              <button
                type="button"
                onClick={step.action.onClick}
                className="shrink-0 rounded-lg bg-indigo-600 px-3 py-1.5 text-[11px] font-bold text-white transition hover:bg-indigo-500"
              >
                {step.action.label}
              </button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
};
