# 桐灼 GEO

面向大模型生成式搜索（GEO）的内容工程与多端分发系统。

把企业可信的业务资料沉淀为**可被 AI 引用的内容资产**：知识库 RAG → AI 生成 → 人工审核与质检门禁 → 多端分发 → AI 爬虫与可见性监测。

## 交付形态

本产品按**一企业一部署**交付，为企业自建自用，不是共享多租户 SaaS。

## 目录结构

| 目录 | 角色 | 许可 |
| --- | --- | --- |
| `geoflow-src` | 业务与技术底座。基于开源 [GEOFlow](https://github.com/yaojingang/GEOFlow)（Laravel），提供数据库、权限、队列、服务、站点输出与既有业务能力 | AGPL-3.0-only |
| `ai-ui-src` | 后台界面。React + TypeScript 单页应用，真实业务统一调用后端的 `api/v1` | Apache-2.0 |

后台界面是**唯一**的管理入口；后端的旧 Blade 管理面已退役（`/legacy-admin` 返回 404）。

## 快速开始

后端（Laravel）：

```bash
cd geoflow-src
cp .env.example .env
composer install
php artisan key:generate
php artisan migrate --seed
```

容器化部署见 `geoflow-src/docker/` 与 `geoflow-src/deploy-scripts/`。

前端（React）：

```bash
cd ai-ui-src
bun install
bun run dev
```

生产构建产物由后端 `public/ai-ui/` 提供，后台入口为 `/geo_admin`。

首次部署后请立即修改默认管理员口令，并确认 `GEOFLOW_ADMIN_PASSWORD` 已设置为非空值。

## 许可与归属

本仓库包含两种许可的代码，各自的 `LICENSE` 文件位于对应子目录：

- `geoflow-src/` —— **AGPL-3.0-only**，派生自开源项目 GEOFlow。分发本产品（包括通过网络提供服务）时，须遵守 AGPL-3.0 的源码提供义务并保留原始归属声明。
- `ai-ui-src/` —— **Apache-2.0**。

上游项目的归属信息见 `geoflow-src/app/Http/Controllers/Site/AboutController.php`（`repositoryUrl` 指向 https://github.com/yaojingang/GEOFlow ）及相关归属测试，**不得移除**。
