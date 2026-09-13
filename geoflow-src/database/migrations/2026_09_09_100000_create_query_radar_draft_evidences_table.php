<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        if (Schema::hasTable('query_radar_draft_evidences')) {
            return;
        }

        Schema::create('query_radar_draft_evidences', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('article_id')->unique()->constrained('articles')->cascadeOnDelete();
            $table->foreignId('keyword_id')->nullable()->constrained('keywords')->nullOnDelete();
            $table->foreignId('created_by_admin_id')->nullable()->constrained('admins')->nullOnDelete();
            $table->string('query', 255);
            $table->json('run_ids');
            $table->json('evidence_snapshot');
            $table->timestamps();

            $table->index(['keyword_id', 'created_at'], 'query_radar_evidence_keyword_created_idx');
            $table->index(['query', 'created_at'], 'query_radar_evidence_query_created_idx');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('query_radar_draft_evidences');
    }
};
