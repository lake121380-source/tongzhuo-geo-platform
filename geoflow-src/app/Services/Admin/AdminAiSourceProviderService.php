<?php

namespace App\Services\Admin;

use App\Data\Admin\AdminAiSourceProviderTestSnapshot;
use App\Exceptions\AiModelAccessException;
use App\Models\Admin;
use App\Models\AiModel;
use App\Models\AiSourceProvider;
use App\Models\SiteSetting;
use App\Services\GeoFlow\AiUsageQuotaService;
use App\Services\GeoFlow\AiVisibility\AiProviderEndpointPolicy;
use App\Services\GeoFlow\AiVisibility\AiVisibilityConfigurationResolver;
use App\Support\GeoFlow\ApiKeyCrypto;
use Illuminate\Auth\Access\AuthorizationException;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Illuminate\Validation\ValidationException;
use RuntimeException;

final class AdminAiSourceProviderService
{
    public function __construct(
        private readonly ApiKeyCrypto $apiKeyCrypto,
        private readonly AiProviderEndpointPolicy $endpointPolicy,
        private readonly AiUsageQuotaService $usageQuota,
        private readonly AdminAiSystemConfigurationBoundaryHook $boundaryHook,
        private readonly AiVisibilityConfigurationResolver $configuration,
    ) {}

    public function activeSuperAdmin(Admin $actor): Admin
    {
        $current = Admin::query()->whereKey($actor->getKey())->active()->first();
        if (! $current instanceof Admin || ! $current->isSuperAdmin()) {
            throw new AuthorizationException('ai_system_config_super_admin_only');
        }

        return $current;
    }

    /** @param array<string, mixed> $payload */
    public function createProvider(Admin $actor, array $payload): AiSourceProvider
    {
        return DB::transaction(function () use ($actor, $payload): AiSourceProvider {
            $this->lockActiveSuperAdmin($actor);
            $attributes = $this->providerAttributes($payload);
            $this->assertSearchEndpoint((string) $attributes['endpoint_url']);
            $apiKey = trim((string) $payload['api_key']);
            if ($apiKey === '') {
                throw ValidationException::withMessages([
                    'api_key' => __('admin.ai_source_providers.error.api_key_required'),
                ]);
            }

            try {
                $encryptedApiKey = $this->apiKeyCrypto->encrypt($apiKey);
            } catch (RuntimeException) {
                throw ValidationException::withMessages(['api_key' => __('admin.ai_source_providers.error.crypto_key_missing')]);
            }

            return AiSourceProvider::query()->create($attributes + [
                'provider_key' => AiSourceProvider::PROVIDER_DOUBAO_SEARCH_CUSTOM,
                'api_key' => $encryptedApiKey,
                'status' => 'active',
            ]);
        }, 3);
    }

    /** @param array<string, mixed> $payload */
    public function updateProvider(Admin $actor, int $providerId, array $payload): AiSourceProvider
    {
        return DB::transaction(function () use ($actor, $providerId, $payload): AiSourceProvider {
            $this->lockActiveSuperAdmin($actor);
            $provider = AiSourceProvider::query()->whereKey($providerId)->lockForUpdate()->firstOrFail();
            $attributes = $this->providerAttributes($payload);
            $attributes['status'] = $this->normalizeStatus((string) ($payload['status'] ?? 'active'));
            $this->assertSearchEndpoint((string) $attributes['endpoint_url']);

            $apiKey = trim((string) ($payload['api_key'] ?? ''));
            if (! $this->endpointPolicy->sameOrigin((string) $provider->endpoint_url, (string) $attributes['endpoint_url'])
                && $apiKey === '') {
                throw ValidationException::withMessages(['api_key' => __('admin.ai_source_providers.error.api_key_required')]);
            }
            if ($apiKey !== '') {
                try {
                    $attributes['api_key'] = $this->apiKeyCrypto->encrypt($apiKey);
                } catch (RuntimeException) {
                    throw ValidationException::withMessages(['api_key' => __('admin.ai_source_providers.error.crypto_key_missing')]);
                }
            }

            $provider->update($attributes);

            return $provider;
        }, 3);
    }

