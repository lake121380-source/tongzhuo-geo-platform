<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        if (Schema::hasTable('url_scan_reports')) {
            return;
        }

        Schema::create('url_scan_reports', function (Blueprint $table): void {
            $table->id();
            $table->text('url');
            $table->text('normalized_url');
            $table->string('source_domain', 255)->default('');
            $table->string('status', 20)->default('completed');
            $table->longText('report_json')->nullable();
            $table->text('error_message')->nullable();
            $table->string('error_code', 100)->nullable();
            $table->string('created_by', 100)->default('');
            $table->foreignId('admin_id')->nullable()->constrained('admins')->nullOnDelete();
            $table->timestamp('started_at')->nullable();
            $table->timestamp('finished_at')->nullable();
            $table->timestamps();

            $table->index(['admin_id', 'created_at'], 'url_scan_reports_admin_created_idx');
            $table->index(['source_domain', 'created_at'], 'url_scan_reports_domain_created_idx');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('url_scan_reports');
    }
};
