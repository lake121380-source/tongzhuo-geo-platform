<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * 「见度GEO」检测系统的连接凭据（一企业一部署下的全局单连接，见迁移注释）。
 *
 * **密文列永不进投影**：`$hidden` 是为了兜底——业务代码一律走
 * App\Services\Jiandu\JianduConnectionService 的投影方法，不直接 toArray()。
 */
class JianduConnection extends Model
{
    public const STATUS_ACTIVE = 'active';

    public const STATUS_REVOKED = 'revoked';

    public const STATUS_EXPIRED = 'expired';

    protected $hidden = [
        'access_token_ciphertext',
        'refresh_token_ciphertext',
    ];

    protected $fillable = [
        'account',
        'organization_name',
        'user_name',
        'access_token_ciphertext',
        'refresh_token_ciphertext',
        'access_expires_at',
        'refresh_expires_at',
        'status',
        'connected_by_admin_id',
        'last_refreshed_at',
    ];

    protected function casts(): array
    {
        return [
            'access_expires_at' => 'datetime',
            'refresh_expires_at' => 'datetime',
            'last_refreshed_at' => 'datetime',
        ];
    }

    public function connectedByAdmin(): BelongsTo
    {
        return $this->belongsTo(Admin::class, 'connected_by_admin_id');
    }

    /**
     * 给前端的连接投影：**只有身份与有效期，没有 token**（连密文都不给）。
     *
     * @return array<string, mixed>
     */
    public function projection(): array
    {
        return [
            'id' => $this->id,
            'account' => $this->account,
            'organization_name' => $this->organization_name,
            'user_name' => $this->user_name,
            'status' => $this->status,
            'access_expires_at' => $this->access_expires_at?->toIso8601String(),
            'refresh_expires_at' => $this->refresh_expires_at?->toIso8601String(),
            'last_refreshed_at' => $this->last_refreshed_at?->toIso8601String(),
            'connected_at' => $this->created_at?->toIso8601String(),
        ];
    }
}