    public function deleteProvider(Admin $actor, int $providerId): void
    {
        DB::transaction(function () use ($actor, $providerId): void {
            $this->lockActiveSuperAdmin($actor);
            $provider = AiSourceProvider::query()->whereKey($providerId)->lockForUpdate()->firstOrFail();
            if (Schema::hasTable('ai_visibility_runs') && $provider->visibilityRuns()->exists()) {
                throw ValidationException::withMessages([
                    'provider' => __('admin.ai_source_providers.error.provider_in_use'),
                ]);
            }

            $provider->delete();
        }, 3);
    }

    /**
     * 当前生效的可见度分析模型绑定：ark / deepseek 各一条。
     *
     * 返回 0 表示「没绑，或者绑的那条模型现在已经不可调用了」——对调用方是同一个动作：
     * 得重绑。**不要**把这两种情况合成一个别的值，调用方没有别的办法区分。
     *
     * @return array{ark:int,deepseek:int}
     */
    public function bindingModelIds(Admin $actor): array
    {
        $lockedActor = $this->activeSuperAdmin($actor);

        return [
            'ark' => $this->callableBindingModelId($lockedActor, 'ark'),
            'deepseek' => $this->callableBindingModelId($lockedActor, 'deepseek'),
        ];
    }

    /**
     * 可以绑定为可见度分析模型的候选：该超管拥有的、可用的系统 chat 模型。
     *
     * @return array<int, array{id:int,name:string,model_id:string}>
     */
    public function bindingModelCandidates(Admin $actor): array
    {
        $lockedActor = $this->activeSuperAdmin($actor);

        return $this->systemModelQuery($lockedActor, 'chat')
            ->select(['id', 'name', 'model_id'])
            ->orderBy('name')
            ->orderByDesc('id')
            ->get()
            ->map(static fn (AiModel $model): array => [
                'id' => (int) $model->getKey(),
                'name' => (string) $model->name,
                'model_id' => (string) $model->model_id,
            ])
            ->all();
    }

    /**
     * 某条绑定的 API 配置；没有绑定或绑定已失效时返回该类型的默认值。
     *
     * **返回值里带 `masked_api_key`**——旧 Blade 页要显示它。api/v1 的投影必须只挑
     * 安全字段（api/v1 对外的口径是「连掩码都不给，只给 api_key_configured」）。
     *
     * `api_key_configured` 是给 api/v1 用的：**不能从掩码反推**——空密钥的掩码是
     * `****`、而「压根没绑模型」的默认掩码是 `-`，两者长得都不像「有没有配 key」。
     *
     * @return array{id:int,name:string,model_id:string,api_url:string,daily_limit:int,max_tokens:?int,masked_api_key:string,api_key_configured:bool}
     */
    public function bindingApiConfig(Admin $actor, string $bindingType): array
    {
        $defaults = $this->defaultBindingApiConfig($bindingType);
        $modelId = $this->callableBindingModelId($this->activeSuperAdmin($actor), $bindingType);
        if ($modelId <= 0 || ! Schema::hasTable('ai_models')) {
            return $defaults;
        }

        $model = AiModel::query()
            ->ownedBy($actor)
            ->systemOnly()
            ->active()
            ->unarchived()
            ->whereKey($modelId)
            ->first();
        if (! $model instanceof AiModel) {
            return $defaults;
        }

        return array_replace($defaults, [
            'id' => (int) $model->id,
            'name' => (string) $model->name,
            'model_id' => (string) ($model->model_id ?? ''),
            'api_url' => (string) ($model->api_url ?? ''),
            'daily_limit' => (int) ($model->daily_limit ?? 0),
            'max_tokens' => Schema::hasColumn('ai_models', 'max_tokens') && $model->max_tokens !== null
                ? (int) $model->max_tokens
                : null,
            'masked_api_key' => $this->apiKeyCrypto->mask((string) ($model->getRawOriginal('api_key') ?? '')),
            'api_key_configured' => trim((string) ($model->getRawOriginal('api_key') ?? '')) !== '',
        ]);
    }

