<?php

namespace App\Services\GeoFlow;

use App\Services\Outbound\SafeOutboundHttpClient;
use DOMDocument;
use DOMXPath;
use Illuminate\Http\Client\Factory;
use Throwable;

/**
 * Read-only URL GEO inspection.  This service deliberately has no AI or
 * browser-side assumptions: all scores are derived from the fetched HTML and
 * auxiliary discovery documents and can therefore be reproduced later.
 */
class UrlScannerService
{
    public function __construct(
        private readonly UrlImportProcessingService $importer,
        private readonly SafeOutboundHttpClient $safeHttp,
        private readonly Factory $http,
    ) {}

    /**
     * @return array{url:string,normalized_url:string,source_domain:string,scanned_at:string,overall_score:int,grade:string,robots_txt_status:array<string,mixed>,llms_txt_status:array<string,mixed>,schema_status:array<string,mixed>,content_quality:array<string,mixed>,items:list<array<string,mixed>>,quick_fix_plan:list<string>}
     */
    public function scan(string $input): array
    {
        $page = $this->importer->inspectPage($input);
        $url = (string) $page['url'];
        $host = (string) $page['host'];
        $html = (string) $page['html'];
        $parsed = is_array($page['page'] ?? null) ? $page['page'] : [];

        $origin = $this->origin($url);
        $robots = $this->fetchAuxiliary($origin.'/robots.txt');
        $llms = $this->fetchAuxiliary($origin.'/llms.txt');
        $targetPath = (string) (parse_url($url, PHP_URL_PATH) ?: '/');
        $robotsStatus = $this->robotsStatus($robots['body'], $robots['status'], $targetPath);
        $llmsStatus = $this->llmsStatus($llms['body'], $llms['status']);
        $schemaStatus = $this->schemaStatus($html);
        $contentQuality = $this->contentQuality($html, (string) ($parsed['text'] ?? ''));

        $scores = [
            $this->robotsScore($robotsStatus),
            $this->llmsScore($llmsStatus),
            $this->schemaScore($schemaStatus),
            $this->contentScore($contentQuality),
            $this->fluffScore((float) $contentQuality['fluff_ratio']),
        ];
        $overall = (int) round(array_sum($scores) / max(1, count($scores)));
        $items = $this->items($robotsStatus, $llmsStatus, $schemaStatus, $contentQuality, $scores);

        return [
            'url' => $url,
            'normalized_url' => $url,
            'source_domain' => $host,
            'scanned_at' => now()->toIso8601String(),
            'overall_score' => $overall,
            'grade' => $this->grade($overall),
            'robots_txt_status' => $robotsStatus,
            'llms_txt_status' => $llmsStatus,
            'schema_status' => $schemaStatus,
            'content_quality' => $contentQuality,
            'items' => $items,
            'quick_fix_plan' => $this->quickFixPlan($robotsStatus, $llmsStatus, $schemaStatus, $contentQuality),
        ];
    }

    /** @return array{status:int,body:string} */
    private function fetchAuxiliary(string $url): array
    {
        try {
            $response = $this->safeHttp->get(
                $this->http->timeout(10)->connectTimeout(5)->withHeaders([
                    'User-Agent' => '桐灼GEO URL Scanner/1.0',
                    'Accept' => 'text/plain,text/*;q=0.9,*/*;q=0.5',
                ]),
                $url,
                (int) config('geoflow.outbound_import_max_bytes', 5 * 1024 * 1024),
                2,
            );

            return ['status' => (int) $response->status(), 'body' => (string) $response->body()];
        } catch (Throwable) {
            return ['status' => 0, 'body' => ''];
        }
    }

    private function origin(string $url): string
    {
        $parts = parse_url($url);
        $scheme = strtolower((string) ($parts['scheme'] ?? 'https'));
        $host = (string) ($parts['host'] ?? '');
        $port = isset($parts['port']) ? ':'.(int) $parts['port'] : '';

        return $scheme.'://'.$host.$port;
    }

