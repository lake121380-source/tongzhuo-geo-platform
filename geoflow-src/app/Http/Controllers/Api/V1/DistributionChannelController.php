<?php

namespace App\Http\Controllers\Api\V1;

use App\Exceptions\ApiException;
use App\Exceptions\DistributionChannelDeletionBlocked;
use App\Models\Admin;
use App\Models\DistributionChannel;
use App\Models\DistributionChannelSecret;
use App\Services\Api\IdempotencyService;
use App\Services\GeoFlow\DistributionChannelDeletionConfirmation;
use App\Services\GeoFlow\DistributionChannelDeletionService;
use App\Services\GeoFlow\DistributionChannelOperationLeaseService;
use App\Services\GeoFlow\DistributionOrchestrator;
use App\Support\GeoFlow\ApiKeyCrypto;
use Illuminate\Database\DatabaseManager;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Throwable;

/**
 * Read-only distribution channel projection for the React client.
 * Secrets and channel_config are deliberately never exposed here.
 */
class DistributionChannelController extends BaseApiController
{
    public function store(Request $request, ApiKeyCrypto $apiKeyCrypto, DatabaseManager $database): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $payload = $request->validate([
            'name' => ['required', 'string', 'max:120'],
            'domain' => ['nullable', 'string', 'max:255'],
            'endpoint_url' => ['required', 'url:http,https', 'string', 'max:500'],
            'channel_type' => ['nullable', 'string', 'in:geoflow_agent'],
            'status' => ['nullable', 'string', 'in:active,paused'],
            'description' => ['nullable', 'string', 'max:1000'],
        ]);

        $endpointUrl = rtrim(trim((string) $payload['endpoint_url']), '/');
        $parsed = parse_url($endpointUrl);
        $host = is_array($parsed) && is_string($parsed['host'] ?? null) ? strtolower((string) $parsed['host']) : '';
        if ($host === '') {
            throw new ApiException('invalid_endpoint_url', 'endpoint_url 必须包含有效主机名', 422);
        }
        $domain = trim((string) ($payload['domain'] ?? '')) ?: $host;
        $domain = preg_replace('#^https?://#i', '', $domain) ?: $domain;
        $domain = trim(explode('/', $domain, 2)[0]);
        if ($domain === '') {
            throw new ApiException('invalid_domain', 'domain 不能为空', 422);
        }

        $auth = $this->auth($request);
        $createdSecret = null;
        $response = IdempotencyService::executeJson(
            $request,
            'POST /distribution/channels',
            function () use ($request, $payload, $endpointUrl, $domain, $auth, $apiKeyCrypto, $database, &$createdSecret): JsonResponse {
                $result = $database->transaction(function () use ($payload, $endpointUrl, $domain, $auth, $apiKeyCrypto): array {
                    $channel = DistributionChannel::query()->create([
                        'name' => trim((string) $payload['name']),
                        'domain' => $domain,
                        'endpoint_url' => $endpointUrl,
                        'channel_type' => 'geoflow_agent',
                        'front_mode' => 'static',
                        'status' => (string) ($payload['status'] ?? DistributionChannel::STATUS_ACTIVE),
                        'description' => isset($payload['description']) ? trim((string) $payload['description']) : null,
                        'created_by_admin_id' => $auth->auditAdminId,
                        'last_health_status' => 'not_checked',
                    ]);
                    $keyId = 'gfk_'.Str::lower(Str::random(18));
                    $plainSecret = 'gfsec_'.Str::random(40);
                    DistributionChannelSecret::query()->create([
                        'distribution_channel_id' => (int) $channel->id,
                        'key_id' => $keyId,
                        'secret_ciphertext' => $apiKeyCrypto->encrypt($plainSecret),
                        'status' => 'active',
                        'scopes' => ['article.publish', 'article.update', 'article.delete', 'site.settings.update', 'health.check', 'frontend.capabilities'],
                    ]);

                    return [$channel->fresh(), $keyId, $plainSecret];
                });
                [$channel, $keyId, $plainSecret] = $result;
                $createdSecret = ['key_id' => $keyId, 'secret' => $plainSecret];

                return $this->success($request, [
                    'channel' => $this->projection($channel),
                ], 201);
            },
        );

        if ($createdSecret !== null) {
            $body = json_decode((string) $response->getContent(), true);
            if (is_array($body) && is_array($body['data'] ?? null)) {
                $body['data']['one_time_secret'] = $createdSecret;

                return response()->json($body, $response->getStatusCode(), $response->headers->all());
            }
        }