    /** @return array{id:int,name:string,model_id:string,api_url:string,daily_limit:int,max_tokens:?int,masked_api_key:string,api_key_configured:bool} */
    private function defaultBindingApiConfig(string $bindingType): array
    {
        if ($bindingType === 'ark') {
            return [
                'id' => 0,
                'name' => '豆包 Ark Web Search',
                'model_id' => 'doubao-seed-2-0-lite-260428',
                'api_url' => 'https://ark.cn-beijing.volces.com/api/v3',
                'daily_limit' => 0,
                'max_tokens' => null,
                'masked_api_key' => '-',
                'api_key_configured' => false,
            ];
        }

        return [
            'id' => 0,
            'name' => 'DeepSeek 二次分析',
            'model_id' => 'deepseek-v4-flash',
            'api_url' => 'https://api.deepseek.com',
            'daily_limit' => 0,
            'max_tokens' => (int) config('geoflow.ai_visibility.default_analysis_max_tokens', 4096),
            'masked_api_key' => '-',
            'api_key_configured' => false,
        ];
    }

    private function callableBindingModelId(Admin $actor, string $bindingType): int
    {
        $modelId = (int) (SiteSetting::query()
            ->where('setting_key', $this->modelSettingKey($bindingType))
            ->value('setting_value') ?? 0);

        return $modelId > 0 && $this->configuration->isCallableAdminOwnedModelId($modelId, $bindingType, $actor)
            ? $modelId
            : 0;
    }

    public function updateModelBindings(Admin $actor, int $arkModelId, int $deepSeekModelId): void
    {
        DB::transaction(function () use ($actor, $arkModelId, $deepSeekModelId): void {
            $lockedActor = $this->lockActiveSuperAdmin($actor);
            $this->validateBindingModel($lockedActor, $arkModelId, 'ark');
            $this->validateBindingModel($lockedActor, $deepSeekModelId, 'deepseek');
            $this->writeSetting(AiVisibilityConfigurationResolver::ARK_MODEL_SETTING_KEY, $arkModelId);
            $this->writeSetting(AiVisibilityConfigurationResolver::DEEPSEEK_MODEL_SETTING_KEY, $deepSeekModelId);
        }, 3);
    }