    /** @return array{accessible:bool,gpt_bot_allowed:bool,claude_bot_allowed:bool,perplexity_allowed:bool,bytespider_allowed:bool,status:int} */
    private function robotsStatus(string $body, int $status, string $targetPath = '/'): array
    {
        $accessible = $status >= 200 && $status < 400;

        return [
            'accessible' => $accessible,
            'status' => $status,
            'gpt_bot_allowed' => $accessible && $this->botAllowed($body, ['gptbot', 'chatgpt-user'], $targetPath),
            'claude_bot_allowed' => $accessible && $this->botAllowed($body, ['claudebot', 'anthropic-ai'], $targetPath),
            'perplexity_allowed' => $accessible && $this->botAllowed($body, ['perplexitybot'], $targetPath),
            'bytespider_allowed' => $accessible && $this->botAllowed($body, ['bytespider'], $targetPath),
        ];
    }

    private function botAllowed(string $body, array $agents, string $targetPath = '/'): bool
    {
        if (trim($body) === '') {
            return true;
        }
        $groups = [];
        $current = [];
        $rules = [];
        foreach (preg_split('/\R/u', $body) ?: [] as $line) {
            $line = trim((string) preg_replace('/\s*#.*$/', '', $line));
            if ($line === '' || ! str_contains($line, ':')) {
                continue;
            }
            [$key, $value] = array_map('trim', explode(':', $line, 2));
            $key = strtolower($key);
            if ($key === 'user-agent') {
                if ($current !== []) {
                    $groups[] = [$current, $rules];
                }
                $current = [strtolower($value)];
                $rules = [];
            } elseif ($key === 'disallow' && $current !== []) {
                $rules[] = ['disallow', $value];
            } elseif ($key === 'allow' && $current !== []) {
                $rules[] = ['allow', $value];
            }
        }
        if ($current !== []) {
            $groups[] = [$current, $rules];
        }
        $target = strtolower((string) ($agents[0] ?? ''));
        $selected = [];
        foreach ($groups as [$names, $groupRules]) {
            if (in_array($target, $names, true)) {
                $selected = $groupRules;
                break;
            }
            if ($selected === [] && in_array('*', $names, true)) {
                $selected = $groupRules;
            }
        }
        if ($selected === []) {
            return true;
        }
        $winner = null;
        foreach ($selected as [$kind, $path]) {
            if ($path === '') {
                continue;
            }
            if (! str_starts_with($path, '/')) {
                continue;
            }
            $length = strlen($path);
            if (! str_starts_with($targetPath, $path)) {
                continue;
            }
            if ($winner === null || $length > $winner[0] || ($length === $winner[0] && $kind === 'allow')) {
                $winner = [$length, $kind === 'allow'];
            }
        }

        return $winner === null ? true : (bool) $winner[1];
    }

    /** @return array{present:bool,format_standard:bool,url_count:int,has_directives:bool,status:int} */
    private function llmsStatus(string $body, int $status): array
    {
        $present = $status >= 200 && $status < 400 && trim($body) !== '';
        $urlCount = preg_match_all('~\[[^\]]+\]\((https?://[^)]+)\)~i', $body, $matches);
        $hasHeading = preg_match('/^#\s+\S+/m', $body) === 1;
        $hasDirectives = preg_match('/(?:directive|优先引用|must|should|禁止|instructions?)/iu', $body) === 1;

        return [
            'present' => $present,
            'format_standard' => $present && $hasHeading,
            'url_count' => max(0, (int) $urlCount),
            'has_directives' => $present && $hasDirectives,
            'status' => $status,
        ];
    }

    /** @return array{has_schema:bool,types_found:list<string>,json_ld_valid:bool} */
    private function schemaStatus(string $html): array
    {
        $types = [];
        $valid = true;
        $has = false;
        $previous = libxml_use_internal_errors(true);
        $dom = new DOMDocument;
        $dom->loadHTML('<?xml encoding="utf-8" ?>'.$html);
        $xpath = new DOMXPath($dom);
        foreach ($xpath->query('//script[translate(@type,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz")="application/ld+json"]') ?: [] as $node) {
            $has = true;
            $decoded = json_decode((string) $node->textContent, true);
            if (! is_array($decoded)) {
                $valid = false;

                continue;
            }
            $this->collectSchemaTypes($decoded, $types);
        }
        libxml_clear_errors();
        libxml_use_internal_errors($previous);
        sort($types);

        return ['has_schema' => $has, 'types_found' => array_values(array_unique($types)), 'json_ld_valid' => $has && $valid];
    }

