@extends('theme.tongzhuo-brand-2026.layout')

@php
    /*
     * 首页结构。
     *
     * 这一版的文案全部来自哥哥 2026-09-18 提供的公司资料；
     * **不写资料里没有的数字、案例和参数**——具体删掉了参考稿里的：
     *   · 「占比 60%+」（资料无此数据）
     *   · 三个虚构客户（鲁中精工环保 / 齐鲁精工装备 / 鲁泰新材基地）及其全部参数
     *   · 诊断计算器的假分数（「32/100 分」之类）
     * 「5 年+」保留但**写明是核心团队**的年限——公司 2025-09 注册，不写清楚会被读成公司年龄。
     *
     * 「两类企业对照」是**原理示意**，不是实测结果，页脚已明确标注。
     */
    $tzCompany = $companyProfile ?? null;
    $tzCompanyName = trim((string) ($tzCompany?->legalName ?? '')) ?: ($siteTitle ?? '桐灼（淄博）网络科技有限公司');

    // 转化入口：取 id 最小的那个 active 表单（与 SiteLayoutComposer 同一口径）
    $tzLeadForm = collect($leadForms ?? [])->first();
    $tzFormUrl = $tzLeadForm
        ? route('site.lead-forms.show', $tzLeadForm->slug)
        : route('site.about');
@endphp

@push('head')
    {{--
        进场 / 滚动揭示的引导片段（2026-09-19）。

        为什么隐藏态要在这里**同步**挂到 <html> 上，而不是等 theme.js 起来再加：
        等到那时首屏已经画过一帧，元素会「先露一下、再隐藏、再淡入」——看得见的闪烁。
        这一段在 <head> 里同步执行，body 还没开始解析，所以不存在那一帧。

        ⚠️ 同时挂一个**保险定时器**：theme.js（defer）没接管就把类撤掉。
        脚本被拦、404、或抛异常时，页面退回普通静态态，内容不会被扣成空白。
        保险时长要短——宁可没有动画，也不能让人对着空白页干等。
    --}}
    <script>
        (function () {
            var d = document.documentElement;
            if (!window.matchMedia || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
                return;                     // 用户要求减少动效：连类都不加，页面就是静态的
            }
            d.classList.add('tz-anim');
            window.__tzAnimFailsafe = setTimeout(function () {
                d.classList.remove('tz-anim');
            }, 2000);
        })();
    </script>
    <script defer src="{{ asset('themes/tongzhuo-brand-2026/theme.js') }}"></script>

    @php
        $schemaAtContext = chr(64).'context';
        $schemaAtType = chr(64).'type';
        $homeSchema = [
            $schemaAtContext => 'https://schema.org',
            $schemaAtType => 'FAQPage',
            'mainEntity' => [
                [
                    $schemaAtType => 'Question',
                    'name' => 'GEO 和传统 SEO 有什么区别？',
                    'acceptedAnswer' => [
                        $schemaAtType => 'Answer',
                        'text' => 'SEO 侧重传统搜索引擎的排名优化；GEO 聚焦企业信息能否被生成式 AI、问答系统和 AI 搜索结果准确理解、引用与推荐。',
                    ],
                ],
                [
                    $schemaAtType => 'Question',
                    'name' => 'GEO 的效果怎么衡量？',
                    'acceptedAnswer' => [
                        $schemaAtType => 'Answer',
                        'text' => '以品牌词在 DeepSeek、豆包、腾讯元宝等平台的「提及率」与「推荐信息准确率」作为核心考核指标，确保投入可追踪。',
                    ],
                ],
                [
                    $schemaAtType => 'Question',
                    'name' => '哪些企业适合做 GEO？',
                    'acceptedAnswer' => [
                        $schemaAtType => 'Answer',
                        'text' => '采购决策前习惯使用 AI 问答做调研、选型和供应商对比的企业，覆盖 B2B 工贸制造、本地同城实体服务商、细分赛道成长品牌与强监管专业服务市场。',
                    ],
                ],
            ],
        ];
    @endphp
    <x-json-ld :data="$homeSchema" />
