<?php

namespace App\Support\Site;

use App\Models\HostedSiteProfile;
use App\Models\SiteSetting;
use Illuminate\Support\Facades\Schema;

/**
 * 「被测量的客户品牌」的唯一来源。
 *
 * 只认可运营方在品牌实体配置（`ai_brand_entity_config`）里显式声明的名称。
 * 产品品牌名（厂商名）与部署站点默认名都不能当作客户品牌：`geoflow.site_name` 这类配置的
 * 默认值就是产品品牌名，拿它去匹配客户的 AI 回答，会在客户实例上产生必然错误的可见度结论。
 *
 * 未配置时返回空数组，由调用方标记为「不可计算」，而不是回落到任何默认名。
 *
 * 缓存边界：`config()` 与 `hostedSiteHostnames()` 用 `once()` 做请求级记忆化，框架在
 * Octane 每请求、测试每用例都会 flush，因此 HTTP 路径总是读到最新配置。**队列 Worker
 * 与常驻命令不会 flush**：若将来有 Job 读取本类，它会在首个任务缓存品牌配置、之后一直沿用，
 * 运营方改配置或新增 Hosted Site 都看不到。届时需要在该 Job 里先 `Once::flush()`，
 * 或改为不记忆化读取。当前调用方只有 HTTP 控制器，未触发。
 */
final class BrandIdentity
{
    public const SETTING_KEY = 'ai_brand_entity_config';

    /**
     * @return list<string>
     */
    public static function names(): array
    {
        $names = [];
        foreach (['organizationName', 'alternateName', 'legalName'] as $key) {
            $name = trim((string) (self::config()[$key] ?? ''));
            if ($name === '' || mb_strlen($name) < 2) {
                continue;
            }
            if (in_array(mb_strtolower($name), array_map('mb_strtolower', $names), true)) {
                continue;
            }
            $names[] = $name;
        }

        return $names;
    }

    /**
     * 运营方显式声明的自有主机名，供各类「自有引用份额」指标共用。
     *
     * 只认两类显式声明：品牌实体配置里的 `officialDomain`，以及运营方在 GEOFlow 中
     * 主动开通的 Hosted Site 主机名。不使用 `geoflow.site_url` / `app.url` 这类部署默认地址——
     * 它们在每个实例上都非空，会把「从未声明过自有域名」报成「已配置」，
     * 还会让同一条引用在查询雷达、竞品雷达和沙盘里得到互相矛盾的归属。
     *
     * 未声明时返回空数组，由调用方标记为「不可计算」。
     *
     * @return list<string>
     */
    public static function ownedHosts(): array
    {
        $values = collect([self::config()['officialDomain'] ?? null])
            ->merge(self::hostedSiteHostnames());

        return $values
            ->map(fn (mixed $value): string => self::normalizeHost((string) $value))
            ->filter(fn (string $host): bool => $host !== '' && ! in_array($host, ['localhost', '127.0.0.1', '::1'], true))
            ->unique()
            ->values()
            ->all();
    }

    /** 主机名归一化：去协议/端口/大小写与前缀 www.。 */
    public static function normalizeHost(string $value): string
    {
        $value = trim(mb_strtolower($value));
        if ($value === '') {
            return '';
        }
        $host = parse_url(str_contains($value, '://') ? $value : 'https://'.$value, PHP_URL_HOST);
        $host = trim(mb_strtolower(is_string($host) ? $host : ''));

        return preg_replace('/^www\./', '', $host) ?? $host;
    }

    /** @return list<string> */
    private static function hostedSiteHostnames(): array
    {
        // 与 config() 一样做请求级 memo：Schema::hasTable 本身也是一次查询。
        return once(function (): array {
            if (! Schema::hasTable('hosted_site_profiles')) {
                return [];
            }

            return HostedSiteProfile::query()->pluck('hostname')->all();
        });
    }

    /** @return array<string, mixed> */
    private static function config(): array
    {
        // once() 是请求级 memo（Octane 每请求、测试每用例都会 flush），
        // 避免同一请求内 names() 与 ownedHosts() 各查一次 site_settings。
        // 本类只读不写：品牌配置的写入点在 AiResearchController::saveBrandEntity，
        // 它写完后用的是自己的请求级缓存、不经由这里读取，因此不存在「写完读旧值」。
        return once(function (): array {
            $raw = SiteSetting::query()->where('setting_key', self::SETTING_KEY)->value('setting_value');
            $decoded = is_string($raw) ? json_decode($raw, true) : [];

            return is_array($decoded) ? $decoded : [];
        });
    }
}
