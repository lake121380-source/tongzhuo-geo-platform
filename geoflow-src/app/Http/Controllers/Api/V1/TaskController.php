<?php

namespace App\Http\Controllers\Api\V1;

use App\Exceptions\ApiException;
use App\Http\Requests\Api\StoreTaskRequest;
use App\Http\Requests\Api\TaskTitleReadinessRequest;
use App\Http\Requests\Api\UpdateTaskRequest;
use App\Models\Admin;
use App\Models\DistributionChannel;
use App\Models\Task;
use App\Services\Api\ApiTokenService;
use App\Services\Api\IdempotencyService;
use App\Services\GeoFlow\TaskLifecycleService;
use App\Services\GeoFlow\TaskMonitoringQueryService;
use App\Services\GeoFlow\TaskTitleReadinessService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * API v1 任务（tasks）生命周期：列表、创建、详情、更新、启停、入队、子 Job 列表。
 *
 * 读接口需 tasks:read，写接口需 tasks:write。部分写操作支持 X-Idempotency-Key 幂等。
 */
class TaskController extends BaseApiController
{
    /**
     * 返回 Worker 心跳与当前执行摘要。
     *
     * 该接口是只读监控投影，复用后台任务页同一查询服务；is_stale 由
     * geoflow.worker_stale_seconds 决定，避免前端自行推断 Worker 是否失联。
     * 需要 tasks:read scope。
     */
    public function workers(Request $request, TaskMonitoringQueryService $monitoring): JsonResponse
    {
        $page = max(1, $request->integer('page', 1));
        $perPage = max(1, min(50, $request->integer('per_page', 20)));
        $workers = $monitoring->paginateWorkers($page, $perPage);

        return $this->success($request, [
            'items' => array_values($workers->items()),
            'pagination' => [
                'page' => (int) $workers->currentPage(),
                'per_page' => (int) $workers->perPage(),
                'total' => (int) $workers->total(),
                'total_pages' => (int) $workers->lastPage(),
            ],
        ]);
    }

    /**
     * 任务与队列的全局健康快照。
     *
     * 旧后台的 `tasks/health-check` 本来就是个 JSON 接口——退役后运营方靠它看
     * 「队列堵没堵、Worker 在不在、最近都跑了什么」。这里**只回 JSON**：
     * 旧接口里那两段服务端渲染的 Blade HTML 是页面专用的，随退役一起消失，不算缺口。
     *
     * **不回 `tasks` 列表**：它和 `GET tasks` 是同一份投影，两个入口各回一种形状
     * 才是真的会漂移。需要 tasks:read scope。
     */
    public function health(Request $request, TaskMonitoringQueryService $monitoring): JsonResponse
    {
        $overview = $monitoring->buildAdminOverview(max(1, $request->integer('page', 1)), 50);

        return $this->success($request, [
            'queue_overview' => $overview['queue_overview'],
            'worker_overview' => $overview['worker_overview'],
            'recent_runs' => $overview['recent_runs'],
            'task_summary' => $overview['task_summary'],
            'pagination' => $overview['pagination'],
        ]);
    }

    /**
     * 跨任务的最近运行列表（旧后台 `tasks/jobs` 页）。
     *
     * 与 `GET tasks/{task}/jobs` 的区别是**范围**：那是单个任务的 job，这是全部任务的。
     * `run_id` 用来聚焦到某一次运行。需要 tasks:read scope。
     */
    public function recentRuns(Request $request, TaskMonitoringQueryService $monitoring): JsonResponse
    {
        $this->executionAdmin($request);

        $runs = $monitoring->paginateRecentRuns(
            max(1, $request->integer('page', 1)),
            max(1, min(50, $request->integer('per_page', 10))),
            $request->integer('run_id') ?: null,
        );

        return $this->success($request, [
            'items' => array_values($runs->items()),
            'pagination' => [
                'page' => (int) $runs->currentPage(),
                'per_page' => (int) $runs->perPage(),
                'total' => (int) $runs->total(),
                'total_pages' => (int) $runs->lastPage(),
            ],
        ]);
    }

