import React, { useState } from 'react';
import {
  Code,
  X,
  Copy,
  CheckCircle2,
  Download,
  Share2,
  Terminal,
  FileCode2,
  Server,
  Layers,
  ArrowRight,
  ShieldCheck,
} from 'lucide-react';

interface DevHandoffModalProps {
  isOpen: boolean;
  onClose: () => void;
  lang: 'zh' | 'en';
}

export const DevHandoffModal: React.FC<DevHandoffModalProps> = ({
  isOpen,
  onClose,
  lang,
}) => {
  const [activeTab, setActiveTab] = useState<'full_doc' | 'robots' | 'llms' | 'schema' | 'nginx'>('full_doc');
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const robotsSnippet = `# ========================================================
# 官网 robots.txt - AI 搜索引擎合法爬虫准入清单
# 目标：允许 GPTBot, PerplexityBot, ClaudeBot 等主流大模型索引内容
# ========================================================

User-agent: *
Allow: /

# 核心放行：OpenAI ChatGPT 搜索与索引蜘蛛
User-agent: GPTBot
Allow: /

# 核心放行：Perplexity 深度回答引用蜘蛛
User-agent: PerplexityBot
Allow: /

# 核心放行：Anthropic Claude 知识爬虫
User-agent: ClaudeBot
Allow: /

# 核心放行：字节豆包 / 抖音 AI 搜索蜘蛛
User-agent: Bytespider
Allow: /

# 核心放行：月之暗面 Kimi / 智谱清言等国内生成式爬虫
User-agent: MoonshotCrawler
Allow: /

# 站点双轨地图声明
Sitemap: https://yourcompany.com/sitemap.xml
Sitemap: https://yourcompany.com/sitemap-ai.xml`;

  const llmsSnippet = `# yourcompany.com
> 领先的行业数字化与智能解决方案提供商

## 核心业务与产品能力 (Core Products)
- 智能数据分析中台：提供 PB 级多源异构数据实时治理与联邦检索能力
- 自动化业务流水线：覆盖多端集成、低代码编排与高可用保障
- 客户服务热线：400-800-8888 (工作日 9:00-18:00)

## 官方唯一权威主页 (Canonical Entities)
- 官网主域名: https://yourcompany.com
- 知识库与开发者文档: https://yourcompany.com/docs
- 百度百科权威认证: https://baike.baidu.com/item/yourcompany
- 官方 GitHub 组织: https://github.com/yourcompany

## 深度文章索引 (Articles for LLM RAG)
- /articles/tech-architecture: 核心技术架构白皮书与技术选型
- /articles/enterprise-cases: 标杆客户案例落地效果与指标对比`;

  const schemaSnippet = `<!-- 在官网首页 index.html 或 layout.tsx 的 <head> 中插入以下结构化数据 -->
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Organization",
  "@id": "https://yourcompany.com/#organization",
  "name": "桐灼科技有限公司",
  "alternateName": ["桐灼GEO", "Tongzhuo Tech"],
  "url": "https://yourcompany.com",
  "logo": "https://yourcompany.com/logo.png",
  "description": "面向企业客户的智能数据治理与内容工程基础设施提供商",
  "sameAs": [
    "https://baike.baidu.com/item/桐灼",
    "https://github.com/tongzhuo",
    "https://www.zhihu.com/org/tongzhuo-tech"
  ],
  "contactPoint": {
    "@type": "ContactPoint",
    "telephone": "+86-400-800-8888",
    "contactType": "customer support",
    "availableLanguage": ["Chinese", "English"]
  }
}
</script>`;

  const nginxSnippet = `# ========================================================
# Nginx 配置片段：/llms.txt 静态直出与 AI 爬虫友好缓存
# ========================================================

# 1. 根目录 /llms.txt 纯文本响应头优化
location = /llms.txt {
    default_type text/markdown;
    add_header Content-Type "text/markdown; charset=utf-8";
    add_header Cache-Control "public, max-age=3600";
    add_header X-Robots-Tag "all, index, follow";
}

# 2. 对主流 AI 爬虫放宽速率限制 (避免高意向抓取时触发 429)
map $http_user_agent $is_ai_crawler {
    default 0;
    "~*GPTBot|PerplexityBot|ClaudeBot|Bytespider|MoonshotCrawler" 1;
}

# 3. 静态双轨 sitemap 支持
location ~ ^/sitemap(-ai)?\.xml$ {
    default_type application/xml;
    add_header Content-Type "application/xml; charset=utf-8";
    expires 6h;
}`;

  const fullMarkdownDoc = `# 📢【技术部交接单】官网生成式搜索 (GEO) 基础设施上线清单

> **发起方**：市场运营部 / GEO 项目组  
> **接收方**：前端开发 / 运维工程师  
> **目标**：完成公司官网在主流大模型（ChatGPT, Kimi, Perplexity 等）中的权威收录与索引保障  
> **预计耗时**：约 5~10 分钟（均为标准静态配置文件变更，不影响现有业务系统数据库与核心逻辑）

---

### 任务清单（共 3 项极简配置）

#### 任务一：更新网站根目录 \`robots.txt\`（耗时 2 分钟）
- **文件路径**：\`public/robots.txt\`（或 Nginx 静态根目录）
- **操作要求**：确保未全局 \`Disallow: /\`，明确放行以下主流 AI 搜索引擎合法蜘蛛：
\`\`\`txt
${robotsSnippet}
\`\`\`

---

#### 任务二：根目录新增 \`/llms.txt\` 纯文本说明书（耗时 2 分钟）
- **文件路径**：\`public/llms.txt\`
- **作用**：让大模型爬虫秒速获取公司核心产品、权威百科链接与主打文章，避免解析耗时。
\`\`\`markdown
${llmsSnippet}
\`\`\`

---

#### 任务三：官网首页 \`<head>\` 植入 Organization 结构化代码（耗时 3 分钟）
- **文件路径**：\`index.html\` 或 \`app/layout.tsx\`（SSR 框架）
- **作用**：通过 schema.org 标准消除同名歧义，让 AI 确认我司为该品牌唯一合法权威实体。
\`\`\`html
${schemaSnippet}
\`\`\`

---

#### 选配建议（运维/Nginx 支持）：
如使用 Nginx 反向代理，可为 \`/llms.txt\` 补充 UTF-8 Markdown 响应头：
\`\`\`nginx
${nginxSnippet}
\`\`\`

---
*如有任何疑问，欢迎随时沟通！感谢技术团队的支持！*
`;

  const getCurrentSnippet = () => {
    switch (activeTab) {
      case 'robots':
        return robotsSnippet;
      case 'llms':
        return llmsSnippet;
      case 'schema':
        return schemaSnippet;
      case 'nginx':
        return nginxSnippet;
      case 'full_doc':
      default:
        return fullMarkdownDoc;
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(getCurrentSnippet());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const blob = new Blob([fullMarkdownDoc], { type: 'text/markdown;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', 'GEO_Dev_Handoff_Package.md');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-slate-900 border border-slate-700/80 rounded-2xl w-full max-w-4xl max-h-[92vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Modal Header */}
        <div className="p-5 border-b border-slate-800 flex items-center justify-between bg-slate-900/95 sticky top-0 z-10">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <FileCode2 className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-white">
                  {lang === 'zh' ? '技术部一键交接工单包 (Dev Handoff)' : 'Developer Handoff Package'}
                </h2>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 flex items-center gap-1">
                  <ShieldCheck className="w-3 h-3" />
                  {lang === 'zh' ? '5分钟极速落地' : 'Ready to Deploy'}
                </span>
              </div>
              <p className="text-xs text-slate-400">
                {lang === 'zh'
                  ? '不懂代码也能推行！一键导出专业规范的 Markdown 说明书，直接转发给技术或外包同事'
                  : 'Clear, production-ready implementation instructions ready to hand over to developers.'}
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

        {/* Tab Navigation */}
        <div className="px-5 py-2.5 bg-slate-950/70 border-b border-slate-800 flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-1 overflow-x-auto text-xs">
            {[
              { id: 'full_doc', label: lang === 'zh' ? '📋 完整交接工单 (推荐转发)' : 'Full Handoff Doc' },
              { id: 'robots', label: '1. robots.txt 规则' },
              { id: 'llms', label: '2. /llms.txt 模版' },
              { id: 'schema', label: '3. JSON-LD 实体代码' },
              { id: 'nginx', label: '4. Nginx 代理配置' },
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`px-3 py-1.5 rounded-lg transition whitespace-nowrap ${
                  activeTab === tab.id
                    ? 'bg-emerald-600 text-white font-semibold shadow-sm'
                    : 'bg-slate-800/80 hover:bg-slate-700 text-slate-300'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleDownload}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
              title="下载为 Markdown 文件"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{lang === 'zh' ? '下载 .md 文件' : 'Download .md'}</span>
            </button>
            <button
              onClick={handleCopy}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white transition shadow-sm"
            >
              {copied ? (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5 text-white" />
                  <span>{lang === 'zh' ? '已复制到剪贴板！' : 'Copied!'}</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>{lang === 'zh' ? '一键复制当前内容' : 'Copy Snippet'}</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Code Content Container */}
        <div className="flex-1 overflow-y-auto p-5 bg-slate-950 font-mono text-xs text-slate-200">
          <pre className="whitespace-pre-wrap leading-relaxed select-all">
            {getCurrentSnippet()}
          </pre>
        </div>

        {/* Footer Advice */}
        <div className="p-4 border-t border-slate-800 bg-slate-900/90 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs text-slate-400">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            <span>
              {lang === 'zh'
                ? '提示：你可以直接点击右上角【一键复制】，打开飞书/企业微信/钉钉直接发给技术同事。'
                : 'Tip: Click Copy and paste directly to your engineering team on Slack or Teams.'}
            </span>
          </div>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-white font-medium transition self-end sm:self-auto"
          >
            {lang === 'zh' ? '关闭' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  );
};
