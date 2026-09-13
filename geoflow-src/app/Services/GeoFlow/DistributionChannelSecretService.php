<?php

namespace App\Services\GeoFlow;

use App\Http\Controllers\Admin\DistributionController;
use App\Http\Controllers\Api\V1\DistributionChannelSecretController;
use App\Models\DistributionChannel;
use App\Support\GeoFlow\ApiKeyCrypto;
use RuntimeException;

/**
 * 渠道密钥的「查看」与「交付」。
 *
 * 旧 Blade 后台（{@see DistributionController}）与
 * api/v1（{@see DistributionChannelSecretController}）
 * 共用这一份实现。两者都在各自入口做**超管 + 二次密码**校验后才调用这里——
 * 这两件事比轮换密钥更敏感（把已有密钥明文交出去），门禁不放松。
 */
final class DistributionChannelSecretService
{
    /** 渠道没有处于启用状态的密钥。 */
    public const ACTIVE_SECRET_NOT_FOUND = 'distribution_active_secret_not_found';

    /** 密钥无法解密（密文损坏或密钥轮换过）。 */
    public const SECRET_DECRYPT_FAILED = 'distribution_secret_decrypt_failed';

    public function __construct(
        private readonly ApiKeyCrypto $apiKeyCrypto,
        private readonly DistributionTargetSitePackageBuilder $targetSitePackageBuilder,
        private readonly DistributionChannelOperationLeaseService $channelOperationLeaseService,
    ) {}

    /**
     * 读取当前启用密钥的明文。
     *
     * @return array{key_id:string,secret:string}
     */
    public function revealSecret(DistributionChannel $channel): array
    {
        return $this->channelOperationLeaseService->run(
            $channel,
            'secret_reveal',
            function (DistributionChannel $lockedChannel): array {
                [$keyId, $plainSecret] = $this->decryptActiveSecret($lockedChannel);

                return ['key_id' => $keyId, 'secret' => $plainSecret];
            },
        );
    }

    /**
     * 生成渠道接入包（含 activeSecret），返回临时文件路径与建议文件名。
     * 调用方负责发送后删除临时文件。
     *
     * @return array{path:string,filename:string}
     */
    public function buildPackage(DistributionChannel $channel): array
    {
        return $this->channelOperationLeaseService->run(
            $channel,
            'package_build',
            function (DistributionChannel $lockedChannel): array {
                [$keyId, $plainSecret] = $this->decryptActiveSecret($lockedChannel);

                return $this->targetSitePackageBuilder->build($lockedChannel, $keyId, $plainSecret);
            },
        );
    }

    /** @return array{0:string,1:string} [key_id, plain secret] */
    private function decryptActiveSecret(DistributionChannel $channel): array
    {
        $channel->load('activeSecret');
        $secret = $channel->activeSecret;
        if (! $secret) {
            throw new RuntimeException(self::ACTIVE_SECRET_NOT_FOUND);
        }

        $plainSecret = $this->apiKeyCrypto->decrypt((string) $secret->secret_ciphertext);
        if ($plainSecret === '') {
            throw new RuntimeException(self::SECRET_DECRYPT_FAILED);
        }

        return [(string) $secret->key_id, $plainSecret];
    }
}