    /**
     * 检查标题库能否满足任务生成量。
     *
     * 这是纯查询接口，不会修改任务或标题库。请求参数与旧 Blade 的
     * POST /tasks/title-readiness 保持一致，但通过 GET query 传入，方便
     * -AI 页面在保存/启用前预检。需要 tasks:read scope。
     */
    public function titleReadiness(
        TaskTitleReadinessRequest $request,
        TaskTitleReadinessService $readiness,
    ): JsonResponse {
        $viewer = $this->executionAdmin($request);
        $payload = $request->validated();
        $taskId = isset($payload['task_id']) ? (int) $payload['task_id'] : null;

        // 托管站点任务的标题冲突会暴露受保护任务信息；沿用任务生命周期
        // 的超级管理员边界，普通管理员只能预检未绑定托管站点的任务。
        if ($taskId !== null && ! $viewer->isSuperAdmin() && $this->isHostedTask($taskId)) {
            throw new ApiException('forbidden', '托管站点任务只能由超级管理员检查标题就绪度', 403);
        }

        $report = $readiness->inspect(
            (int) $payload['title_library_id'],
            (int) $payload['article_limit'],
            (bool) $payload['is_loop'],
            (string) $payload['status'],
            $taskId,
        );

        if (! $viewer->isSuperAdmin()) {
            $report = $this->redactHostedTaskConflicts($report);
        }

        return $this->success($request, $report);
    }

    /**
     * 分页列出任务（新契约含 task_progress / queue_overview）。
     *
     * 查询参数：page、per_page、status、search（按名称模糊）。
     */
    public function index(Request $request, TaskLifecycleService $tasks): JsonResponse
    {
        $viewer = $this->executionAdmin($request);
        $statusQuery = $request->query('status');
        $searchQuery = $request->query('search');

        $data = $tasks->listTasksForApi(
            page: $request->integer('page', 1),
            perPage: $request->integer('per_page', 20),
            filters: [
                'status' => is_string($statusQuery) ? trim($statusQuery) : null,
                'search' => is_string($searchQuery) ? trim($searchQuery) : null,
            ],
            viewer: $viewer,
        );

        return $this->success($request, $data);
    }

    /**
     * Return the task trash projection used by the legacy admin page.
     * Deleted tasks remain recoverable for the configured retention window;
     * the snapshot sequence keeps pagination stable while new deletions occur.
     */
    public function trash(Request $request, TaskMonitoringQueryService $monitoring): JsonResponse
    {
        $this->executionAdmin($request);

        return $this->success($request, $monitoring->trashedTaskHistory(
            page: max(1, $request->integer('page', 1)),
            perPage: min(100, max(1, $request->integer('per_page', 20))),
            snapshotId: $request->integer('snapshot_id') > 0 ? $request->integer('snapshot_id') : null,
        ));
    }

    /**
     * 创建任务；成功 HTTP 201。
     *
     * 幂等键：POST /tasks（请求头 X-Idempotency-Key 可选）。
     */
    public function store(StoreTaskRequest $request, TaskLifecycleService $tasks, ApiTokenService $tokens): JsonResponse
    {
        $viewer = $this->executionAdmin($request);
        $data = $this->reviewBoundTaskData($request, $request->validated(), $tokens);
        $auth = $this->auth($request);

        $response = IdempotencyService::executeJson(
            $request,
            'POST /tasks',
            fn (): JsonResponse => $this->success($request, $tasks->createTaskForApi(
                data: $data,
                auditAdminId: $auth->auditAdminId,
                apiTokenId: (int) ($auth->token['id'] ?? 0),
                viewer: $viewer,
            ), 201),
        );

        return $this->refreshTaskModelProjection($response, $tasks, $viewer);
    }

    /**
     * 任务详情（双层视图：业务进度 + 队列监控摘要）。
     */
    public function show(Request $request, int $task, TaskLifecycleService $tasks): JsonResponse
    {
        $viewer = $this->executionAdmin($request);

        return $this->success($request, $tasks->getTaskForApi(taskId: $task, viewer: $viewer));
    }

    /**
     * 部分更新任务字段。
     *
     * 幂等键：PATCH /tasks/{id}
     */
    public function update(UpdateTaskRequest $request, int $task, TaskLifecycleService $tasks, ApiTokenService $tokens): JsonResponse
    {
        $viewer = $this->executionAdmin($request);
        $data = $this->reviewBoundTaskData($request, $request->validated(), $tokens);
        $auth = $this->auth($request);

        $response = IdempotencyService::executeJson(
            $request,
            'PATCH /tasks/{id}',
            fn (): JsonResponse => $this->success($request, $tasks->updateTaskForApi(
                taskId: $task,
                data: $data,
                canManageHostedTask: $this->canManageHostedTask($viewer),
                auditAdminId: $auth->auditAdminId,
                apiTokenId: (int) ($auth->token['id'] ?? 0),
                viewer: $viewer,
            )),
        );

        return $this->refreshTaskModelProjection($response, $tasks, $viewer);
    }