        return $response;
    }

    public function index(Request $request): JsonResponse
    {
        $channels = DistributionChannel::query()
            ->withCount([
                'articleDistributions as pending_count' => fn ($query) => $query->whereIn('status', ['queued', 'sending']),
                'articleDistributions as failed_count' => fn ($query) => $query->whereIn('status', ['failed', 'outcome_unknown']),
                'articleDistributions as articles_count',
            ])
            ->orderByDesc('id')
            ->get()
            ->map(fn (DistributionChannel $channel): array => $this->projection($channel))
            ->values()
            ->all();

        return $this->success($request, [
            'items' => $channels,
            'pagination' => [
                'page' => 1,
                'per_page' => count($channels),
                'total' => count($channels),
                'total_pages' => 1,
            ],
        ]);
    }

    /**
     * Return one safe channel projection.  Deletion impact is intentionally a
     * separate endpoint so a normal list/detail request never performs the
     * relatively expensive dependency inspection.
     */
    public function show(Request $request, int $channel): JsonResponse
    {
        $record = DistributionChannel::query()
            ->withCount([
                'articleDistributions as pending_count' => fn ($query) => $query->whereIn('status', ['queued', 'sending']),
                'articleDistributions as failed_count' => fn ($query) => $query->whereIn('status', ['failed', 'outcome_unknown']),
                'articleDistributions as articles_count',
            ])
            ->whereKey($channel)
            ->first();
        if (! $record) {
            throw new ApiException('distribution_channel_not_found', '分发渠道不存在', 404);
        }

        return $this->success($request, ['channel' => $this->projection($record)]);
    }

    /**
     * Update the non-secret channel settings used by the React admin.  The
     * full Blade form has additional channel-specific settings; those remain
     * owned by the existing service until their dedicated API contract is
     * migrated.  A channel type cannot be changed in place because doing so
     * would silently invalidate its stored credential/configuration.
     */
    public function update(
        Request $request,
        int $channel,
        DatabaseManager $database,
        DistributionChannelOperationLeaseService $leases,
    ): JsonResponse {
        $this->requireIdempotencyKey($request);
        $payload = $request->validate([
            'name' => ['sometimes', 'required', 'string', 'max:120'],
            'domain' => ['sometimes', 'nullable', 'string', 'max:255'],
            'endpoint_url' => ['sometimes', 'required', 'url:http,https', 'string', 'max:500'],
            'status' => ['sometimes', 'required', 'string', 'in:active,paused'],
            'description' => ['sometimes', 'nullable', 'string', 'max:1000'],
            'channel_type' => ['sometimes', 'string', 'in:geoflow_agent,wordpress_rest,generic_http_api,hosted_site'],
        ]);
        $auth = $this->auth($request);

        return IdempotencyService::executeJson(
            $request,
            'PATCH /distribution/channels/{id}',
            fn (): JsonResponse => $database->transaction(function () use ($request, $channel, $payload, $auth, $leases): JsonResponse {
                $record = DistributionChannel::query()->whereKey($channel)->lockForUpdate()->first();
                if (! $record) {
                    throw new ApiException('distribution_channel_not_found', '分发渠道不存在', 404);
                }
                if ((string) $record->status === DistributionChannel::STATUS_DELETING) {
                    throw new ApiException('distribution_channel_deleting', '分发渠道正在删除流程中，暂不能编辑', 409);
                }
                $leases->assertNoActiveLease($record);

                if (array_key_exists('channel_type', $payload)
                    && (string) $payload['channel_type'] !== (string) $record->channel_type) {
                    throw new ApiException('distribution_channel_type_immutable', '渠道类型不能直接修改，请新建渠道并完成迁移', 422);
                }

                $changes = [];
                if (array_key_exists('name', $payload)) {
                    $changes['name'] = trim((string) $payload['name']);
                }
                if (array_key_exists('endpoint_url', $payload)) {
                    $endpoint = $this->normalizeEndpointUrl((string) $payload['endpoint_url']);
                    $parts = parse_url($endpoint);
                    $host = is_array($parts) ? strtolower((string) ($parts['host'] ?? '')) : '';
                    if ($host === '') {
                        throw new ApiException('invalid_endpoint_url', 'endpoint_url 必须包含有效主机名', 422);
                    }
                    $changes['endpoint_url'] = $endpoint;
                    if (! array_key_exists('domain', $payload) || trim((string) ($payload['domain'] ?? '')) === '') {
                        $changes['domain'] = $host;
                    }
                }
                if (array_key_exists('domain', $payload)) {
                    $domain = $this->normalizeDomain((string) ($payload['domain'] ?? ''));
                    if ($domain === '') {
                        throw new ApiException('invalid_domain', 'domain 不能为空', 422);
                    }
                    $changes['domain'] = $domain;
                }
                foreach (['status', 'description'] as $field) {
                    if (array_key_exists($field, $payload)) {
                        $changes[$field] = $field === 'description'
                            ? (trim((string) ($payload[$field] ?? '')) ?: null)
                            : (string) $payload[$field];
                    }
                }
                if ($changes === []) {
                    return $this->success($request, ['channel' => $this->projection($record)]);
                }

                $record->forceFill($changes)->save();
                $this->logMutation($record, 'channel.updated', '分发渠道配置已通过 API 更新。', $auth->auditAdminId, [
                    'fields' => array_values(array_keys($changes)),
                ]);

                return $this->success($request, ['channel' => $this->projection($record->fresh())]);
            }),
        );
    }

    public function pause(
        Request $request,
        int $channel,
        DatabaseManager $database,
        DistributionChannelOperationLeaseService $leases,
    ): JsonResponse {
        return $this->setStatus($request, $channel, DistributionChannel::STATUS_PAUSED, $database, $leases);
    }

    public function activate(
        Request $request,
        int $channel,
        DatabaseManager $database,
        DistributionChannelOperationLeaseService $leases,
    ): JsonResponse {
        return $this->setStatus($request, $channel, DistributionChannel::STATUS_ACTIVE, $database, $leases);
    }

    /**
     * Secret rotation is deliberately restricted to a super administrator.
     * The plaintext is attached after IdempotencyService has cached the normal
     * response, so replaying a key cannot reveal the credential a second time.
     */
    public function rotateSecret(
        Request $request,
        int $channel,
        ApiKeyCrypto $apiKeyCrypto,
        DatabaseManager $database,
        DistributionChannelOperationLeaseService $leases,
    ): JsonResponse {
        $this->requireIdempotencyKey($request);
        $admin = $this->executionAdmin($request);
        if (! $admin->isSuperAdmin()) {
            throw new ApiException('forbidden', '只有超级管理员可以轮换分发渠道密钥', 403, [
                'required_role' => 'super_admin',
            ]);
        }

        $oneTimeSecret = null;
        $response = IdempotencyService::executeJson(
            $request,
            'POST /distribution/channels/{id}/rotate-secret',
            function () use ($request, $channel, $apiKeyCrypto, $database, $leases, $admin, &$oneTimeSecret): JsonResponse {
                $result = $database->transaction(function () use ($channel, $apiKeyCrypto, $leases): array {
                    $record = DistributionChannel::query()->whereKey($channel)->lockForUpdate()->first();
                    if (! $record) {
                        throw new ApiException('distribution_channel_not_found', '分发渠道不存在', 404);
                    }
                    if ((string) $record->status === DistributionChannel::STATUS_DELETING) {
                        throw new ApiException('distribution_channel_deleting', '分发渠道正在删除流程中，暂不能轮换密钥', 409);
                    }
                    $leases->assertNoActiveLease($record);
                    if (! $record->isGeoFlowAgent()) {
                        throw new ApiException('secret_rotation_not_available', '当前渠道类型不支持 桐灼GEO Agent 密钥轮换', 422);
                    }

                    DistributionChannelSecret::query()
                        ->where('distribution_channel_id', (int) $record->id)
                        ->where('status', 'active')
                        ->update(['status' => 'revoked']);
                    $keyId = 'gfk_'.Str::lower(Str::random(18));
                    $plainSecret = 'gfsec_'.Str::random(40);
                    DistributionChannelSecret::query()->create([
                        'distribution_channel_id' => (int) $record->id,
                        'key_id' => $keyId,
                        'secret_ciphertext' => $apiKeyCrypto->encrypt($plainSecret),
                        'status' => 'active',
                        'scopes' => ['article.publish', 'article.update', 'article.delete', 'site.settings.update', 'health.check', 'frontend.capabilities'],
                    ]);

                    return [$record->fresh(), $keyId, $plainSecret];
                });
                [$record, $keyId, $plainSecret] = $result;
                $oneTimeSecret = ['key_id' => $keyId, 'secret' => $plainSecret];
                $this->logMutation($record, 'channel.secret_rotated', '分发渠道密钥已轮换。', $admin->id);

                return $this->success($request, ['channel' => $this->projection($record)]);
            },
        );

        if ($oneTimeSecret !== null) {
            $body = json_decode((string) $response->getContent(), true);
            if (is_array($body) && is_array($body['data'] ?? null)) {
                $body['data']['one_time_secret'] = $oneTimeSecret;

                return response()->json($body, $response->getStatusCode(), $response->headers->all());
            }
        }

        return $response;
    }

    /** Return the impact fingerprint required by the delete confirmation flow. */
    public function deletionPreview(Request $request, int $channel, DistributionChannelDeletionService $deletions): JsonResponse
    {
        $record = DistributionChannel::query()->whereKey($channel)->first();
        if (! $record) {
            throw new ApiException('distribution_channel_not_found', '分发渠道不存在', 404);
        }
        if (! $deletions->isSchemaReady()) {
            throw new ApiException('distribution_deletion_schema_missing', '分发渠道删除所需的数据表尚未就绪', 503);
        }

        return $this->success($request, [
            'channel' => $this->projection($record),
            'impact' => $deletions->inspect($record),
        ]);
    }

    public function prepareDelete(
        Request $request,
        int $channel,
        DistributionChannelDeletionService $deletions,
    ): JsonResponse {
        $this->requireIdempotencyKey($request);
        $admin = $this->executionAdmin($request);
        if (! $admin->isSuperAdmin()) {
            throw new ApiException('forbidden', '只有超级管理员可以准备删除分发渠道', 403, ['required_role' => 'super_admin']);
        }

        return IdempotencyService::executeJson($request, 'POST /distribution/channels/{id}/prepare-delete', function () use ($request, $channel, $deletions): JsonResponse {
            $record = DistributionChannel::query()->whereKey($channel)->first();
            if (! $record) {
                throw new ApiException('distribution_channel_not_found', '分发渠道不存在', 404);
            }
            if (! $deletions->isSchemaReady()) {
                throw new ApiException('distribution_deletion_schema_missing', '分发渠道删除所需的数据表尚未就绪', 503);
            }
            try {
                $record = $deletions->prepare($record);
            } catch (DistributionChannelDeletionBlocked $exception) {
                throw new ApiException('distribution_delete_blocked', $this->deletionReasonMessage($exception->reason), 409, ['reason' => $exception->reason]);
            }

            return $this->success($request, [
                'channel' => $this->projection($record),
                'impact' => $deletions->inspect($record),
            ]);
        });
    }

    public function cancelDelete(
        Request $request,
        int $channel,
        DistributionChannelDeletionService $deletions,
    ): JsonResponse {
        $this->requireIdempotencyKey($request);
        $this->executionAdmin($request);

        return IdempotencyService::executeJson($request, 'POST /distribution/channels/{id}/cancel-delete', function () use ($request, $channel, $deletions): JsonResponse {
            $record = DistributionChannel::query()->whereKey($channel)->first();
            if (! $record) {
                throw new ApiException('distribution_channel_not_found', '分发渠道不存在', 404);
            }
            $record = $deletions->cancel($record);

            return $this->success($request, ['channel' => $this->projection($record)]);
        });
    }

    /**
     * Complete the destructive delete only after the caller confirms the
     * current impact fingerprint and all applicable acknowledgements.
     */
    public function destroy(
        Request $request,
        int $channel,
        DistributionChannelDeletionService $deletions,
    ): JsonResponse {
        $this->requireIdempotencyKey($request);
        $admin = $this->executionAdmin($request);
        if (! $admin->isSuperAdmin()) {
            throw new ApiException('forbidden', '只有超级管理员可以删除分发渠道', 403, ['required_role' => 'super_admin']);
        }
        $payload = $request->validate([
            'confirmation_name' => ['required', 'string', 'max:120'],
            'impact_fingerprint' => ['required', 'string', 'size:64'],
            'ack_remote_content' => ['nullable', 'boolean'],
            'ack_task_changes' => ['nullable', 'boolean'],
            'ack_credentials' => ['nullable', 'boolean'],
            'ack_history' => ['accepted'],
            'force_stale_sending' => ['nullable', 'boolean'],
            'force_stale_operations' => ['nullable', 'boolean'],
        ]);

        return IdempotencyService::executeJson($request, 'POST /distribution/channels/{id}/delete', function () use ($request, $channel, $deletions, $admin, $payload): JsonResponse {
            $record = DistributionChannel::query()->whereKey($channel)->first();
            if (! $record) {
                throw new ApiException('distribution_channel_not_found', '分发渠道不存在', 404);
            }
            if (! $deletions->isSchemaReady()) {
                throw new ApiException('distribution_deletion_schema_missing', '分发渠道删除所需的数据表尚未就绪', 503);
            }
            $impact = $deletions->inspect($record);
            if (! hash_equals((string) $impact['impact_fingerprint'], (string) $payload['impact_fingerprint'])) {
                throw new ApiException('distribution_delete_impact_changed', '渠道依赖关系已变化，请重新读取删除预览', 409, ['impact' => $impact]);
            }
            if (! hash_equals((string) $record->name, (string) $payload['confirmation_name'])) {
                throw new ApiException('distribution_delete_name_mismatch', '确认名称与渠道名称不一致', 422);
            }
            if ((int) $impact['remote_content_count'] > 0 && ! (bool) ($payload['ack_remote_content'] ?? false)) {
                throw new ApiException('distribution_delete_remote_ack_required', '删除前必须确认远端内容影响', 422);
            }
            if ((int) $impact['linked_task_count'] > 0 && ! (bool) ($payload['ack_task_changes'] ?? false)) {
                throw new ApiException('distribution_delete_task_ack_required', '删除前必须确认任务关联影响', 422);
            }
            if ((int) $impact['secret_count'] > 0 && ! (bool) ($payload['ack_credentials'] ?? false)) {
                throw new ApiException('distribution_delete_credentials_ack_required', '删除前必须确认凭据失效影响', 422);
            }
            if ((int) $impact['fresh_sending_count'] > 0 || (int) $impact['fresh_operation_count'] > 0) {
                throw new ApiException('distribution_delete_operation_in_progress', '渠道仍有进行中的发送或操作租约', 409);
            }
            if ((int) $impact['stale_sending_count'] > 0 && ! (bool) ($payload['force_stale_sending'] ?? false)) {
                throw new ApiException('distribution_delete_stale_sending_ack_required', '请确认处理过期发送任务', 422);
            }
            if ((int) $impact['stale_operation_count'] > 0 && ! (bool) ($payload['force_stale_operations'] ?? false)) {
                throw new ApiException('distribution_delete_stale_operation_ack_required', '请确认处理过期操作租约', 422);
            }

            try {
                $context = $deletions->delete($record, $admin, new DistributionChannelDeletionConfirmation(
                    impactFingerprint: (string) $payload['impact_fingerprint'],
                    ackRemoteContent: (bool) ($payload['ack_remote_content'] ?? false),
                    ackTaskChanges: (bool) ($payload['ack_task_changes'] ?? false),
                    ackCredentials: (bool) ($payload['ack_credentials'] ?? false),
                    ackHistory: true,
                    forceStaleSending: (bool) ($payload['force_stale_sending'] ?? false),
                    forceStaleOperations: (bool) ($payload['force_stale_operations'] ?? false),
                ));
            } catch (DistributionChannelDeletionBlocked $exception) {
                throw new ApiException('distribution_delete_blocked', $this->deletionReasonMessage($exception->reason), 409, ['reason' => $exception->reason]);
            }

            return $this->success($request, [
                'deleted' => true,
                'channel_id' => $channel,
                'audit' => [
                    'event' => 'channel.deleted',
                    'admin_id' => (int) $admin->id,
                    'impact' => $context['impact'] ?? [],
                ],
            ]);
        });
    }

    public function health(Request $request, int $channel, DistributionOrchestrator $orchestrator): JsonResponse
    {
        $record = DistributionChannel::query()->whereKey($channel)->first();
        if (! $record) {
            throw new ApiException('distribution_channel_not_found', '分发渠道不存在', 404);
        }

        try {
            $result = $orchestrator->healthCheck($record);
            $record->forceFill([
                'last_health_status' => 'ok',
                'last_health_checked_at' => now(),
                'last_error_message' => null,
                'endpoint_url' => is_string($result['agent_base_url'] ?? null)
                    ? rtrim((string) $result['agent_base_url'], '/')
                    : $record->endpoint_url,
            ])->save();

            return $this->success($request, [
                'channel' => $this->projection($record->fresh()),
                'health' => $result,
            ]);
        } catch (Throwable $exception) {
            $record->forceFill([
                'last_health_status' => 'failed',
                'last_health_checked_at' => now(),
                'last_error_message' => mb_substr($exception->getMessage(), 0, 1000),
            ])->save();

            throw new ApiException('distribution_health_failed', '分发渠道健康检查失败', 502, [
                'channel_id' => (int) $record->id,
            ]);
        }
    }

    private function requireIdempotencyKey(Request $request): void
    {
        if (trim((string) $request->header('X-Idempotency-Key')) === '') {
            throw new ApiException('idempotency_key_required', '缺少 X-Idempotency-Key', 422);
        }
    }

    private function setStatus(
        Request $request,
        int $channel,
        string $status,
        DatabaseManager $database,
        DistributionChannelOperationLeaseService $leases,
    ): JsonResponse {
        $this->requireIdempotencyKey($request);
        $auth = $this->auth($request);

        return IdempotencyService::executeJson($request, 'POST /distribution/channels/{id}/status', function () use ($request, $channel, $status, $database, $leases, $auth): JsonResponse {
            return $database->transaction(function () use ($request, $channel, $status, $leases, $auth): JsonResponse {
                $record = DistributionChannel::query()->whereKey($channel)->lockForUpdate()->first();
                if (! $record) {
                    throw new ApiException('distribution_channel_not_found', '分发渠道不存在', 404);
                }
                if ((string) $record->status === DistributionChannel::STATUS_DELETING) {
                    throw new ApiException('distribution_channel_deleting', '分发渠道正在删除流程中，暂不能切换状态', 409);
                }
                $leases->assertNoActiveLease($record);
                if ((string) $record->status !== $status) {
                    $record->forceFill([
                        'status' => $status,
                        'last_error_message' => null,
                    ])->save();
                    $this->logMutation($record, $status === DistributionChannel::STATUS_ACTIVE ? 'channel.activated' : 'channel.paused', $status === DistributionChannel::STATUS_ACTIVE ? '分发渠道已启用。' : '分发渠道已暂停。', $auth->auditAdminId);
                }

                return $this->success($request, ['channel' => $this->projection($record->fresh())]);
            });
        });
    }

    private function normalizeEndpointUrl(string $value): string
    {
        $value = trim($value);
        if ($value === '') {
            return '';
        }
        if (! str_contains($value, '://')) {
            $value = 'https://'.$value;
        }

        return rtrim($value, '/');
    }

    private function normalizeDomain(string $value): string
    {
        $value = trim($value);
        if ($value === '') {
            return '';
        }
        $value = preg_replace('#^https?://#i', '', $value) ?: $value;

        return trim(explode('/', $value, 2)[0]);
    }

    /** @param array<string,mixed> $context */
    private function logMutation(DistributionChannel $channel, string $event, string $message, int $adminId, array $context = []): void
    {
        $context['admin_id'] = $adminId;
        $channel->logs()->create([
            'level' => 'info',
            'event' => $event,
            'message' => $message,
            'context' => $context,
            'created_at' => now(),
        ]);
    }

    private function deletionReasonMessage(string $reason): string
    {
        return match ($reason) {
            'hosted_archive_required' => 'Hosted Site 必须先归档。',
            'operation_in_progress' => '渠道存在进行中的操作。',
            'prepare_required' => '请先准备删除。',
            'super_admin_required' => '只有超级管理员可以执行此操作。',
            default => '渠道当前不允许执行该删除操作。',
        };
    }

    /** @return array<string,mixed> */
    private function projection(DistributionChannel $channel): array
    {
        return [
            'id' => (int) $channel->id,
            'name' => (string) $channel->name,
            'domain' => (string) ($channel->domain ?? ''),
            'endpoint_url' => (string) ($channel->endpoint_url ?? ''),
            'channel_type' => (string) $channel->channel_type,
            'status' => (string) $channel->status,
            'description' => (string) ($channel->description ?? ''),
            'last_health_status' => (string) ($channel->last_health_status ?? 'not_checked'),
            'last_health_checked_at' => $channel->last_health_checked_at?->toIso8601String(),
            'last_error_message' => $channel->last_error_message,
            'created_at' => $channel->created_at?->toIso8601String(),
            'pending_count' => (int) ($channel->pending_count ?? 0),
            'failed_count' => (int) ($channel->failed_count ?? 0),
            'articles_count' => (int) ($channel->articles_count ?? 0),
        ];
    }
}
