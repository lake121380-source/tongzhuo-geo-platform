<?php

namespace App\Support\Site;

/**
 * 站点背后的「公司实体」——对外一致的那份事实。
 *
 * 为什么要有这个类：同一批信息（公司叫什么、一句话定位、卖哪些服务、怎么联系）
 * 有三个消费方，而且要求还不一样：
 *   - 人看的页面（首页 hero、关于页、页脚）；
 *   - 机器读的结构化数据（Organization / Service JSON-LD）；
 *   - AI 爬虫读的 llms.txt / llms-full.txt。
 * 三处各写一遍必然漂移（改了一处忘了另一处），所以这里做成**同一份数据的唯一来源**，
 * 上面三个出口都只做「取数 + 换格式」，不各自解释字段。
 *
 * 存储形态沿用站点设置：除服务清单外都是纯文本。服务清单用「一行一条、竖线分隔」的
 * 写法（`名称|描述`），与本项目首页模块 body 的既有约定一致，后台一个多行输入框就能维护。
 */
final class CompanyProfile
{
    /**
     * @param  list<array{title:string,description:string}>  $services
     */
    private function __construct(
        public readonly string $name,
        public readonly string $legalName,
        public readonly string $tagline,
        public readonly string $description,
        public readonly array $services,
        public readonly string $email,
        public readonly string $phone,
        public readonly string $address,
        public readonly string $foundingDate,
        public readonly string $logo,
    ) {}

    /** @param array<string,string> $map 站点设置原始表 */
    public static function fromSettings(array $map): self
    {
        $name = trim((string) ($map['site_name'] ?? ''));
        if ($name === '') {
            $name = (string) config('geoflow.site_name', config('app.name'));
        }

        return new self(
            name: $name,
            legalName: trim((string) ($map['company_legal_name'] ?? '')),
            tagline: trim((string) ($map['company_tagline'] ?? '')),
            description: trim((string) ($map['site_description'] ?? '')),
            services: self::parseServices((string) ($map['company_services'] ?? '')),
            email: trim((string) ($map['contact_email'] ?? '')),
            phone: trim((string) ($map['contact_phone'] ?? '')),
            address: trim((string) ($map['company_address'] ?? '')),
            foundingDate: trim((string) ($map['company_founded'] ?? '')),
            logo: trim((string) ($map['site_logo'] ?? '')),
        );
    }

    /** 没有任何公司信息时返回 false——用来决定要不要输出结构化数据，避免产出空壳。 */
    public function isConfigured(): bool
    {
        return $this->description !== ''
            || $this->tagline !== ''
            || $this->services !== []
            || $this->email !== ''
            || $this->phone !== '';
    }

    /** 有服务清单才输出 Service 结构化数据。 */
    public function hasServices(): bool
    {
        return $this->services !== [];
    }

    /**
     * 「名称|描述」逐行解析；只给名称也接受（描述留空）。
     *
     * @return list<array{title:string,description:string}>
     */
    private static function parseServices(string $raw): array
    {
        $services = [];
        foreach (preg_split('/\R/u', $raw) ?: [] as $line) {
            $line = trim($line);
            if ($line === '') {
                continue;
            }
            [$title, $description] = array_pad(explode('|', $line, 2), 2, '');
            $title = trim($title);
            if ($title === '') {
                continue;
            }
            $services[] = ['title' => $title, 'description' => trim($description)];
            if (count($services) >= 12) {
                break;
            }
        }

        return $services;
    }
}
