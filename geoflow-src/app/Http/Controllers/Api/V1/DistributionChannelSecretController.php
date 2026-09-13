<?php

namespace App\Http\Controllers\Api\V1;

use App\Exceptions\ApiException;
use App\Models\Admin;
use App\Models\DistributionChannel;
use App\Services\GeoFlow\DistributionChannelSecretService;
use App\Support\AdminActivityLogger;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Hash;
use RuntimeException;
use Symfony\Component\HttpFoundation\StreamedResponse;
use Throwable;

/**
 * Bearer 版的渠道密钥查看与接入包下载。
 *
 * 门禁与旧 Blade 后台逐条一致：**超级管理员 + 二次密码**。这两件事比轮换密钥更敏感
 * ——它们把已有密钥以明文交出去——所以这里不因为「已经是 Bearer 认证」就放松。
 * 加解密、操作租约与打包全部由 {@see DistributionChannelSecretService} 拥有。
 */
final class DistributionChannelSecretController extends BaseApiController
{
    public function __construct(
        private readonly DistributionChannelSecretService $secrets,
    ) {}

    /** 查看当前启用密钥的明文。 */
    public function reveal(Request $request, int $channel): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $admin = $this->requireSuperAdmin($request);
        $payload = $request->validate(['password' => ['required', 'string']]);
        $this->assertPassword($admin, (string) $payload['password'], 'secret_reveal_password_invalid');

        $row = $this->channelForSecret($channel);

        try {
            $revealed = $this->secrets->revealSecret($row);
        } catch (RuntimeException $exception) {
            throw $this->secretFailure($exception);
        } catch (Throwable $exception) {
            throw $this->deletionBlocked($exception);
        }

        $this->audit($request, $admin, 'api.distribution.channel_secret.revealed', (int) $row->id, [
            'key_id' => $revealed['key_id'],
        ]);

        return $this->success($request, [
            'key_id' => $revealed['key_id'],
            'secret' => $revealed['secret'],
            'endpoint_url' => (string) $row->endpoint_url,
        ]);
    }

    /**
     * 生成并下载渠道接入包（内含 activeSecret）。
     *
     * 用 POST 而不是 GET：密码走请求体，不落进 URL、访问日志或浏览器历史。
     */
    public function package(Request $request, int $channel): StreamedResponse
    {
        $this->requireIdempotencyKey($request);
        $admin = $this->requireSuperAdmin($request);
        $payload = $request->validate(['package_password' => ['required', 'string']]);
        $this->assertPassword($admin, (string) $payload['package_password'], 'package_download_password_invalid');

        $row = $this->channelForSecret($channel);

        try {
            $package = $this->secrets->buildPackage($row);
        } catch (RuntimeException $exception) {
            throw $this->secretFailure($exception);
        } catch (Throwable $exception) {
            throw $this->deletionBlocked($exception);
        }

        $this->audit($request, $admin, 'api.distribution.channel_package.downloaded', (int) $row->id, [
            'filename' => (string) ($package['filename'] ?? ''),
        ]);

        return response()->streamDownload(function () use ($package): void {
            echo file_get_contents($package['path']) ?: '';
            @unlink($package['path']);
        }, (string) $package['filename'], ['Content-Type' => 'application/zip']);
    }

    /** 密钥查看/打包只对 GEOFlow Agent 渠道有意义，且渠道不能处于删除流程中。 */
    private function channelForSecret(int $channel): DistributionChannel
    {
        $row = DistributionChannel::query()->with('activeSecret')->whereKey($channel)->first();
        if (! $row instanceof DistributionChannel) {
            throw new ApiException('distribution_channel_not_found', '分发渠道不存在', 404);
        }
        if ($row->isHostedSite()) {
            throw new ApiException('channel_not_supported', 'Hosted Site 渠道没有可交付的密钥', 422);
        }
        if ((string) $row->status === DistributionChannel::STATUS_DELETING) {
            throw new ApiException('distribution_channel_deleting', '分发渠道正在删除流程中，暂不能查看密钥或下载接入包', 409);
        }
        if (! $row->isGeoFlowAgent()) {
            throw new ApiException('channel_not_supported', '当前渠道类型不支持密钥查看与接入包下载', 422);
        }

        return $row;
    }

    private function requireSuperAdmin(Request $request): Admin
    {
        $admin = $this->executionAdmin($request);
        if (! $admin->isSuperAdmin()) {
            throw new ApiException('forbidden', '只有超级管理员可以查看分发渠道密钥', 403, [
                'required_role' => 'super_admin',
            ]);
        }

        return $admin;
    }

    /** 与旧后台一致：即使已经是超管，也要再验一次本人密码。 */
    private function assertPassword(Admin $admin, string $password, string $code): void
    {
        if (! Hash::check($password, (string) $admin->password)) {
            throw new ApiException($code, '密码不正确', 422);
        }
    }

    private function secretFailure(RuntimeException $exception): ApiException
    {
        return match ($exception->getMessage()) {
            DistributionChannelSecretService::ACTIVE_SECRET_NOT_FOUND => new ApiException('active_secret_not_found', '该渠道当前没有启用中的密钥', 422),
            DistributionChannelSecretService::SECRET_DECRYPT_FAILED => new ApiException('secret_decrypt_failed', '密钥无法解密，请考虑轮换密钥', 422),
            default => new ApiException('secret_operation_failed', '密钥操作失败', 422),
        };
    }

    private function deletionBlocked(Throwable $exception): ApiException
    {
        if (str_contains($exception::class, 'DistributionChannelDeletionBlocked')) {
            return new ApiException('distribution_channel_deleting', '分发渠道正在删除流程中，暂不能执行该操作', 409);
        }

        return new ApiException('secret_operation_failed', '密钥操作失败', 500, ['reason' => $exception->getMessage()]);
    }

    /** @param array<string, mixed> $details */
    private function audit(Request $request, Admin $admin, string $action, int $channelId, array $details = []): void
    {
        AdminActivityLogger::log($admin, $action, [
            'request_method' => $request->method(),
            'page' => 'api/v1/distribution',
            'target_type' => 'distribution_channel',
            'target_id' => $channelId,
            'ip_address' => (string) ($request->ip() ?? ''),
            // 审计只记 key_id 与文件名，绝不记密钥明文。
            'details' => $details,
        ]);
    }

    private function requireIdempotencyKey(Request $request): void
    {
        if (trim((string) $request->header('X-Idempotency-Key')) === '') {
            throw new ApiException('idempotency_key_required', '缺少 X-Idempotency-Key', 422);
        }
    }
}