@endpush

@section('content')
    {{-- ══ 首屏 ══════════════════════════════════════════════════════════ --}}
    <section class="tz-container tz-hero">
        <div class="tz-pill">
            <span class="tz-pill-dot" aria-hidden="true"></span>
            <span>公司使命：让好企业，被客户与 AI 看见</span>
        </div>

        <h1 class="tz-display">
            打通短视频获客与全域 GEO，<br class="tz-br">让工业品企业在 AI 问答里被准确引荐。
        </h1>

        <p class="tz-hero-lede">
            桐灼科技面向工业品与 B2B 制造企业，把企业的产品、车间与工程案例转化为可传播的内容，
            并建设成 AI 能读懂、能引用、可追溯的信源。拒绝空泛的流量承诺，
            坚持真实知识支撑与人工审核兜底。
        </p>

        <div class="tz-hero-actions">
            <a class="tz-btn" href="{{ $tzFormUrl }}">免费获取企业 AI 可见性诊断</a>
            <a class="tz-btn-ghost" href="#services">查看三大核心服务</a>
        </div>

        <div class="tz-stats">
            <div>
                <div class="tz-stat-num">5<span class="tz-stat-unit">年+</span></div>
                <div class="tz-stat-label">核心团队深耕</div>
                <div class="tz-stat-note">工业品营销与 B2B 数字化服务</div>
            </div>
            <div>
                <div class="tz-stat-num">100<span class="tz-stat-unit">家+</span></div>
                <div class="tz-stat-label">累计服务企业</div>
                <div class="tz-stat-note">机械设备、环保设备及 B2B 制造</div>
            </div>
            <div>
                <div class="tz-stat-num">8<span class="tz-stat-unit">大入口</span></div>
                <div class="tz-stat-label">全域 GEO 覆盖</div>
                <div class="tz-stat-note">DeepSeek / 豆包 / 元宝 / 文心 / 通义等</div>
            </div>
            <div>
                <div class="tz-stat-num">双<span class="tz-stat-unit">量化</span></div>
                <div class="tz-stat-label">提及率 + 准确率</div>
                <div class="tz-stat-note">投入可追踪、效果可量化</div>
            </div>
        </div>
    </section>

    {{-- ══ 两类企业对照（原理示意） ══════════════════════════════════════ --}}
    <section class="tz-block" id="compare">
        <div class="tz-container">
            <div class="tz-block-head">
                <p class="tz-eyebrow">Principle Illustration · 原理示意</p>
                <h2 class="tz-h2">采购负责人在 AI 里问选型时，<br>什么样的企业会被提到？</h2>
                <p class="tz-block-lede">
                    AI 回答选型类问题时，依赖的是结构清晰、可交叉验证的事实。
                    下面用同一个问题，说明「只有产品页的企业」与「三类信号齐全的企业」会得到什么不同的结果。
                </p>
            </div>

            <div class="tz-compare">
                <div class="tz-compare-query">
                    <span class="tz-mono">QUERY</span>
                    <span>「请推荐几家能做高温布袋除尘设备的源头厂家，要有真实工程案例和排放参数。」</span>
                </div>

                <div class="tz-compare-grid">
                    <div class="tz-compare-col">
                        <div class="tz-compare-head">
                            <span class="tz-compare-title">
                                <span class="tz-compare-mark tz-compare-mark-bad" aria-hidden="true"></span>
                                只有产品页的企业
                            </span>
                            <span class="tz-tag tz-tag-bad">AI 检索时容易被略过</span>
                        </div>
                        <ul class="tz-compare-list">
                            <li>官网只有产品介绍和一句公司简介，机器读不出你们是谁、做哪一类工况</li>
                            <li>技术参数、排放数据、工程案例放在图片或 PDF 里，AI 取不到里面的内容</li>
                            <li>全网找不到可交叉印证的信息，只有自家官网在自说自话</li>
                        </ul>
                        <div class="tz-compare-note">
                            <strong>结果</strong>
                            回答会停在「建议去产业带实地考察」「可在 B2B 平台筛选供应商」这类泛化建议上——你们不在其中。
                        </div>
                    </div>

                    <div class="tz-compare-col">
                        <div class="tz-compare-head">
                            <span class="tz-compare-title">
                                <span class="tz-compare-mark tz-compare-mark-good" aria-hidden="true"></span>
                                三类信号齐全的企业
                            </span>
                            <span class="tz-tag tz-tag-good">有机会被准确引用</span>
                        </div>
                        <ul class="tz-compare-list">
                            <li><strong>企业是谁</strong>：公司实体、服务范围、所在地与联系方式在各页面保持一致</li>
                            <li><strong>能解决什么</strong>：技术参数、适用工况、交付周期写成能直接读到的结构化内容</li>
                            <li><strong>为什么可信</strong>：案例、署名观点与第三方信息可以互相印证</li>
                        </ul>
                        <div class="tz-compare-note">
                            <strong>关键差别</strong>
                            不是「内容更多」，而是「事实更清楚」——AI 引用的是能核对的说法。
                        </div>
                    </div>
                </div>

                <div class="tz-compare-foot">
                    <span>* 本节为原理解释，非实测结果，不含客户数据</span>
                    <span>核心考核指标：品牌提及率 + 推荐信息准确率</span>
                </div>
            </div>
        </div>
    </section>

    {{-- ══ 三大核心服务 ══════════════════════════════════════════════════ --}}
    <section class="tz-block" id="services">
        <div class="tz-container">
            <div class="tz-block-head">
                <p class="tz-eyebrow">Our Services</p>
                <h2 class="tz-h2">三大核心服务与产品闭环</h2>
                <p class="tz-block-lede">
                    三项服务共享企业真实的产品、客户问题、案例和销售知识。可以单项独立启动，
                    也可以三位一体协同，形成从内容生产、全域分发到线索承接的完整闭环。
                </p>
            </div>

            <div class="tz-grid">
                <div class="tz-card">
                    <div>
                        <div class="tz-card-top">
                            <span class="tz-card-index">01 / GEO OPTIMIZATION</span>
                            <span class="tz-card-badge">核心服务</span>
                        </div>
                        <h3 class="tz-card-title">全域 AI 搜索 GEO 优化</h3>
                        <p class="tz-card-desc">
                            面向生成式 AI 搜索引擎，让企业品牌在选型对比类问答中被准确理解、引用与推荐。
                        </p>
                        <ul class="tz-checklist">
                            <li><span><strong>AI 可见性诊断：</strong>测试品牌词、产品词、行业推荐词与城市服务词，记录提及率、描述准确性与同行出现情况。</span></li>
                            <li><span><strong>企业知识库与关键词体系：</strong>统一公司信息、产品服务、案例、FAQ 与行业知识。</span></li>
                            <li><span><strong>官网与 AI 可读基础建设：</strong>服务页、资讯、FAQ、结构化数据、站点地图、RSS 与 llms.txt。</span></li>
                            <li><span><strong>全域内容与信源分发：</strong>官网、新闻媒体、自媒体、B2B 商贸平台与行业垂直站交叉验证。</span></li>
                            <li><span><strong>AI 搜索监测与月度复盘：</strong>持续观察品牌提及、推荐位置、引用来源与信息准确性。</span></li>
                        </ul>
                    </div>
                    <div class="tz-card-foot">
                        <a class="tz-btn tz-btn-block" href="{{ $tzFormUrl }}">咨询 GEO 专项方案</a>
                    </div>
                </div>

                <div class="tz-card">
                    <div>
                        <div class="tz-card-top">
                            <span class="tz-card-index">02 / B2B VIDEO</span>
                            <span class="tz-card-badge">内容信源</span>
                        </div>
                        <h3 class="tz-card-title">工业品短视频获客运营</h3>
                        <p class="tz-card-desc">
                            围绕产品演示、工厂实力、案例复盘与老板观点策划内容，
                            把生硬的技术参数与工艺转成客户听得懂的选型逻辑。
                        </p>
                        <ul class="tz-checklist">
                            <li><span><strong>账号定位与客户问题梳理：</strong>先明确要触达谁、回答他们关心的哪些问题。</span></li>
                            <li><span><strong>工业品内容矩阵：</strong>产品演示、工厂实力、案例复盘、老板观点、客户痛点、方案对比。</span></li>
                            <li><span><strong>脚本、拍摄与剪辑：</strong>把参数、工艺和应用场景转成客户易懂的表达。</span></li>
                            <li><span><strong>发布运营与线索提醒：</strong>抖音、视频号、小红书、公众号、知乎、头条号、百家号。</span></li>
                            <li><span><strong>数据复盘与内容复用：</strong>优质素材转为图文与 GEO 信源，让短期曝光沉淀为长期资产。</span></li>
                        </ul>
                    </div>
                    <div class="tz-card-foot">
                        <a class="tz-btn tz-btn-block" href="{{ $tzFormUrl }}">获取短视频获客方案</a>
                    </div>
                </div>

                <div class="tz-card">
                    <div>
                        <div class="tz-card-top">
                            <span class="tz-card-index">03 / AI AGENT</span>
                            <span class="tz-card-badge">组织提效</span>
                        </div>
                        <h3 class="tz-card-title">企业 AI 落地与 Agent 定制</h3>
                        <p class="tz-card-desc">
                            从梳理企业知识、销售话术与重复流程开始，
                            落地知识库、工作流与业务助手。
                        </p>
                        <ul class="tz-checklist">
                            <li><span><strong>企业知识库：</strong>整理公司、产品、案例、FAQ、销售材料与内部 SOP。</span></li>
                            <li><span><strong>销售话术库与业务助手：</strong>围绕客户问题、需求诊断、方案说明、异议处理与跟进节奏。</span></li>
                            <li><span><strong>内容生产工作流：</strong>把企业知识转化为官网文章、短视频脚本与客户沟通初稿。</span></li>
                            <li><span><strong>工作流与 Agent：</strong>资料整理、会议纪要、SOP 查询、报表初稿等稳定任务配置成可重复流程。</span></li>
                            <li><span><strong>团队培训与陪跑：</strong>建立使用边界、责任归属与操作方法。</span></li>
                        </ul>
                    </div>
                    <div class="tz-card-foot">
                        <a class="tz-btn tz-btn-block" href="{{ $tzFormUrl }}">定制企业专属 Agent</a>
                    </div>
                </div>
            </div>
        </div>
    </section>

    {{-- ══ 获客飞轮 + 三类信号 ═══════════════════════════════════════════ --}}
    <section class="tz-block" id="flywheel">
        <div class="tz-container">
            <div class="tz-split">
                <div>
                    <p class="tz-eyebrow">Methodology</p>
                    <h2 class="tz-h2">获客飞轮：<br>让每一次交付都沉淀为资产</h2>
                    <p class="tz-block-lede">
                        传统工业品营销往往是「发完即忘，停更即停」。桐灼推行的闭环是：
                        每一次内容生产与客户解题，都同时沉淀为品牌内容、搜索信源、销售素材、
                        案例证据与企业知识，形成长期复利。
                    </p>
                    <div class="tz-callout">
                        <p class="tz-callout-title">实施三原则</p>
                        <p>
                            <strong>业务价值优先</strong>——从一个可验证的小切口开始；
                            <strong>真实知识支撑</strong>——所有信源来自企业真实资料；
                            <strong>保留人工审核</strong>——分发前经事实与合规复核。
                        </p>
                    </div>
                </div>

                <div class="tz-step-grid">
                    <div class="tz-step">
                        <div class="tz-step-num">01</div>
                        <h3 class="tz-step-title">业务诊断</h3>
                        <p class="tz-step-desc">梳理产品线、客户问题、销售过程与现有内容，明确增长阻点。</p>
                    </div>
                    <div class="tz-step">
                        <div class="tz-step-num">02</div>
                        <h3 class="tz-step-title">信源建设</h3>
                        <p class="tz-step-desc">统一公司与服务表达，搭建官网、问答与内容结构，让机器读得懂。</p>
                    </div>
                    <div class="tz-step">
                        <div class="tz-step-num">03</div>
                        <h3 class="tz-step-title">渠道运营</h3>
                        <p class="tz-step-desc">通过短视频与行业内容持续触达目标客户，并把素材回流成信源。</p>
                    </div>
                    <div class="tz-step">
                        <div class="tz-step-num">04</div>
                        <h3 class="tz-step-title">AI 提效</h3>
                        <p class="tz-step-desc">把知识沉淀进工具与流程，提升团队执行效率，减少重复劳动。</p>
                    </div>
                </div>
            </div>

            <div style="margin-top:var(--tz-block)">
                <div class="tz-block-head" style="margin-bottom:0">
                    <p class="tz-eyebrow">Semantic Signals</p>
                    <h2 class="tz-h2">大模型识别与推荐企业的三类信号</h2>
                    <p class="tz-block-lede">
                        GEO 不是关键词堆砌，而是构建机器能核对的事实逻辑链。
                    </p>
                </div>

                <div class="tz-signal-grid">
                    <div class="tz-signal">
                        <h3 class="tz-signal-title">
                            <span class="tz-signal-mark" aria-hidden="true"></span>
                            企业是谁
                        </h3>
                        <p>公司名称、所在地、团队、服务范围与品牌描述，在不同页面和渠道保持全局一致，让大模型建立唯一的企业实体关联。</p>
                    </div>
                    <div class="tz-signal">
                        <h3 class="tz-signal-title">
                            <span class="tz-signal-mark" aria-hidden="true"></span>
                            能解决什么
                        </h3>
                        <p>用完整、直接的内容回答：适合哪种工况、交付什么、周期多长、如何判断价值。杜绝模糊套话。</p>
                    </div>
                    <div class="tz-signal">
                        <h3 class="tz-signal-title">
                            <span class="tz-signal-mark" aria-hidden="true"></span>
                            为什么可信
                        </h3>
                        <p>通过真实案例、署名观点、更新时间与外部信息，建立可以被第三方核验的专业信号。</p>
                    </div>
                </div>
            </div>
        </div>
    </section>

    {{-- ══ 四大适用市场 ══════════════════════════════════════════════════ --}}
    <section class="tz-block" id="markets">
        <div class="tz-container">
            <div class="tz-block-head">
                <p class="tz-eyebrow">Target Verticals</p>
                <h2 class="tz-h2">四大核心适用市场</h2>
                <p class="tz-block-lede">
                    面向「采购决策周期长、多方比价、成交依赖专业信任」的 B2B 工贸制造与企业服务。
                </p>
            </div>

            <div class="tz-grid tz-grid-2">
                <div class="tz-card">
                    <div>
                        <div class="tz-card-top">
                            <span class="tz-card-index">主力市场</span>
                            <span class="tz-card-badge">B2B 工贸制造</span>
                        </div>
                        <h3 class="tz-card-title">建材供应链 / 机械设备 / 环保设备 / 新材料 / 非标加工</h3>
                        <p class="tz-market-scope">采购周期长、多方比价，采购负责人会用 AI 查厂家实力与方案对比</p>
                        <div class="tz-market-rows">
                            <div class="tz-market-row">
                                <span class="tz-market-label tz-market-label-bad">痛点</span>
                                <span class="tz-market-value">竞价获客成本持续走高，官网 SEO 流量衰减，客户在 AI 问答里看不到自身品牌。</span>
                            </div>
                            <div class="tz-market-row">
                                <span class="tz-market-label tz-market-label-good">GEO 价值</span>
                                <span class="tz-market-value">在 AI 选型问答中占住推荐位置，承接精准工程询盘，沉淀权威信源资产。</span>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="tz-card">
                    <div>
                        <div class="tz-card-top">
                            <span class="tz-card-index">区域流量</span>
                            <span class="tz-card-badge">本地同城实体</span>
                        </div>
                        <h3 class="tz-card-title">家装全屋定制 / 装修工程 / 厂房商铺租赁 / 口腔 / 家政</h3>
                        <p class="tz-market-scope">有明确服务半径，用户习惯问「XX 城市哪家靠谱」</p>
                        <div class="tz-market-rows">
                            <div class="tz-market-row">
                                <span class="tz-market-label tz-market-label-bad">痛点</span>
                                <span class="tz-market-value">同城竞争内卷，投放成本高，客户在 AI 本地推荐环节被竞品截流。</span>
                            </div>
                            <div class="tz-market-row">
                                <span class="tz-market-label tz-market-label-good">GEO 价值</span>
                                <span class="tz-market-value">锁定地域词，把品牌嵌入本地 AI 推荐，获取同城高意向客户。</span>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="tz-card">
                    <div>
                        <div class="tz-card-top">
                            <span class="tz-card-index">差异化话语权</span>
                            <span class="tz-card-badge">细分成长品牌</span>
                        </div>
                        <h3 class="tz-card-title">智能家居 / 细分建材 / 特色工业品 / 智能装备配件</h3>
                        <p class="tz-market-scope">产品有差异化卖点，但全网权威信息少，品牌认知弱</p>
                        <div class="tz-market-rows">
                            <div class="tz-market-row">
                                <span class="tz-market-label tz-market-label-bad">痛点</span>
                                <span class="tz-market-value">传统推广很难建立专业信任，客户做产品对比时 AI 不提及品牌。</span>
                            </div>
                            <div class="tz-market-row">
                                <span class="tz-market-label tz-market-label-good">GEO 价值</span>
                                <span class="tz-market-value">搭建品牌知识体系，在产品对比类 AI 回答中建立话语权。</span>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="tz-card">
                    <div>
                        <div class="tz-card-top">
                            <span class="tz-card-index">强监管合规</span>
                            <span class="tz-card-badge">专业服务</span>
                        </div>
                        <h3 class="tz-card-title">工程咨询 / 检测 / 财税 / 法律咨询 / 知识产权</h3>
                        <p class="tz-market-scope">硬广告受限，成交高度依赖信任背书</p>
                        <div class="tz-market-rows">
                            <div class="tz-market-row">
                                <span class="tz-market-label tz-market-label-bad">痛点</span>
                                <span class="tz-market-value">不能大规模投放广告，客户决策依赖专业资料、资质与案例。</span>
                            </div>
                            <div class="tz-market-row">
                                <span class="tz-market-label tz-market-label-good">GEO 价值</span>
                                <span class="tz-market-value">合规搭建权威信源，通过 AI 问答建立专业信任，获取咨询线索。</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </section>

    {{-- ══ 自测清单（原「诊断计算器」位置） ══════════════════════════════ --}}
    <section class="tz-block" id="selfcheck">
        <div class="tz-container">
            <div class="tz-block-head" style="max-width:none;text-align:center">
                <p class="tz-eyebrow" style="text-align:center">Self Check · 自助排查</p>
                <h2 class="tz-h2">先自己看一眼：这五条你答得上来吗？</h2>
                <p class="tz-block-lede" style="margin-inline:auto">
                    不用填表，也不用留电话。就着下面五条自己过一遍，
                    答不上来的越多，说明 AI 那边越看不见你。
                </p>
            </div>

            <div class="tz-selfcheck">
                <ul class="tz-selfcheck-list">
                    <li class="tz-selfcheck-item">
                        在 DeepSeek 或豆包里问你们行业选型的问题，回答里提到过你们公司吗？
                    </li>
                    <li class="tz-selfcheck-item">
                        官网上的技术参数和适用工况，是能直接读到的文字，还是只在图片、PDF、宣传册里？
                    </li>
                    <li class="tz-selfcheck-item">
                        除了自家官网，全网还有别的地方能查到你们吗？
                    </li>
                    <li class="tz-selfcheck-item">
                        客户最常问的那几个问题，官网上有没有直接、完整的答案？
                    </li>
                    <li class="tz-selfcheck-item">
                        官网有没有结构化数据、llms.txt 和完整的站点地图？
                    </li>
                </ul>

                <div class="tz-selfcheck-cta">
                    <p>
                        五条里有三条以上答「没有」或「不知道」，可以先做一次可见性诊断，
                        看看 AI 现在到底怎么描述你们。
                    </p>
                    <a class="tz-btn" href="{{ $tzFormUrl }}">免费获取 AI 可见性诊断</a>
                </div>
            </div>
        </div>
    </section>

    {{-- ══ 关于桐灼 ══════════════════════════════════════════════════════ --}}
    <section class="tz-block" id="about">
        <div class="tz-container">
            <div class="tz-split">
                <div>
                    <p class="tz-eyebrow">About TongZhuo</p>
                    <h2 class="tz-h2">定位精准，打法务实。<br>以自身为样本的 GEO 践行者。</h2>
                    <p class="tz-block-lede">
                        {{ $tzCompanyName }}座落于山东省淄博市。核心团队深耕工业品营销与 B2B 数字化服务超过 5 年。
                    </p>
                    <p class="tz-block-lede">
                        我们不追求全行业大包大揽，而是专注把短视频内容获客与 GEO 生成式引擎优化打通。
                        桐灼自己的官网就是一套 GEO 实践样本——清晰的公司实体、独立的服务页面、
                        可引用的观点文章和机器可读的数据，共同构成对外的专业知识层。
                    </p>
                    <p style="margin-top:1.5rem">
                        <a class="tz-btn-ghost" href="{{ route('site.about') }}">了解桐灼</a>
                    </p>
                </div>

                <div class="tz-callout" style="margin-top:0">
                    <p class="tz-callout-title">服务实施三原则</p>
                    <ul class="tz-checklist" style="border-top:0;padding-top:0">
                        <li><span><strong>业务价值优先</strong>——从一个可量化验证的小切口开始，见效后再逐步外延。</span></li>
                        <li><span><strong>真实知识支撑</strong>——所有信源均来自企业真实资料、技术方案书与交付实绩，不编造数据。</span></li>
                        <li><span><strong>保留人工审核</strong>——所有分发内容均经事实与合规复核后才发出。</span></li>
                    </ul>
                </div>
            </div>
        </div>
    </section>

    {{-- ══ 最新观点（文章在首页只承担「还在持续输出」的证明作用） ═══════ --}}
    @if(!empty($articles) && $articles->isNotEmpty())
        <section class="tz-block" id="insights">
            <div class="tz-container">
                <div class="tz-block-head" style="display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:1rem;max-width:none">
                    <div>
                        <p class="tz-eyebrow">Insights</p>
                        <h2 class="tz-h2">{{ __('site.home_insights') }}</h2>
                    </div>
                    <a class="tz-mono" href="{{ route('site.archive') }}" style="color:var(--tz-ink-700);text-decoration:underline;text-underline-offset:3px">
                        {{ __('site.home_view_all') }}
                    </a>
                </div>

                <div class="tz-list">
                    @foreach($articles->take(3) as $article)
                        @include('theme.tongzhuo-brand-2026.partials.article-card', ['article' => $article])
                    @endforeach
                </div>
            </div>
        </section>
    @endif

    {{-- ══ GEO 语义资产（关键词来自公司资料，不是堆砌） ══════════════════ --}}
    <section class="tz-block" id="keywords">
        <div class="tz-container">
            <p class="tz-eyebrow">Semantic Assets Index</p>
            <ul class="tz-keywords">
                @foreach([
                    '生成式引擎优化', 'GEO 优化', '全域 AI 搜索 GEO 优化', 'GEO 信源建设',
                    '全域信源搭建', 'AI 可见性优化', 'AI 搜索诊断', '信源监测复盘',
                    '工业品短视频运营', 'B2B 短视频获客', '企业 AI 落地', '企业知识库搭建',
                    'AI 工作流', 'Agent 定制', '企业 AI 助手', '工业品 AI 营销',
                    '中小企业 AI 营销', 'B2B AI 获客', '企业增长诊断', '数字资产沉淀',
                    'AI 营销增长服务商',
                ] as $tzKeyword)
                    <li class="tz-keyword">{{ $tzKeyword }}</li>
                @endforeach
            </ul>
        </div>
    </section>
@endsection
