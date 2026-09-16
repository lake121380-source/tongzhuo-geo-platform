<?php

namespace App\Support\Site;

use App\Models\HostedSiteProfile;
use LogicException;

final class CurrentSite
{
    public const TYPE_PRIMARY = 'primary';

    public const TYPE_HOSTED = 'hosted';

    private ?string $type = null;

    private ?string $hostname = null;

    private ?HostedSiteProfile $profile = null;

    public function setPrimary(string $hostname): void
    {
        $this->type = self::TYPE_PRIMARY;
        $this->hostname = $hostname;
        $this->profile = null;
    }

    public function setHosted(HostedSiteProfile $profile): void
    {
        $this->type = self::TYPE_HOSTED;
        $this->hostname = $profile->hostname;
        $this->profile = $profile;
    }

    public function isResolved(): bool
    {
        return $this->type !== null;
    }

    public function isPrimary(): bool
    {
        return $this->type === self::TYPE_PRIMARY;
    }

    public function isHosted(): bool
    {
        return $this->type === self::TYPE_HOSTED;
    }

    public function type(): string
    {
        return $this->type ?? throw new LogicException('Current site has not been resolved.');
    }

    public function hostname(): string
    {
        return $this->hostname ?? throw new LogicException('Current site has not been resolved.');
    }

    public function profile(): ?HostedSiteProfile
    {
        return $this->profile;
    }

    public function profileId(): ?int
    {
        return $this->profile?->id;
    }

    public function channelId(): ?int
    {
        return $this->profile?->distribution_channel_id;
    }

    public function baseUrl(): string
    {
        if ($this->isHosted()) {
            return 'https://'.$this->hostname();
        }

        /*
         * 主站：**优先用当前请求的根**，与模板里的 `route()` / `asset()` 同源。
         *
         * 2026-09-16 修（独立审计 P1-5）：此前这里只读 `config('geoflow.site_url', app.url)`，
         * 而模板走的是请求 Host，**两个互不相干的 base URL 来源**。实测同一个页面里
         * 导航链接指向 `127.0.0.1:18080`、canonical 却指向 `localhost:18080`。
         * 只要这两个来源在生产上有任何差异（换域名、加别名域、反代配置不同步），
         * 全站内链就会分到两个域名下——会话与统计被切开，爬虫看到 canonical 指向"另一个站"。
         *
         * 走请求根还顺带解决另一个问题：canonical 与用户实际访问的域名一致，不会把爬虫
         * 引到一个解析不到的地址。请求 Host 本身是可信的——它已经过 `TrustHosts`
         * （只放行配置里的主域名与托管域）与 `NormalizeRequestHost` 两道校验。
         *
         * CLI / 队列 / 测试进程里没有真实请求，回落到配置值（保持原行为）。
         */
        if (! app()->runningInConsole() && app()->bound('request')) {
            $root = request()->root();
            if (is_string($root) && $root !== '') {
                return rtrim($root, '/');
            }
        }

        return rtrim((string) config('geoflow.site_url', config('app.url')), '/');
    }
}
