<?php

namespace App\Services\Admin\Analytics;

use Illuminate\Support\Carbon;

class AnalyticsLogFilter
{
    /** @var list<string> */
    private const SUPPORTED_SOURCES = ['local', 'hosted_site', 'server', 'channel'];

    /**
     * @param  array<string, mixed>  $input
     */
    public static function fromRequest(array $input): self
    {
        $hasCustomDates = trim((string) ($input['log_date_from'] ?? '')) !== ''
            || trim((string) ($input['log_date_to'] ?? '')) !== '';
        $preset = self::normalizePreset((string) ($input['log_preset'] ?? ($hasCustomDates ? 'custom' : '7d')));
        [$dateFrom, $dateTo] = self::resolveDates($input, $preset);

        return new self(
            preset: $preset,
            dateFrom: $dateFrom,
            dateTo: $dateTo,
            trafficType: self::normalizeChoice(
                (string) ($input['log_traffic_type'] ?? $input['traffic_type'] ?? 'all'),
                ['all', 'human', 'search_bot', 'ai_bot', 'other_bot', 'unknown'],
            ),
            source: self::normalizeChoice(
                (string) ($input['log_source'] ?? 'all'),
                ['all', ...self::SUPPORTED_SOURCES],
            ),
        );
    }

    public function __construct(
        public readonly string $preset,
        public readonly Carbon $dateFrom,
        public readonly Carbon $dateTo,
        public readonly string $trafficType,
        public readonly string $source,
    ) {}

    public function start(): Carbon
    {
        return $this->dateFrom->copy()->startOfDay();
    }

    public function end(): Carbon
    {
        return $this->dateTo->copy()->endOfDay();
    }

    /**
     * @return list<string>
     */
    public static function supportedSources(): array
    {
        return self::SUPPORTED_SOURCES;
    }

    /**
     * @return array<string, string>
     */
    public function toArray(): array
    {
        return [
            'log_preset' => $this->preset,
            'log_date_from' => $this->dateFrom->toDateString(),
            'log_date_to' => $this->dateTo->toDateString(),
            'log_traffic_type' => $this->trafficType,
            'log_source' => $this->source,
        ];
    }

    private static function normalizePreset(string $preset): string
    {
        // `90d` 必须在这里和下面 `$presetDays` 里都有：内容侧（AnalyticsFilter）一直支持 90 天，
        // 流量侧没有它 → 运营在数据分析页选「90 天」时，同一屏里内容卡片按 90 天算、
        // 流量卡片与趋势表悄悄退回 **7 天**（响应里 `log_preset` 会如实回显 7d，但界面不渲染 range）。
        return in_array($preset, ['7d', '30d', '60d', '90d', 'custom'], true) ? $preset : '7d';
    }

    /**
     * @param  array<string, mixed>  $input
     * @return array{0: Carbon, 1: Carbon}
     */
    private static function resolveDates(array $input, string &$preset): array
    {
        $today = Carbon::today();
        $presetDays = ['7d' => 7, '30d' => 30, '60d' => 60, '90d' => 90];

        if (isset($presetDays[$preset])) {
            return [$today->copy()->subDays($presetDays[$preset] - 1), $today->copy()];
        }

        $preset = 'custom';
        $dateFrom = self::parseDate((string) ($input['log_date_from'] ?? '')) ?? $today->copy()->subDays(6);
        $dateTo = self::parseDate((string) ($input['log_date_to'] ?? '')) ?? $today->copy();

        return AnalyticsDateRange::normalize($dateFrom, $dateTo, $today);
    }

    private static function parseDate(string $value): ?Carbon
    {
        $value = trim($value);
        if ($value === '') {
            return null;
        }

        try {
            $date = Carbon::createFromFormat('!Y-m-d', $value);

            return $date->toDateString() === $value ? $date->startOfDay() : null;
        } catch (\Throwable) {
            return null;
        }
    }

    /**
     * @param  list<string>  $allowed
     */
    private static function normalizeChoice(string $value, array $allowed): string
    {
        return in_array($value, $allowed, true) ? $value : 'all';
    }
}
