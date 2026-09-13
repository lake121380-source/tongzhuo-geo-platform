<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class AdminAiSetting extends Model
{
    /**
     * These attributes are written by the server-side AI settings service.
     * Keeping an explicit allow-list lets migrations/tests create a setting
     * record while still preventing arbitrary request payload fields from
     * being mass-assigned.
     */
    protected $fillable = [
        'admin_id',
        'default_chat_model_id',
        'default_embedding_model_id',
        'updated_by_admin_id',
    ];

    protected function casts(): array
    {
        return [
            'admin_id' => 'integer',
            'default_chat_model_id' => 'integer',
            'default_embedding_model_id' => 'integer',
            'updated_by_admin_id' => 'integer',
        ];
    }

    public function admin(): BelongsTo
    {
        return $this->belongsTo(Admin::class);
    }

    public function defaultChatModel(): BelongsTo
    {
        return $this->belongsTo(AiModel::class, 'default_chat_model_id');
    }

    public function defaultEmbeddingModel(): BelongsTo
    {
        return $this->belongsTo(AiModel::class, 'default_embedding_model_id');
    }

    public function updatedByAdmin(): BelongsTo
    {
        return $this->belongsTo(Admin::class, 'updated_by_admin_id');
    }
}