    /** @param array<string, mixed> $payload */
    public function upsertModelApi(Admin $actor, array $payload): AiModel
    {
        return DB::transaction(function () use ($actor, $payload): AiModel {
            $lockedActor = $this->lockActiveSuperAdmin($actor);
            $bindingType = (string) $payload['binding_type'];
            if (trim((string) $payload['model_id']) === '') {
                throw ValidationException::withMessages([
                    'model_id' => __('admin.ai_source_providers.error.'.$bindingType.'_model_unavailable'),
                ]);
            }
            $settingKey = $this->modelSettingKey($bindingType);
            $setting = SiteSetting::query()->where('setting_key', $settingKey)->lockForUpdate()->first();
            $modelId = (int) ($setting?->setting_value ?? 0);
            $model = $modelId > 0
                ? $this->systemModelQuery($lockedActor, 'chat')->whereKey($modelId)->lockForUpdate()->first()
                : null;
            if ($modelId > 0 && ! $model instanceof AiModel) {
                throw $this->bindingValidationException($bindingType);
            }

            $apiKey = trim((string) ($payload['api_key'] ?? ''));
            if (! $model instanceof AiModel && $apiKey === '') {
                throw ValidationException::withMessages(['api_key' => __('admin.ai_source_providers.error.api_key_required')]);
            }
            if ($model instanceof AiModel
                && $apiKey === ''
                && trim((string) $model->getRawOriginal('api_key')) === '') {
                throw ValidationException::withMessages(['api_key' => __('admin.ai_source_providers.error.api_key_required')]);
            }
            if (! $this->endpointPolicy->acceptsModelApi($bindingType, (string) $payload['api_url'])) {
                throw $this->bindingValidationException($bindingType);
            }
            if ($model instanceof AiModel
                && ! $this->endpointPolicy->sameOrigin((string) $model->api_url, (string) $payload['api_url'])
                && $apiKey === '') {
                throw ValidationException::withMessages(['api_key' => __('admin.ai_source_providers.error.api_key_required')]);
            }

            $attributes = [
                'name' => trim((string) $payload['name']),
                'version' => $bindingType === 'ark' ? 'Ark Responses API' : 'DeepSeek API',
                'model_id' => trim((string) $payload['model_id']),
                'model_type' => 'chat',
                'api_url' => trim((string) $payload['api_url']),
                'failover_priority' => $bindingType === 'ark' ? 40 : 45,
                'daily_limit' => max(0, (int) ($payload['daily_limit'] ?? 0)),
                'status' => 'active',
                'ai_workspace_structured_output_status' => null,
                'ai_workspace_structured_output_verified_at' => null,
                'ai_workspace_readiness_status' => 'stale',
                'ai_workspace_readiness_profile' => null,
                'ai_workspace_readiness_checked_at' => null,
                'ai_workspace_readiness_expires_at' => null,
                'ai_workspace_readiness_failure_code' => null,
            ];
            if (Schema::hasColumn('ai_models', 'max_tokens')) {
                $attributes['max_tokens'] = $this->normalizeMaxTokens($payload['max_tokens'] ?? null);
            }
            if ($apiKey !== '') {
                try {
                    $attributes['api_key'] = $this->apiKeyCrypto->encrypt($apiKey);
                } catch (RuntimeException) {
                    throw ValidationException::withMessages(['api_key' => __('admin.ai_source_providers.error.crypto_key_missing')]);
                }
            }

            if ($model instanceof AiModel) {
                $model->forceFill($attributes)->save();
            } else {
                $model = new AiModel;
                $model->forceFill($attributes + [
                    'owner_admin_id' => (int) $lockedActor->getKey(),
                    'access_scope' => AiModel::ACCESS_SCOPE_SYSTEM_ONLY,
                ])->save();
            }
            $this->boundaryHook->afterModelMutationBeforeBinding($lockedActor);
            $this->writeSetting($settingKey, (int) $model->getKey());

            return $model;
        }, 3);
    }

    /** @return array<int, array{id:int,name:string,model_id:string,api_url:string,provider_hint:string}> */
    public function modelOptions(Admin $actor, string $bindingType): array
    {
        $current = $this->activeSuperAdmin($actor);
        if (! in_array($bindingType, ['ark', 'deepseek'], true)) {
            return [];
        }

        return $this->systemModelQuery($current, 'chat')
            ->select(['id', 'name', 'model_id', 'api_url', 'api_key'])
            ->orderBy('failover_priority')
            ->orderBy('name')
            ->get()
            ->filter(fn (AiModel $model): bool => trim((string) $model->model_id) !== ''
                && trim((string) $model->getRawOriginal('api_key')) !== ''
                && $this->endpointPolicy->acceptsModelApi(
                    $bindingType,
                    (string) $model->api_url,
                ))
            ->map(fn (AiModel $model): array => [
                'id' => (int) $model->id,
                'name' => (string) $model->name,
                'model_id' => (string) $model->model_id,
                'api_url' => (string) $model->api_url,
                'provider_hint' => $bindingType,
            ])
            ->values()
            ->all();
    }

