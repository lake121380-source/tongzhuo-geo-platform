import React from 'react';

/**
 * 迷你趋势线（sparkline）。
 *
 * 为什么手写 SVG 而不是引图表库：只要一条折线 + 一块面积，引库要多几百 KB
 * 体积和一套主题配置；而稿子里的图本来就是手写 SVG 的。
 *
 * **它只画真实序列**：`values` 少于两个点时不渲染——一个点画不出趋势，
 * 硬画出来是一条平的直线，会让人以为「一直很稳」。
 * 数值全为 0 时画一条贴底的线，那也是事实（这段时间确实没有访问）。
 */
export const Sparkline: React.FC<{
  values: number[];
  /** 宽度（viewBox 单位，实际由 CSS 拉伸） */
  width?: number;
  height?: number;
  className?: string;
  /** 无障碍标签：读屏用户看不到折线，需要一句话说清它在表达什么。 */
  label?: string;
}> = ({ values, width = 120, height = 32, className = '', label }) => {
  if (!Array.isArray(values) || values.length < 2) return null;
  const nums = values.map((v) => (Number.isFinite(v) ? Number(v) : 0));
  const max = Math.max(...nums);
  const min = Math.min(...nums);
  const span = max - min || 1;
  const stepX = width / (nums.length - 1);
  const pad = 2;
  const usable = height - pad * 2;

  const points = nums.map((v, i) => {
    const x = i * stepX;
    // 值越大越靠上（SVG 的 y 轴向下）
    const y = pad + usable - ((v - min) / span) * usable;
    return [x, y] as const;
  });

  const line = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={`h-8 w-full overflow-visible ${className}`}
      preserveAspectRatio="none"
      role={label ? 'img' : 'presentation'}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <path d={area} fill="currentColor" opacity="0.12" />
      <path d={line} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
};

/**
 * 趋势折线图（带坐标轴与网格线）。
 *
 * 手写 SVG，理由同 Sparkline：只要折线 + 面积 + 几条参考线，引图表库不划算。
 *
 * **只画真实序列**：`series[].values` 少于两个点时整块不渲染——一个点画不出趋势。
 * 支持多条线（例如「总访问」与「AI 爬虫」），每条自己选色。
 * 值为 0 的线**照画**（贴着底），那也是有信息量的事实：这段时间确实没有。
 */
export const TrendChart: React.FC<{
  /** x 轴标签，与各 series 的 values 一一对应 */
  labels: string[];
  series: Array<{ name: string; values: number[]; tone: string }>;
  height?: number;
  className?: string;
}> = ({ labels, series, height = 200, className = '' }) => {
  const usable = series.filter((s) => Array.isArray(s.values) && s.values.length >= 2);
  if (usable.length === 0 || labels.length < 2) return null;

  const W = 600;
  const H = height;
  const padL = 8;
  const padR = 8;
  const padT = 10;
  const padB = 22;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const all = usable.flatMap((s) => s.values);
  const max = Math.max(...all, 1);
  const stepX = plotW / (labels.length - 1);
  const y = (v: number) => padT + plotH - (v / max) * plotH;

  // x 轴只标首、中、尾三个，避免中文日期挤成一团
  const tickIdx = [0, Math.floor((labels.length - 1) / 2), labels.length - 1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={`w-full ${className}`} preserveAspectRatio="none" role="img" aria-label={usable.map((s) => s.name).join(' / ')}>
      {/* 横向参考线：0 / 50% / 100% */}
      {[0, 0.5, 1].map((r) => (
        <line key={r} x1={padL} x2={W - padR} y1={padT + plotH * r} y2={padT + plotH * r} stroke="currentColor" strokeOpacity="0.08" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      ))}
      {usable.map((s) => {
        const pts = s.values.map((v, i) => [padL + i * stepX, y(v)] as const);
        const line = pts.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
        return (
          <g key={s.name} className={s.tone}>
            <path d={`${line} L${padL + plotW},${padT + plotH} L${padL},${padT + plotH} Z`} fill="currentColor" opacity="0.1" />
            <path d={line} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
          </g>
        );
      })}
      {tickIdx.map((i) => (
        <text key={i} x={padL + i * stepX} y={H - 6} textAnchor={i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle'} className="fill-current text-slate-500" style={{ fontSize: 12.5 }}>
          {labels[i]}
        </text>
      ))}
    </svg>
  );
};

/**
 * 横向条形面板。
 *
 * 每行：标签 —— 条形 —— 数值/占比。条宽按**最大值**归一（不是按占比），
 * 因为要比较的是「谁多谁少」；占比单独用文字给，两者不混。
 *
 * `items` 为空时**不渲染**——留一张空面板比不显示更让人困惑。
 */
export const BarList: React.FC<{
  items: Array<{ label: string; value: number; note?: string }>;
  className?: string;
  /** 条的颜色类，例如 text-indigo-500 */
  tone?: string;
}> = ({ items, className = '', tone = 'text-slate-400' }) => {
  if (!Array.isArray(items) || items.length === 0) return null;
  const max = Math.max(...items.map((i) => (Number.isFinite(i.value) ? i.value : 0))) || 1;
  const total = items.reduce((sum, i) => sum + (Number.isFinite(i.value) ? i.value : 0), 0);

  return (
    <ul className={`space-y-3 ${className}`}>
      {items.map((item) => {
        const pct = total > 0 ? Math.round((item.value / total) * 100) : 0;
        return (
          <li key={item.label}>
            <div className="mb-1 flex items-baseline justify-between gap-3 text-[13px]">
              <span className="truncate text-slate-300">{item.label}</span>
              <span className="shrink-0 tabular-nums text-slate-400">
                {item.value}
                {item.note ? <span className="ml-1.5 text-[11px]">{item.note}</span> : <span className="ml-1.5 text-[11px]">({pct}%)</span>}
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
              <div
                className={`h-full rounded-full bg-current ${tone}`}
                style={{ width: `${Math.max(2, (item.value / max) * 100)}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
};