    /**
     * 删除任务。幂等键：DELETE /tasks/{id}
     */
    public function destroy(Request $request, int $task, TaskLifecycleService $tasks): JsonResponse
    {
        $auth = $this->auth($request);
        $viewer = $this->executionAdmin($request);

        return IdempotencyService::executeJson(
            $request,
            'DELETE /tasks/{id}',
            fn (): JsonResponse => $this->success($request, $tasks->deleteTask(
                $task,
                $this->canManageHostedTask($viewer),
                $auth->auditAdminId,
                (int) ($auth->token['id'] ?? 0),
            )),
        );
    }

    /**
     * Restore a task from the trash in a safe paused state. The sequence is
     * mandatory so a stale UI cannot restore a different trash snapshot.
     */
    public function restore(Request $request, int $task, TaskLifecycleService $tasks): JsonResponse
    {
        $viewer = $this->executionAdmin($request);
        $auth = $this->auth($request);
        $payload = $request->validate([
            'trash_sequence' => ['required', 'integer', 'min:1'],
        ]);

        return IdempotencyService::executeJson(
            $request,
            'POST /tasks/{id}/restore',
            fn (): JsonResponse => $this->success($request, $tasks->restoreTask(
                taskId: $task,
                trashSequence: (int) $payload['trash_sequence'],
                canManageProtectedTask: $this->canManageHostedTask($viewer),
                auditAdminId: $auth->auditAdminId,
                apiTokenId: (int) ($auth->token['id'] ?? 0),
            )),
        );
    }

    /**
     * 激活任务并可选择立即入队一条生成任务。
     *
     * 请求体可选 enqueue_now（布尔）。幂等键：POST /tasks/{id}/start
     */
    public function start(Request $request, int $task, TaskLifecycleService $tasks, ApiTokenService $tokens): JsonResponse
    {
        $viewer = $this->executionAdmin($request);
        $this->assertTaskExecutionScope($request, $task, $tokens);
        $enqueueNow = ! empty($request->input('enqueue_now'));

        $response = IdempotencyService::executeJson(
            $request,
            'POST /tasks/{id}/start',
            fn (): JsonResponse => $this->success($request, $tasks->startTaskForApi(
                taskId: $task,
                enqueueNow: $enqueueNow,
                canManageHostedTask: $this->canManageHostedTask($viewer),
                viewer: $viewer,
            )),
        );

        return $this->refreshTaskModelProjection($response, $tasks, $viewer);
    }

    /**
     * 暂停任务并取消待处理 Job。
     *
     * 幂等键：POST /tasks/{id}/stop
     */
    public function stop(Request $request, int $task, TaskLifecycleService $tasks): JsonResponse
    {
        $viewer = $this->executionAdmin($request);
        $response = IdempotencyService::executeJson(
            $request,
            'POST /tasks/{id}/stop',
            fn (): JsonResponse => $this->success($request, $tasks->stopTaskForApi(
                taskId: $task,
                canManageHostedTask: $this->canManageHostedTask($viewer),
                viewer: $viewer,
            )),
        );

        return $this->refreshTaskModelProjection($response, $tasks, $viewer);
    }

    /**
     * 向队列投递一条 Job；成功 HTTP 201。
     *
     * 请求体仅接受业务任务类型；队列来源由服务端写入。幂等键：POST /tasks/{id}/enqueue
     */
    public function enqueue(Request $request, int $task, TaskLifecycleService $tasks, ApiTokenService $tokens): JsonResponse
    {
        $viewer = $this->executionAdmin($request);
        $this->assertTaskExecutionScope($request, $task, $tokens);
        $body = $request->all();
        $jobType = trim((string) ($body['job_type'] ?? 'generate_article'));

        return IdempotencyService::executeJson(
            $request,
            'POST /tasks/{id}/enqueue',
            fn (): JsonResponse => $this->success($request, $tasks->enqueueTaskForApi(
                taskId: $task,
                jobType: $jobType,
                payload: ['source' => 'api_enqueue'],
                canManageHostedTask: $this->canManageHostedTask($viewer),
                viewer: $viewer,
            ), 201),
        );
    }