    public function prepareProviderTest(Admin $actor, int $providerId): AdminAiSourceProviderTestSnapshot
    {
        return DB::transaction(function () use ($actor, $providerId): AdminAiSourceProviderTestSnapshot {
            $lockedActor = $this->lockActiveSuperAdmin($actor);
            $provider = AiSourceProvider::query()->whereKey($providerId)->lockForUpdate()->firstOrFail();
            $this->assertProviderReady($provider);
            $encryptedApiKey = (string) $provider->getRawOriginal('api_key');
            if (trim($this->apiKeyCrypto->decrypt($encryptedApiKey)) === '') {
                throw ValidationException::withMessages([
                    'provider' => __('admin.ai_source_providers.error.provider_inactive'),
                ]);
            }
            $reservation = $this->usageQuota->reserveLockedProviderForTest($provider);
            $provider->refresh();

            return new AdminAiSourceProviderTestSnapshot(
                adminId: (int) $lockedActor->getKey(),
                adminAccessVersion: (int) $lockedActor->ai_config_access_version,
                providerId: (int) $provider->getKey(),
                configurationDigest: $this->providerDigest($provider),
                name: (string) $provider->name,
                providerKey: (string) $provider->provider_key,
                endpointUrl: (string) $provider->endpoint_url,
                status: (string) $provider->status,
                options: $provider->visibilitySearchOptions(),
                reservation: $reservation,
                encryptedApiKey: $encryptedApiKey,
            );
        }, 3);
    }

    public function revalidateProviderBeforeOutbound(AdminAiSourceProviderTestSnapshot $snapshot): void
    {
        $this->revalidateProvider($snapshot);
    }

    public function revalidateProviderAfterOutbound(AdminAiSourceProviderTestSnapshot $snapshot): void
    {
        $this->revalidateProvider($snapshot);
    }

    private function revalidateProvider(AdminAiSourceProviderTestSnapshot $snapshot): void
    {
        DB::transaction(function () use ($snapshot): void {
            $actorReference = new Admin;
            $actorReference->setAttribute($actorReference->getKeyName(), $snapshot->adminId);
            $actorReference->exists = true;
            $actor = Admin::query()->whereKey($snapshot->adminId)->lockForUpdate()->first();
            if (! $actor instanceof Admin
                || (string) $actor->status !== 'active'
                || ! $actor->isSuperAdmin()
                || (int) $actor->ai_config_access_version !== $snapshot->adminAccessVersion) {
                throw AiModelAccessException::configAccessRevoked($actorReference);
            }
            $provider = AiSourceProvider::query()->whereKey($snapshot->providerId)->lockForUpdate()->first();
            if (! $provider instanceof AiSourceProvider
                || ! hash_equals($snapshot->configurationDigest, $this->providerDigest($provider))) {
                throw AiModelAccessException::configAccessRevoked($actor);
            }
        }, 3);
    }

    private function lockActiveSuperAdmin(Admin $actor): Admin
    {
        $locked = Admin::query()->whereKey($actor->getKey())->lockForUpdate()->first();
        if (! $locked instanceof Admin || (string) $locked->status !== 'active' || ! $locked->isSuperAdmin()) {
            throw new AuthorizationException('ai_system_config_super_admin_only');
        }

        return $locked;
    }

    private function validateBindingModel(Admin $actor, int $modelId, string $bindingType): void
    {
        if ($modelId <= 0) {
            return;
        }
        $model = $this->systemModelQuery($actor, 'chat')->whereKey($modelId)->lockForUpdate()->first();
        if (! $model instanceof AiModel
            || ! $this->endpointPolicy->acceptsModelApi($bindingType, (string) $model->api_url)
            || trim((string) $model->model_id) === ''
            || trim((string) $model->getRawOriginal('api_key')) === '') {
            throw $this->bindingValidationException($bindingType);
        }
    }

    private function systemModelQuery(Admin $actor, string $modelType): Builder
    {
        return AiModel::query()
            ->ownedBy($actor)
            ->systemOnly()
            ->active()
            ->unarchived()
            ->where(function (Builder $query) use ($modelType): void {
                if ($modelType === 'chat') {
                    $query->whereNull('model_type')->orWhere('model_type', '')->orWhere('model_type', 'chat');

                    return;
                }
                $query->where('model_type', $modelType);
            });
    }

    private function bindingValidationException(string $bindingType): ValidationException
    {
        $key = $bindingType === 'ark' ? 'ark_model_unavailable' : 'deepseek_model_unavailable';

        return ValidationException::withMessages([
            $bindingType.'_model_id' => __('admin.ai_source_providers.error.'.$key),
        ]);
    }

