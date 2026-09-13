import { GeoAuditReport, GeoAuditCriterion } from '../types';

const AI_FLUFF_PATTERNS = [
  /在当今数字化(?:时代|浪潮)/i,
  /随着(?:人工智能|AI|大语言模型)的(?:飞速|迅猛)发展/i,
  /众所周知/i,
  /不可否认的是/i,
  /总而言之/i,
  /综上所述/i,
  /毋庸置疑/i,
  /不言而喻/i,
  /显而易见/i,
  /在当今快节奏的/i,
  /in today's digital landscape/i,
  /it goes without saying/i,
  /delve into/i,
  /testament to/i,
  /a tapestry of/i,
  /it is important to note/i,
];

export function auditGeoReadiness(title: string, content: string, keywords: string[] = []): GeoAuditReport {
  const text = content || '';
  const lines = text.split('\n');

  // 1. Table Detection
  const hasTableDelim = lines.some((l) => /\|\s*:?-+:?\s*\|/.test(l));
  const tableRows = lines.filter((l) => l.trim().startsWith('|') && l.trim().endsWith('|'));
  const tableCount = hasTableDelim && tableRows.length >= 3 ? Math.max(1, Math.floor(tableRows.length / 4)) : 0;

  // 2. FAQ / Direct Answer Detection
  const faqRegex = /(?:###?\s*(?:FAQ|常见问题|核心答疑|问答|Q&A)|(?:\*\*Q[：:]|\*\*问[：:]))/i;
  const faqCount = (text.match(faqRegex) || []).length;

  // 3. Schema.org JSON-LD Detection
  const hasSchemaOrg = /"@context"\s*:\s*"https?:\/\/schema\.org"/i.test(text) || /application\/ld\+json/i.test(text);
  const detectedSchemas: string[] = [];
  if (/"@type"\s*:\s*"Article"/i.test(text) || /"@type"\s*:\s*"TechArticle"/i.test(text)) detectedSchemas.push('TechArticle');
  if (/"@type"\s*:\s*"FAQPage"/i.test(text)) detectedSchemas.push('FAQPage');
  if (/"@type"\s*:\s*"Organization"/i.test(text)) detectedSchemas.push('Organization');
  if (hasSchemaOrg && detectedSchemas.length === 0) detectedSchemas.push('Schema.org Microdata');

  // 4. Numbers & Quantitative Evidence (Fact density)
  const numbersAndStats = text.match(/\d+(?:\.\d+)?%?|\b(?:v\d+\.\d+|\b202[4-8]\b)/g) || [];
  const statCount = numbersAndStats.length;

  // 5. Structure & Headings
  const h2Count = lines.filter((l) => /^##\s+[^#]/.test(l.trim())).length;
  const h3Count = lines.filter((l) => /^###\s+[^#]/.test(l.trim())).length;
  const listItems = lines.filter((l) => /^[-*]\s+|\d+\.\s+/.test(l.trim())).length;

  // 6. Keywords Presence
  const matchedKeywords = keywords.filter((kw) => text.toLowerCase().includes(kw.toLowerCase()));
  const kwCoverage = keywords.length > 0 ? (matchedKeywords.length / keywords.length) * 100 : 80;

  // 7. Fluff Detection
  let fluffMatchCount = 0;
  for (const pattern of AI_FLUFF_PATTERNS) {
    if (pattern.test(text)) fluffMatchCount++;
  }
  const sentenceCount = Math.max(1, (text.match(/[。！？.!?]/g) || []).length);
  const fluffRatio = Math.min(100, Math.round((fluffMatchCount / Math.max(5, sentenceCount)) * 100));

  // Compute subscores
  // Fact Density (0-100)
  let factDensityScore = 40;
  if (tableCount > 0) factDensityScore += 25;
  if (statCount >= 10) factDensityScore += 20;
  else if (statCount >= 5) factDensityScore += 12;
  if (text.includes('```json') || text.includes('```yaml') || text.includes('```')) factDensityScore += 15;
  factDensityScore = Math.min(100, factDensityScore);

  // Extractability Score (0-100)
  let extractabilityScore = 35;
  if (h2Count >= 2) extractabilityScore += 20;
  if (h3Count >= 2) extractabilityScore += 15;
  if (listItems >= 6) extractabilityScore += 15;
  if (faqCount > 0) extractabilityScore += 15;
  extractabilityScore = Math.min(100, extractabilityScore);

  // Schema Readiness Score (0-100)
  let schemaReadinessScore = 20;
  if (hasSchemaOrg) schemaReadinessScore += 50;
  if (detectedSchemas.length >= 2) schemaReadinessScore += 30;
  else if (detectedSchemas.length === 1) schemaReadinessScore += 20;
  schemaReadinessScore = Math.min(100, schemaReadinessScore);

  // Fluff penalty
  const fluffPenalty = Math.min(25, fluffMatchCount * 6);

  // Criteria
  const criteria: GeoAuditCriterion[] = [
    {
      id: 'crit-table',
      name: '结构化对比表格 (GFM Table)',
      score: tableCount > 0 ? 100 : 20,
      weight: 20,
      passed: tableCount > 0,
      status: tableCount > 0 ? 'good' : 'warning',
      feedback: tableCount > 0 ? `检测到 ${tableCount} 个结构化表格，大模型抓取切片时具备高权重可提取性。` : '缺失结构化 Markdown 表格，大模型在横向评测时难以提取客观字段。',
      suggestion: '建议添加【多维度客观对比表】或【核心指标参数矩阵】。',
    },
    {
      id: 'crit-faq',
      name: '高频直答答疑块 (Direct FAQ Anchor)',
      score: faqCount > 0 ? 100 : 30,
      weight: 15,
      passed: faqCount > 0,
      status: faqCount > 0 ? 'good' : 'warning',
      feedback: faqCount > 0 ? `已包含核心 FAQ 模块，契合 Perplexity / SearchGPT 问答式搜索意图。` : '缺少明确的问答块（Q&A / FAQ），可能错失长尾提问的首位直出机会。',
      suggestion: '建议在文章尾部增加 2~3 个行业用户高频搜索的 FAQ 问答。',
    },
    {
      id: 'crit-schema',
      name: 'Schema.org JSON-LD 实体微标记',
      score: hasSchemaOrg ? 100 : 15,
      weight: 20,
      passed: hasSchemaOrg,
      status: hasSchemaOrg ? 'good' : 'critical',
      feedback: hasSchemaOrg ? `已嵌入 Schema.org 结构化标记 (${detectedSchemas.join(', ') || 'Article'})。` : '未检测到 Schema.org 结构化实体标记，AI 爬虫无法在 0 歧义下绑定实体知识图谱。',
      suggestion: '建议嵌入包含 Article / FAQPage 的 JSON-LD 结构化标签。',
    },
    {
      id: 'crit-entities',
      name: '事实密度与客观数据支撑 (Fact & Metric Density)',
      score: Math.min(100, statCount * 6 + 20),
      weight: 20,
      passed: statCount >= 6,
      status: statCount >= 8 ? 'good' : statCount >= 4 ? 'warning' : 'critical',
      feedback: `识别到 ${statCount} 处定量数据、参数或明确时间戳引用。`,
      suggestion: '增加客观测试数据、基准比率或行业标准引用，提升大模型信任分。',
    },
    {
      id: 'crit-fluff',
      name: '消除 AI 套话与泛化辞藻 (De-Fluffing)',
      score: Math.max(10, 100 - fluffPenalty * 4),
      weight: 15,
      passed: fluffMatchCount === 0,
      status: fluffMatchCount === 0 ? 'good' : fluffMatchCount <= 2 ? 'warning' : 'critical',
      feedback: fluffMatchCount === 0 ? '文风紧凑务实，未检测到典型 AI 模板化陈词滥调。' : `检测到 ${fluffMatchCount} 处常见 AI 套话（如“众所周知”、“在当今数字化浪潮中”等）。`,
      suggestion: '删除空泛的前言引子，第一句即直接给出核心论点与结论。',
    },
    {
      id: 'crit-keywords',
      name: '核心意图关键词覆盖 (Keyword Coverage)',
      score: Math.round(kwCoverage),
      weight: 10,
      passed: kwCoverage >= 60,
      status: kwCoverage >= 75 ? 'good' : 'warning',
      feedback: `关键词覆盖率 ${Math.round(kwCoverage)}% (${matchedKeywords.length}/${keywords.length || 1})。`,
      suggestion: '确保目标关键词自然分布于 H2 标题与段落首句。',
    },
  ];

  // Overall Score Calculation (Weighted)
  let weightedSum = 0;
  let totalWeight = 0;
  for (const c of criteria) {
    weightedSum += (c.score * c.weight);
    totalWeight += c.weight;
  }
  const overallScore = Math.max(0, Math.min(100, Math.round(weightedSum / totalWeight)));

  let grade: 'A+' | 'A' | 'B' | 'C' | 'D' = 'D';
  if (overallScore >= 92) grade = 'A+';
  else if (overallScore >= 82) grade = 'A';
  else if (overallScore >= 70) grade = 'B';
  else if (overallScore >= 55) grade = 'C';

  const optimizationsAvailable: string[] = [];
  if (tableCount === 0) optimizationsAvailable.push('自动生成横向维度评测对比表 (GFM Table)');
  if (faqCount === 0) optimizationsAvailable.push('提炼并补齐 3 道高频行业 FAQ 问答块');
  if (!hasSchemaOrg) optimizationsAvailable.push('注入标准 Schema.org JSON-LD 结构化数据');
  if (fluffMatchCount > 0) optimizationsAvailable.push('剔除空洞 AI 套话，重构首段为事实型即时结论');

  return {
    overallScore,
    grade,
    factDensityScore,
    extractabilityScore,
    schemaReadinessScore,
    fluffRatio,
    tableCount,
    faqCount,
    schemaTypesDetected: detectedSchemas,
    criteria,
    optimizationsAvailable,
  };
}
