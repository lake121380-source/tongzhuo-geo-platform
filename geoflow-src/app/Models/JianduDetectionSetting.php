<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * 见度「每日自动检测」的单行设置。
 *
 * 单行语义：`current()` 取第一行、没有就按默认值建一行——不引入 key-value
 * 机制，因为这里永远只有一组设置。
 */
class JianduDetectionSetting extends Model
{
    /** 见度支持的平台入口（与见度开放 API 的 platform 取值一致）。 */
    public const PLATFORMS = ['doubao', 'deepseek', 'qianwen', 'yuanbao', 'kimi', 'wenxin'];

    /** 问题集上限：每日检测的规模闸门（额度与成本都由它兜底）。 */
    public const MAX_QUESTIONS = 20;

    protected $fillable = ['enabled', 'platforms_json', 'project_id', 'project_name', 'last_run_at', 'last_run_status'];

    protected function casts(): array
    {
        return [
            'enabled' => 'boolean',
            'last_run_at' => 'datetime',
        ];
    }

    public static function current(): self
    {
        return static::query()->firstOrCreate([], [
            'enabled' => true,
            'platforms_json' => json_encode(['deepseek', 'qianwen']),
        ]);
    }

    /** @return list<string> */
    public function platforms(): array
    {
        $decoded = json_decode((string) $this->platforms_json, true);
        if (! is_array($decoded)) {
            return [];
        }

        return array_values(array_filter($decoded, static fn (mixed $item): bool => is_string($item) && in_array($item, self::PLATFORMS, true)));
    }

    /** @param list<string> $platforms */
    public function setPlatforms(array $platforms): void
    {
        $clean = array_values(array_unique(array_filter($platforms, static fn (string $item): bool => in_array($item, self::PLATFORMS, true))));
        $this->platforms_json = json_encode($clean, JSON_UNESCAPED_UNICODE);
    }

    /**
     * @return array<string, mixed>
     */
    public function projection(): array
    {
        return [
            'enabled' => $this->enabled,
            'platforms' => $this->platforms(),
            'project_id' => $this->project_id,
            'project_name' => $this->project_name,
            'last_run_at' => $this->last_run_at?->toIso8601String(),
            'last_run_status' => $this->last_run_status,
            'max_questions' => self::MAX_QUESTIONS,
            'available_platforms' => self::PLATFORMS,
        ];
    }
}