    private function canManageHostedTask(Admin $admin): bool
    {
        return $admin->isSuperAdmin();
    }

    /** @param array<string,mixed> $data @return array<string,mixed> */
    private function reviewBoundTaskData(Request $request, array $data, ApiTokenService $tokens): array
    {
        if (! $tokens->tokenHasScope($this->auth($request)->token, 'articles:publish')) {
            $data['need_review'] = true;
        }

        return $data;
    }

    private function assertTaskExecutionScope(Request $request, int $taskId, ApiTokenService $tokens): void
    {
        if ($tokens->tokenHasScope($this->auth($request)->token, 'articles:publish')) {
            return;
        }
        $task = Task::query()->findOrFail($taskId);
        if (! (bool) $task->need_review) {
            throw new ApiException('forbidden', '该任务可以自动发布，需要 articles:publish scope', 403, [
                'required_scope' => 'articles:publish',
            ]);
        }
    }

    /**
     * 列出某任务下的执行记录（task_runs）。
     *
     * 查询参数：status（可选）、limit（默认 20，最大 100）。
     */
    public function jobs(Request $request, int $task, TaskLifecycleService $tasks): JsonResponse
    {
        $viewer = $this->executionAdmin($request);
        $status = $request->query('status');
        $statusStr = is_string($status) ? trim($status) : '';

        return $this->success($request, $tasks->listTaskJobsForApi(
            taskId: $task,
            status: $statusStr !== '' ? $statusStr : null,
            limit: $request->integer('limit', 20),
            viewer: $viewer,
        ));
    }

    private function isHostedTask(int $taskId): bool
    {
        return Task::query()
            ->whereKey($taskId)
            ->whereHas('distributionChannels', static fn ($query) => $query->where(
                'distribution_channels.channel_type',
                DistributionChannel::TYPE_HOSTED_SITE,
            ))
            ->exists();
    }

    /** @param array<string,mixed> $report @return array<string,mixed> */
    private function redactHostedTaskConflicts(array $report): array
    {
        $conflicts = is_array($report['conflicts'] ?? null) ? $report['conflicts'] : [];
        if ($conflicts === []) {
            return $report;
        }

        $ids = collect($conflicts)
            ->pluck('id')
            ->map(static fn (mixed $id): int => (int) $id)
            ->filter()
            ->values();
        if ($ids->isEmpty()) {
            return $report;
        }

        $protectedIds = Task::query()
            ->whereIn('id', $ids->all())
            ->whereHas('distributionChannels', static fn ($query) => $query->where(
                'distribution_channels.channel_type',
                DistributionChannel::TYPE_HOSTED_SITE,
            ))
            ->pluck('id')
            ->mapWithKeys(static fn (mixed $id): array => [(int) $id => true]);

        $report['conflicts'] = collect($conflicts)
            ->reject(static fn (array $conflict): bool => $protectedIds->has((int) ($conflict['id'] ?? 0)))
            ->values()
            ->all();
        $report['redacted_conflict_count'] = $protectedIds->count();

        return $report;
    }

    private function refreshTaskModelProjection(
        JsonResponse $response,
        TaskLifecycleService $tasks,
        Admin $viewer,
    ): JsonResponse {
        $payload = $response->getData(true);
        $taskId = is_array($payload) ? data_get($payload, 'data.id') : null;
        if (! is_numeric($taskId) || (int) $taskId <= 0 || $response->getStatusCode() >= 400) {
            return $response;
        }

        $current = $tasks->getTaskForApi(taskId: (int) $taskId, viewer: $viewer);
        $data = is_array($payload['data'] ?? null) ? $payload['data'] : [];
        foreach ([
            'ai_model_id',
            'ai_model_name',
            'ai_model_accessible',
            'ai_model_access_reason',
            'ai_quality_model_id',
            'ai_quality_model_name',
            'ai_quality_model_accessible',
            'ai_quality_model_access_reason',
            'batch_error_message',
        ] as $key) {
            $data[$key] = $current[$key] ?? null;
        }
        data_set(
            $data,
            'task_progress.last_error_message',
            data_get($current, 'task_progress.last_error_message'),
        );
        $payload['data'] = $data;
        $response->setData($payload);

        return $response;
    }
}