    /** @param array<string,mixed>|list<mixed> $value */
    private function collectSchemaTypes(array $value, array &$types): void
    {
        foreach ($value as $key => $item) {
            if ($key === '@type') {
                foreach ((array) $item as $type) {
                    if (is_string($type) && trim($type) !== '') {
                        $types[] = trim($type);
                    }
                }
            } elseif (is_array($item)) {
                $this->collectSchemaTypes($item, $types);
            }
        }
    }

    /** @return array{word_count:int,table_count:int,faq_section_detected:bool,fluff_ratio:float} */
    private function contentQuality(string $html, string $text): array
    {
        $previous = libxml_use_internal_errors(true);
        $dom = new DOMDocument;
        $dom->loadHTML('<?xml encoding="utf-8" ?>'.$html);
        $xpath = new DOMXPath($dom);
        $tableCount = (int) $xpath->query('//table')->length;
        $visible = trim($text) !== '' ? $text : (string) $dom->textContent;
        preg_match_all('/[\p{L}\p{N}]+/u', $visible, $tokens);
        $wordCount = count($tokens[0] ?? []);
        $faq = preg_match('/(?:FAQ|常见问题|Frequently Asked Questions|问答)/iu', $visible) === 1;
        $fluffTerms = ['赋能', '颠覆', '引领', '打造', '助力', '致力', '全面', '领先', '创新'];
        $fluffCount = 0;
        foreach ($fluffTerms as $term) {
            $fluffCount += substr_count($visible, $term);
        }
        libxml_clear_errors();
        libxml_use_internal_errors($previous);

        return [
            'word_count' => $wordCount,
            'table_count' => $tableCount,
            'faq_section_detected' => $faq,
            'fluff_ratio' => $wordCount > 0 ? round($fluffCount / $wordCount * 100, 1) : 0.0,
        ];
    }

    private function robotsScore(array $status): int
    {
        if (! $status['accessible']) {
            return 0;
        }
        $allowed = array_sum(array_map(static fn (mixed $v): int => $v ? 1 : 0, [
            $status['gpt_bot_allowed'], $status['claude_bot_allowed'], $status['perplexity_allowed'], $status['bytespider_allowed'],
        ]));

        return (int) round($allowed / 4 * 100);
    }

    private function llmsScore(array $status): int
    {
        return ($status['present'] ? 50 : 0) + ($status['format_standard'] ? 25 : 0) + ($status['has_directives'] ? 15 : 0) + ($status['url_count'] > 0 ? 10 : 0);
    }

    private function schemaScore(array $status): int
    {
        return ! $status['has_schema'] ? 0 : ($status['json_ld_valid'] ? min(100, 55 + count($status['types_found']) * 15) : 25);
    }

    private function contentScore(array $quality): int
    {
        return min(100, ($quality['word_count'] >= 1000 ? 65 : ($quality['word_count'] >= 500 ? 45 : 25)) + min(20, $quality['table_count'] * 10) + ($quality['faq_section_detected'] ? 15 : 0));
    }

    private function fluffScore(float $ratio): int
    {
        return (int) max(0, min(100, round(100 - $ratio * 10)));
    }

    private function grade(int $score): string
    {
        return $score >= 95 ? 'A+' : ($score >= 85 ? 'A' : ($score >= 70 ? 'B' : ($score >= 55 ? 'C' : 'D')));
    }

