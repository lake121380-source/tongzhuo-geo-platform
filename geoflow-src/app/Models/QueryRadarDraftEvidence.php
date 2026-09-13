<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

final class QueryRadarDraftEvidence extends Model
{
    /**
     * The migration intentionally uses the plural table name. Eloquent's
     * inflector treats "evidence" as an uncountable noun and otherwise
     * guesses the singular `query_radar_draft_evidence` table.
     */
    protected $table = 'query_radar_draft_evidences';

    protected $fillable = [
        'article_id',
        'keyword_id',
        'created_by_admin_id',
        'query',
        'run_ids',
        'evidence_snapshot',
    ];

    protected function casts(): array
    {
        return [
            'article_id' => 'integer',
            'keyword_id' => 'integer',
            'created_by_admin_id' => 'integer',
            'run_ids' => 'array',
            'evidence_snapshot' => 'array',
        ];
    }

    public function article(): BelongsTo
    {
        return $this->belongsTo(Article::class);
    }

    public function keyword(): BelongsTo
    {
        return $this->belongsTo(Keyword::class);
    }

    public function createdBy(): BelongsTo
    {
        return $this->belongsTo(Admin::class, 'created_by_admin_id');
    }
}
