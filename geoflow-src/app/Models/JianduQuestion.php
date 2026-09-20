<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * 一条「见度检测问题」——每日自动检测的口径来源，运营在后台维护。
 */
class JianduQuestion extends Model
{
    protected $fillable = ['question', 'is_active', 'sort_order', 'created_by_admin_id'];

    protected function casts(): array
    {
        return [
            'is_active' => 'boolean',
            'sort_order' => 'integer',
        ];
    }

    public function createdByAdmin(): BelongsTo
    {
        return $this->belongsTo(Admin::class, 'created_by_admin_id');
    }

    /**
     * @return array<string, mixed>
     */
    public function projection(): array
    {
        return [
            'id' => $this->id,
            'question' => $this->question,
            'is_active' => $this->is_active,
            'sort_order' => $this->sort_order,
            'created_at' => $this->created_at?->toIso8601String(),
        ];
    }
}