    /** @return list<array<string,mixed>> */
    private function items(array $robots, array $llms, array $schema, array $content, array $scores): array
    {
        $status = static fn (int $score): string => $score >= 80 ? 'pass' : ($score >= 50 ? 'warning' : 'fail');

        return [
            ['dimension' => 'AI 爬虫可访问性 (robots.txt)', 'score' => $scores[0], 'status' => $status($scores[0]), 'title' => $robots['accessible'] ? 'robots.txt 可访问并已解析' : 'robots.txt 无法访问', 'details' => sprintf('GPTBot=%s、ClaudeBot=%s、PerplexityBot=%s、Bytespider=%s。', $robots['gpt_bot_allowed'] ? '允许' : '阻止', $robots['claude_bot_allowed'] ? '允许' : '阻止', $robots['perplexity_allowed'] ? '允许' : '阻止', $robots['bytespider_allowed'] ? '允许' : '阻止'), 'recommendation' => $robots['accessible'] && $scores[0] >= 80 ? '保持现有策略并持续监测变更。' : '检查 robots.txt 并为目标 AI 爬虫添加明确 Allow 规则。'],
            ['dimension' => '/llms.txt 规范对齐度', 'score' => $scores[1], 'status' => $status($scores[1]), 'title' => $llms['present'] ? '已发现 /llms.txt' : '未发现可用 /llms.txt', 'details' => sprintf('格式=%s，链接数=%d，指令=%s。', $llms['format_standard'] ? '标准' : '待完善', $llms['url_count'], $llms['has_directives'] ? '已提供' : '未提供'), 'recommendation' => $llms['present'] ? '保持索引与已发布内容同步。' : '发布包含标题、摘要、指令和内容链接的 /llms.txt。'],
            ['dimension' => 'Schema.org JSON-LD 结构化标记', 'score' => $scores[2], 'status' => $status($scores[2]), 'title' => $schema['has_schema'] ? '检测到 JSON-LD 标记' : '未检测到 JSON-LD 标记', 'details' => sprintf('类型：%s；JSON-LD %s。', $schema['types_found'] === [] ? '无' : implode(', ', $schema['types_found']), $schema['json_ld_valid'] ? '有效' : '无效'), 'recommendation' => $schema['json_ld_valid'] ? '补充 about、sameAs 等实体关联字段。' : '添加并校验 Article/Organization 等 Schema.org JSON-LD。'],
            ['dimension' => 'GFM 结构化表格与事实密度', 'score' => $scores[3], 'status' => $status($scores[3]), 'title' => sprintf('正文 %d 词、%d 个表格%s', $content['word_count'], $content['table_count'], $content['faq_section_detected'] ? '，含 FAQ' : ''), 'details' => '根据抓取到的服务端 HTML 统计正文长度、表格和 FAQ 结构。', 'recommendation' => '增加可验证的数字、对比表格和 FAQ 章节，减少模型抽取歧义。'],
            ['dimension' => '去空话废话比 (Anti-Fluff)', 'score' => $scores[4], 'status' => $status($scores[4]), 'title' => sprintf('检测到空泛词占比 %.1f%%', $content['fluff_ratio']), 'details' => '按预定义低信息量词集合计算占正文 token 的比例。', 'recommendation' => $scores[4] >= 80 ? '继续保持以事实和来源为中心的表述。' : '用具体事实、数字和来源替换空泛宣传词。'],
        ];
    }

    /** @return list<string> */
    private function quickFixPlan(array $robots, array $llms, array $schema, array $content): array
    {
        $plan = [];
        if (! $robots['accessible'] || ! $robots['gpt_bot_allowed'] || ! $robots['perplexity_allowed']) {
            $plan[] = '检查 robots.txt，确保 GPTBot、ClaudeBot、PerplexityBot 等目标爬虫可访问公开内容。';
        }
        if (! $llms['present'] || ! $llms['format_standard']) {
            $plan[] = '发布规范的 /llms.txt，并维护与网站内容同步的链接清单。';
        }
        if (! $schema['json_ld_valid']) {
            $plan[] = '补充并验证 Schema.org JSON-LD，至少包含内容类型、标题、作者和发布日期。';
        }
        if ($content['table_count'] === 0 || ! $content['faq_section_detected']) {
            $plan[] = '增加结构化对比表格和 FAQ 章节，提升可抽取事实密度。';
        }

        return array_slice($plan, 0, 5);
    }
}
