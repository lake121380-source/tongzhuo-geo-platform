# 桐灼 GEO `-AI` 后台界面

## 这是什么

本目录是由其他 AI 生成并继续集成的 React 19/Vite 后台页面和交互稿。它不是完整 GEOFlow 产品，也不是生产业务后端。

- `../geoflow-src` 是用户下载的 GEOFlow 开源项目，是最终产品的业务与技术底座。
- 本目录是最终后台界面，同时也是哥哥所需增量 GEO 功能的需求来源。
- 页面、按钮、路由或演示接口存在，不代表功能已经正确实现。
- 最终业务统一在 GEOFlow 的 Laravel、数据库、权限、队列和服务体系上实现，后台用户只使用本目录构建出的 React 界面。

当前权威产品口径见 [../docs/PRODUCT_SCOPE.md](../docs/PRODUCT_SCOPE.md)。

## 不是生产后端

以下内容只属于原型兼容或演示，不能进入生产：

- `server.ts` 中的 Express 兼容 API；
- `data/runtime-state.json` 和内存状态；
- mock 数据、固定公式、随机指标、预置引用和伪成功；
- 浏览器本地配置代替权限、审计、密钥或持久化。

生产模式只允许 React 页面调用 GEOFlow 的真实 API。每项能力都要重新核验产品目的、GEOFlow 复用边界、真实数据、权限、失败状态，以及适用的队列、幂等和审计；以前 AI 写下的代码与测试记录也不能直接当作完成证明。

## 目录结构

| 路径 | 用途 |
| --- | --- |
| `src/` | React 页面、组件、类型和 API 客户端 |
| `src/api/` | GEOFlow API 客户端与契约测试 |
| `server.ts` | 历史原型兼容服务，不是生产后端 |
| `data/runtime-state.json` | 历史演示状态，不是生产数据库 |
| `dist/` | 本地构建产物 |

## 运行模式

### 原型模式

`npm run dev` 会启动包含 Express 演示逻辑的开发服务，只用于查看历史页面和交互，不用于生产验收。

### GEOFlow 集成模式

`npm run build:integrated` 使用 `/ai-ui/` 基础路径构建 React 资源。最终部署由 GEOFlow 提供 API、认证、数据库、队列、官网和公开 SEO 输出。

当前约定：

- `/` 保留企业官网；
- `/geo_admin` 是 React 后台入口；
- `/api/v1` 由 GEOFlow Laravel 提供；
- 旧后台只有在全部能力重新核验并完成可恢复备份后才能退役。

## 常用脚本

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 启动原型兼容开发服务 |
| `npm run build` | 构建独立演示产物 |
| `npm run build:integrated` | 构建 GEOFlow 集成前端产物 |
| `npm run test:api` | 运行前端 API 契约测试 |
| `npm run test:smoke` | 运行历史演示服务冒烟测试 |

测试通过只证明对应断言通过，不自动证明产品逻辑、真实数据源或完整业务闭环正确。

## 当前阶段

2026-09-08 起暂停功能开发和旧 UI 删除，先形成并确认三份清单：

1. GEOFlow 已有能力；
2. `-AI` 页面与增量需求；
3. 两者合并后的最终产品能力。

此前接入状态见 [../docs/AI_UI_LEGACY_UI_COVERAGE_MATRIX.md](../docs/AI_UI_LEGACY_UI_COVERAGE_MATRIX.md)，但该文档是待重新核验的历史记录，不是完成证明。

## 许可证边界

本目录的 [LICENSE](LICENSE) 和 `package.json` 当前声明 Apache-2.0；`../geoflow-src` 当前采用 AGPL-3.0-only。集成、分发、私有化、白标和商业交付必须分别核对代码来源与许可证义务，不能把最终组合产品整体描述为 Apache-2.0。

本说明不是法律意见；正式商业交付前需要完成许可证与派生代码边界审查。