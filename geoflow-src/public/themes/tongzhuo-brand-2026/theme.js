/* 首页进场与滚动揭示（2026-09-19）。
 *
 * 「要流畅」在这份实现里的落点，逐条写清楚，免得以后被改成掉帧的样子：
 *
 *  ① **只动 `transform` 与 `opacity`。** 这两条属性由合成器插值，不触发重排与重绘；
 *     碰 `width`/`height`/`top`/`left`/`box-shadow`/`filter` 就会把动画拉回主线程。
 *  ② **用 IntersectionObserver，不监听 scroll。** scroll 回调跑在主线程上，
 *     一旦在回调里读布局（getBoundingClientRect 之类）就会和渲染抢帧。
 *     观察器只在元素跨越阈值时报一次，之后立刻 unobserve。
 *  ③ **动画由 CSS transition 驱动，不写 requestAnimationFrame 循环。** 交给合成器插值，
 *     主线程忙的时候也不掉帧。
 *  ④ **JS 不跑，内容照常看得见。** 初始的隐藏态挂在 `<html class="tz-anim">` 下，
 *     那个类只由首页内联的引导片段添加；引导片段还挂了一个保险定时器，
 *     模块没接管就把类撤掉，页面退回普通静态态。
 *  ⑤ **`prefers-reduced-motion: reduce` 直接不启动**——引导片段里就判掉，连类都不加。
 *  ⑥ 错开（stagger）只按**同一父元素内的次序**算，最多累加 6 档，
 *     免得最后一屏的元素等到看不见。
 */
(function () {
    'use strict';

    var root = document.documentElement;
    if (!root.classList.contains('tz-anim')) {
        return;                     // 引导片段没跑（或已判定减少动效），本模块什么都不做
    }
    clearTimeout(window.__tzAnimFailsafe);   // 模块起来了，撤掉保险

    /* 参与揭示的元素 —— 都是主题里已有的语义类，不改模板结构。
       少写一个选择器只会让那类元素不做动画，不会坏。

       ⚠️ **首屏（.tz-hero / .tz-stats）不在这里**：那几件东西在折叠线以上，
       由 theme.css 里的 `tz-rise` keyframes 做入场，纯 CSS、不依赖本脚本。
       两套都挂在同一批元素上会互相打架（animation 与 transition 抢 opacity）。 */
    var REVEAL = [
        '.tz-block-head',        // 每个板块的「小标签 + 大标题 + 说明」
        '.tz-compare-query',
        '.tz-compare-col',       // 对照两栏
        '.tz-compare-foot',
        '.tz-card',              // 服务 / 市场卡片
        '.tz-step',              // 飞轮四步
        '.tz-signal',            // 三类信号
        '.tz-selfcheck-item',
        '.tz-market-scope'
    ].join(',');

    var STEP_MS = 70;            // 兄弟项之间错开的间隔
    var MAX_STEPS = 6;           // 最多累加几档

    var nodes = Array.prototype.slice.call(document.querySelectorAll(REVEAL));

    /* 按「同一父元素内的次序」算延迟：不同板块各自从 0 开始，节奏一致。 */
    var seen = new Map();
    nodes.forEach(function (el) {
        var parent = el.parentElement;
        var index = seen.get(parent) || 0;
        seen.set(parent, index + 1);
        el.style.setProperty('--tz-d', Math.min(index, MAX_STEPS) * STEP_MS + 'ms');
    });

    /* 老浏览器没有 IntersectionObserver：一次性全显示，不做动画，别把内容扣住。 */
    if (!('IntersectionObserver' in window)) {
        nodes.forEach(function (el) { el.classList.add('tz-rv-in'); });
        return;
    }

    var observer = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            if (!entry.isIntersecting) continue;
            entry.target.classList.add('tz-rv-in');
            observer.unobserve(entry.target);   // 只进不退：已经在视野里出现过的就不再观察
        }
    }, {
        /* 下边界收 6%，元素刚探出头就触发；阈值压到 0.05，
           高元素（比屏还高的卡片）也能正常触发。 */
        rootMargin: '0px 0px -6% 0px',
        threshold: 0.05
    });

    /**
     * 观察器 B：专门收拾「已经被滚过头」的元素。
     *
     * 为什么必须有它：上面的观察器**只在元素进入视口时报**。用户按 End、拖滚动条、
     * 或点一个页面深处的锚点**瞬间跳过**中间内容时，那些元素从没进过视口，
     * 回调永远不触发 —— 它们就一直停在 `opacity: 0`。屏幕上看不出来（本来就在视野外），
     * 但**任何不滚动就渲染页面的东西会拍到一片空白**：链接预览抓图、截图工具、
     * 以及搜索引擎执行 JS 后的整页渲染。
     *
     * ⚠️ 第一版把这件事挂在上面那个观察器的回调里（「有元素相交时顺手把上方的也放出来」），
     * **实测无效**：跳到页尾时视野内可能一个揭示目标都没有，回调带着全 false 触发，
     * 那条分支根本进不去。**不能把兜底挂在「某个别的元素正好在视野里」这个条件上。**
     *
     * 这里换个做法：把 root 的**上边界撑到极大、下边界收到视口顶端**——
     * 于是这个 root 就是「视口上方的那一整条带」。元素一旦落进这条带，就说明已被越过。
     * 纯观察器实现，仍然不监听 scroll。
     */
    var passedObserver = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            if (!entry.isIntersecting) continue;
            entry.target.classList.add('tz-rv-in');
            passedObserver.unobserve(entry.target);
        }
    }, { rootMargin: '100000px 0px -100% 0px', threshold: 0 });

    nodes.forEach(function (el) {
        observer.observe(el);
        passedObserver.observe(el);
    });
})();
