import { GeoFlowApiClient } from './geoflowClient';

/**
 * Vite 只会暴露 VITE_ 前缀的变量。
 *
 * 2026-09-11：**演示层已整体删除**（Express 演示后端 `server.ts`、`src/data/mockData.ts`、
 * 只在演示模式渲染的页面与各组件的 demo 分支），前端只剩「访问 GEOFlow API」一种模式。
 * 因此这里不再从环境变量推导模式：`VITE_GEOFLOW_MODE` 已失效，设成别的值也不会再切到
 * 任何演示实现——那样只会得到一个没有后端的空壳。
 *
 * 保留 `isGeoFlowApiEnabled` 这个常量名，是为了让 App.tsx 里历史的 `apiEnabled ? A : B`
 * 分支在构建期被摇掉（打包器会折叠 `true ? A : B`），而不是在运行时再判断一次。
 */
const env = ((import.meta as ImportMeta & {
  env?: Record<string, string | undefined>;
}).env || {}) as Record<string, string | undefined>;

export const geoFlowApiBaseUrl = (env.VITE_GEOFLOW_API_URL || '/api/v1').trim().replace(/\/+$/, '');
export const isGeoFlowApiEnabled = true;

export function createGeoFlowApiClient(options: Partial<ConstructorParameters<typeof GeoFlowApiClient>[0]> = {}): GeoFlowApiClient {
  return new GeoFlowApiClient({
    baseUrl: options.baseUrl || geoFlowApiBaseUrl,
    ...options,
  });
}

