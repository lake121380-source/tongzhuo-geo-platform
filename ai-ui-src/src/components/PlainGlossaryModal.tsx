import React, { useState } from 'react';
import {
  HelpCircle,
  X,
  Search,
  BookOpen,
  Sparkles,
  ExternalLink,
  CheckCircle2,
  Copy,
  Info,
} from 'lucide-react';

interface PlainGlossaryModalProps {
  isOpen: boolean;
  onClose: () => void;
  lang: 'zh' | 'en';
}

interface GlossaryItem {
  id: string;
  term: string;
  pronounce?: string;
  category: 'seo_geo' | 'crawler' | 'ai_rag' | 'metrics';
  oneSentence: string;
  plainExplanation: string;
  whyItMatters: string;
  example: string;
}

const glossaryData: GlossaryItem[] = [
  {
    id: 'geo',
    term: 'GEO (Generative Engine Optimization)',
    pronounce: '生成式引擎优化',
    category: 'seo_geo',
    oneSentence: '把传统让百度/谷歌排名的做法，升级为让 ChatGPT/Kimi/Perplexity 主动引用并推荐你的品牌。',
    plainExplanation:
      '传统的 SEO 是争夺搜索结果第 1 页的蓝色链接，而大模型时代用户直接要答案。GEO 的核心就是把你的企业资质、产品参数与独特优势，加工成大模型最喜欢抓取和采纳的高密度知识，让 AI 在回答潜在客户提问时把你作为第一信源。',
    whyItMatters: '未来 70% 的高意向采购决策发生在 AI 对话框里，不做 GEO 等于向 AI 主动放弃品牌声量。',
    example: '用户问：“国内有哪些交付快的外贸 ERP？” -> AI 在答案首句直接引用贵司名字及官网链接 [1]。',
  },
  {
    id: 'sameas',
    term: 'schema.org sameAs 实体锚定',
    pronounce: '权威身份唯一标识',
    category: 'seo_geo',
    oneSentence: '相当于给 AI 搜索引擎出示的一套“企业官方营业执照与多平台认证网”。',
    plainExplanation:
      '全世界有成千上万重名的品牌或同名词汇。在官网代码的 JSON-LD 里加上 sameAs，列出你们在百度百科、国家企业信用、GitHub、维基百科或官方公众号等权威链接。AI 读到后就会 100% 确认：“这家公司就是那家真实权威企业，绝不是山寨冒牌货”。',
    whyItMatters: '消除大模型的同名歧义，避免 AI 把贵司与劣质小作坊混淆，直接提升知识图谱权重。',
    example: '"sameAs": ["https://baike.baidu.com/item/你的品牌词条", "https://github.com/your-org"]',
  },
  {
    id: 'llms-txt',
    term: '/llms.txt 规范文件',
    pronounce: '大模型专用快读说明书',
    category: 'crawler',
    oneSentence: '专门为大模型爬虫量身定做的“浓缩版全站纯文本索引”，比普通网页抓取速度快 10 倍。',
    plainExplanation:
      '普通网页里充满了复杂的 CSS 动画、广告弹窗、冗余脚手架，大模型抓取既费算力又容易遗漏。/llms.txt 是 Anthropic、OpenAI 倡导的新兴标准，将企业最核心的定位、核心 API、产品清单整理成纯净的 Markdown 文本，爬虫 1 秒钟就能读完。',
    whyItMatters: 'AI 蜘蛛极其喜欢低成本、高密度的结构化文本，/llms.txt 是大模型极速收录的首选通道。',
    example: '在官网根目录放一个 https://yourcompany.com/llms.txt 文件。',
  },
  {
    id: 'robots-txt',
    term: 'robots.txt AI 防火墙',
    pronounce: '爬虫通行许可证',
    category: 'crawler',
    oneSentence: '放在网站根目录的一个文本文件，用于告诉哪些 AI 爬虫可以进门抓取，哪些要阻拦。',
    plainExplanation:
      '网站服务器的“门卫大爷”。很多传统网站配置过于严格，把 GPTBot、PerplexityBot、ClaudeBot 等 AI 爬虫一概拦截了，导致这些大模型永远读不到你的最新产品更新。我们需要明确配置 Allow 规则放行合法 AI 搜索爬虫。',
    whyItMatters: '如果门关着，即使你的官网做得再好，大模型也根本“看不见”你。',
    example: 'User-agent: GPTBot \\n Allow: /',
  },
  {
    id: 'ssr-static',
    term: 'SSR / 纯静态直出 (Static HTML)',
    pronounce: '即开即看无白屏',
    category: 'seo_geo',
    oneSentence: '网页打开时直接呈现完整中文文字，而不是先加载一堆 JS 代码再慢慢渲染。',
    plainExplanation:
      '很多前端程序员用 Vue / React 单页应用搭建官网，人在浏览器里能看到，但简易的爬虫拿到的是一片空标签（`<div id="root"></div>`）。AI 爬虫抓取预算非常有限，不会花数秒钟去执行复杂的 JS 脚本。纯静态直出保证爬虫第一毫秒就能拿到所有事实。',
    whyItMatters: '如果页面内容依赖客户端 JS 动态渲染，AI 爬虫很可能会判定页面“内容为空”而放弃引用。',
    example: '使用 Next.js 的 SSG 静态导出，或使用 Nginx 为爬虫 UA 做预渲染缓存。',
  },
  {
    id: 'atomic-chunks',
    term: '原子知识切片 (Atomic Chunks)',
    pronounce: '无水分独立事实块',
    category: 'ai_rag',
    oneSentence: '把又长又虚的公关稿，拆解成 300~500 字、包含数字与结论的独立事实胶囊。',
    plainExplanation:
      '大模型最讨厌套话和排比句。原子切片的原则是：每一小段都包含【主体 + 核心参数/机制 + 场景 + 结论】。这样大模型在通过向量检索（RAG）寻找答案时，能精准命中并直接作为回答的一句话素材。',
    whyItMatters: '长篇累牍会让 AI 抓不到重点，原子切片能让内容被 AI 检索采纳的概率提升 3~5 倍。',
    example: '切片标题：“你们的引擎对 Next.js 14 的预渲染支持与部署耗时对比”。',
  },
  {
    id: 'citation-attribution',
    term: 'AI 引用出处归因 (Citation & UTM)',
    pronounce: 'AI 流量追踪器',
    category: 'metrics',
    oneSentence: '监控用户通过大模型回答里的右上角角标 [1] 点进官网的行为，并统计成转化订单。',
    plainExplanation:
      '当 Kimi 或 Perplexity 引用了你的官网时，会在回答末尾提供一个小链接。我们在链接上附带专属参数（如 `utm_source=chatgpt&utm_medium=geo`），就能在后台清晰看到：本月有几百个精准采购咨询来自于 AI 搜索引流。',
    whyItMatters: '用确凿的数据向管理层和老板证明：GEO 真的帮公司赚到了客户和订单。',
    example: 'https://tongzhuo.com/solutions?utm_source=perplexity&utm_medium=ai_search',
  },
  {
    id: 'eeat',
    term: 'E-E-A-T 权威模型',
    pronounce: '经验·专业·权威·可信',
    category: 'seo_geo',
    oneSentence: '搜索引擎和大模型用来判断“写这篇文章的人到底懂不懂行”的 4 大考核指标。',
    plainExplanation:
      '包括 Experience（真实一线经验）、Expertise（专业深度）、Authoritativeness（行业声誉与被同行引用）、Trustworthiness（透明公开无欺诈）。在内容中加入真实署名、技术团队资质、实操案例，就能获得更高的 E-E-A-T 分数。',
    whyItMatters: '高 E-E-A-T 的内容被视为“高可靠信源”，在医疗、金融、工业等严肃行业享有优先推荐权。',
    example: '在文章末尾展示经过验证的架构师作者卡片，并在代码里加入 Person Schema。',
  },
];