    /** @param array<string, mixed> $payload @return array<string, mixed> */
    private function providerAttributes(array $payload): array
    {
        return [
            'name' => trim((string) $payload['name']),
            'endpoint_url' => $this->providerEndpoint((string) ($payload['endpoint_url'] ?? '')),
            'daily_limit' => max(0, (int) ($payload['daily_limit'] ?? 0)),
            'metadata_json' => [
                'count' => max(1, min(20, (int) ($payload['count'] ?? config('geoflow.ai_visibility.default_search_count', 10)))),
                'search_type' => (string) ($payload['search_type'] ?? 'web'),
                'need_summary' => (bool) ($payload['need_summary'] ?? false),
                'need_content' => (bool) ($payload['need_content'] ?? false),
                'need_url' => (bool) ($payload['need_url'] ?? true),
                'content_formats' => (string) ($payload['content_formats'] ?? 'Markdown'),
                'auth_info_level' => trim((string) ($payload['auth_info_level'] ?? '')),
                'sites' => $this->parseList((string) ($payload['sites'] ?? '')),
                'block_hosts' => $this->parseList((string) ($payload['block_hosts'] ?? '')),
            ],
        ];
    }

    private function providerEndpoint(string $endpoint): string
    {
        $endpoint = trim($endpoint);

        return $endpoint !== ''
            ? $endpoint
            : (string) config('geoflow.ai_visibility.doubao_search_endpoint', 'https://open.feedcoopapi.com/search_api/web_search');
    }

    private function assertSearchEndpoint(string $endpoint): void
    {
        if (! $this->endpointPolicy->acceptsSearchApi($endpoint)) {
            throw ValidationException::withMessages([
                'endpoint_url' => __('admin.ai_source_providers.error.unsupported_provider'),
            ]);
        }
    }

    private function assertProviderReady(AiSourceProvider $provider): void
    {
        if ((string) $provider->provider_key !== AiSourceProvider::PROVIDER_DOUBAO_SEARCH_CUSTOM
            || (string) $provider->status !== 'active'
            || ! $this->endpointPolicy->acceptsSearchApi((string) $provider->endpoint_url)
            || trim((string) $provider->getRawOriginal('api_key')) === '') {
            throw ValidationException::withMessages([
                'provider' => __('admin.ai_source_providers.error.provider_inactive'),
            ]);
        }
    }

    private function providerDigest(AiSourceProvider $provider): string
    {
        return hash('sha256', json_encode([
            'provider_id' => (int) $provider->getKey(),
            'provider_key' => (string) $provider->provider_key,
            'endpoint_url' => (string) $provider->endpoint_url,
            'status' => (string) $provider->status,
            'api_key_digest' => hash('sha256', (string) $provider->getRawOriginal('api_key')),
            'daily_limit' => (int) $provider->daily_limit,
            'request_options' => $provider->visibilitySearchOptions(),
        ], JSON_THROW_ON_ERROR));
    }

    private function modelSettingKey(string $bindingType): string
    {
        return $bindingType === 'ark'
            ? AiVisibilityConfigurationResolver::ARK_MODEL_SETTING_KEY
            : AiVisibilityConfigurationResolver::DEEPSEEK_MODEL_SETTING_KEY;
    }

    private function writeSetting(string $settingKey, int $modelId): void
    {
        SiteSetting::query()->updateOrCreate(
            ['setting_key' => $settingKey],
            ['setting_value' => (string) max(0, $modelId)],
        );
    }

    private function normalizeMaxTokens(mixed $value): ?int
    {
        $value = (int) $value;

        return $value > 0 ? $value : null;
    }

    private function normalizeStatus(string $status): string
    {
        return in_array($status, ['active', 'inactive'], true) ? $status : 'active';
    }

    /** @return list<string> */
    private function parseList(string $value): array
    {
        $items = preg_split('/[\r\n,]+/u', $value) ?: [];

        return array_values(array_filter(
            array_map(static fn (string $item): string => trim($item), $items),
            static fn (string $item): bool => $item !== '',
        ));
    }
}