export const PlainGlossaryModal: React.FC<PlainGlossaryModalProps> = ({
  isOpen,
  onClose,
  lang,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  if (!isOpen) return null;

  const filtered = glossaryData.filter(item => {
    const matchSearch =
      item.term.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.oneSentence.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.plainExplanation.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (item.pronounce && item.pronounce.toLowerCase().includes(searchTerm.toLowerCase()));
    const matchCategory = activeCategory === 'all' || item.category === activeCategory;
    return matchSearch && matchCategory;
  });

  const handleCopyExplanation = (item: GlossaryItem) => {
    const text = `【${item.term} (${item.pronounce})】\n一句话解释：${item.oneSentence}\n通俗白话：${item.plainExplanation}\n为什么重要：${item.whyItMatters}`;
    navigator.clipboard.writeText(text);
    setCopiedId(item.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-slate-900 border border-slate-700/80 rounded-2xl w-full max-w-4xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Modal Header */}
        <div className="p-5 border-b border-slate-800 flex items-center justify-between bg-slate-900/90 sticky top-0 z-10">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
              <BookOpen className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-white">
                  {lang === 'zh' ? '小白白话词典 · 扫清专业黑话' : 'Plain Glossary for Beginners'}
                </h2>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                  {lang === 'zh' ? '用人话讲懂 GEO' : 'Zero Jargon'}
                </span>
              </div>
              <p className="text-xs text-slate-400">
                {lang === 'zh'
                  ? '告别晦涩代码与术语，3 分钟搞懂大模型推荐背后的核心机理，随时复制向上汇报'
                  : 'Clear explanations for SEO/GEO terms without confusing technical jargon.'}
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Filter & Search Bar */}
        <div className="p-4 bg-slate-950/60 border-b border-slate-800/80 flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              placeholder={lang === 'zh' ? '搜索术语，如 sameAs, robots, 切片, E-E-A-T...' : 'Search terms...'}
              className="w-full bg-slate-900 border border-slate-700/80 rounded-lg pl-9 pr-3 py-1.5 text-xs text-slate-200 placeholder-slate-400 focus:outline-none focus:border-indigo-500"
            />
          </div>

          <div className="flex items-center gap-1.5 overflow-x-auto text-xs pb-1 sm:pb-0">
            {[
              { id: 'all', label: lang === 'zh' ? '全部' : 'All' },
              { id: 'seo_geo', label: lang === 'zh' ? 'SEO与实体' : 'SEO & Entity' },
              { id: 'crawler', label: lang === 'zh' ? '爬虫与防火墙' : 'Crawlers' },
              { id: 'ai_rag', label: lang === 'zh' ? 'AI与切片' : 'RAG & Chunks' },
              { id: 'metrics', label: lang === 'zh' ? '出处与效果' : 'Metrics' },
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveCategory(tab.id)}
                className={`px-3 py-1 rounded-md transition whitespace-nowrap ${
                  activeCategory === tab.id
                    ? 'bg-indigo-600 text-white font-medium shadow-sm'
                    : 'bg-slate-800/80 hover:bg-slate-700 text-slate-300'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Glossary Cards List */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {filtered.length === 0 ? (
            <div className="text-center py-12 text-slate-400 text-sm">
              {lang === 'zh' ? '没有找到相关词条，可尝试其他关键词搜索' : 'No glossary terms match your search.'}
            </div>
          ) : (
            filtered.map(item => (
              <div
                key={item.id}
                className="bg-slate-900/90 border border-slate-800 hover:border-slate-700 rounded-xl p-4 transition space-y-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-base font-bold text-white tracking-tight">{item.term}</h3>
                      {item.pronounce && (
                        <span className="text-xs text-indigo-400 font-medium px-2 py-0.5 rounded bg-indigo-500/10 border border-indigo-500/20">
                          {item.pronounce}
                        </span>
                      )}
                    </div>
                    <p className="text-xs font-semibold text-emerald-400 mt-1 flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>{item.oneSentence}</span>
                    </p>
                  </div>

                  <button
                    onClick={() => handleCopyExplanation(item)}
                    className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition shrink-0"
                    title={lang === 'zh' ? '复制这份大白话解释，发给同事或老板' : 'Copy explanation'}
                  >
                    {copiedId === item.id ? (
                      <>
                        <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                        <span className="text-emerald-400">{lang === 'zh' ? '已复制' : 'Copied'}</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        <span>{lang === 'zh' ? '复制解释' : 'Copy'}</span>
                      </>
                    )}
                  </button>
                </div>

                <div className="text-xs text-slate-300 leading-relaxed bg-slate-950/40 p-3 rounded-lg border border-slate-800/80">
                  <span className="font-semibold text-slate-200">{lang === 'zh' ? '💡 通俗白话：' : 'In Simple Terms: '}</span>
                  {item.plainExplanation}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-[11px]">
                  <div className="p-2.5 rounded-lg bg-amber-500/5 border border-amber-500/15 text-amber-300">
                    <span className="font-bold">{lang === 'zh' ? '🎯 为什么必须做：' : 'Why it matters: '}</span>
                    {item.whyItMatters}
                  </div>
                  <div className="p-2.5 rounded-lg bg-indigo-500/5 border border-indigo-500/15 text-indigo-300 font-mono">
                    <span className="font-bold font-sans">{lang === 'zh' ? '📌 实际呈现示例：' : 'Example: '}</span>
                    {item.example}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-800 bg-slate-950/70 flex items-center justify-between text-xs text-slate-400">
          <span className="flex items-center gap-1.5">
            <Info className="w-4 h-4 text-indigo-400" />
            {lang === 'zh'
              ? '建议将这些术语的“一句话白话”直接用于向高管汇报与跨部门沟通。'
              : 'Feel free to share these plain definitions with colleagues and stakeholders.'}
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold transition"
          >
            {lang === 'zh' ? '我已了解' : 'Got it'}
          </button>
        </div>
      </div>
    </div>
  );
};
