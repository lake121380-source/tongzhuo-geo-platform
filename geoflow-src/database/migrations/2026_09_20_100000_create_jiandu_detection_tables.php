<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * 见度「每日自动检测」的两张配置表：
 *
 *  · `jiandu_questions` —— 运营在后台维护的检测问题集（检测口径的来源）；
 *  · `jiandu_detection_settings` —— 单行设置：每日开关、平台入口集、目标项目、
 *    最近一次运行的结论。
 *
 * 检测本身仍在见度侧执行（建任务、出报告）；这里只存「要跑什么」，
 * 展示层实时拉取见度数据（见 JianduVisibilityService）。
 */
return new class extends Migration
{
    public function up(): void
    {
        if (! Schema::hasTable('jiandu_questions')) {
            Schema::create('jiandu_questions', function (Blueprint $table): void {
                $table->id();
                $table->text('question');
                $table->boolean('is_active')->default(true);
                $table->integer('sort_order')->default(0);
                $table->foreignId('created_by_admin_id')->nullable()->constrained('admins')->nullOnDelete();
                $table->timestamps();

                $table->index(['is_active', 'sort_order'], 'jiandu_questions_active_sort_idx');
            });
        }

        if (! Schema::hasTable('jiandu_detection_settings')) {
            Schema::create('jiandu_detection_settings', function (Blueprint $table): void {
                $table->id();
                $table->boolean('enabled')->default(true);
                $table->text('platforms_json')->default('["deepseek","qianwen"]');
                $table->string('project_id', 120)->nullable();
                $table->string('project_name', 190)->nullable();
                $table->timestamp('last_run_at')->nullable();
                $table->string('last_run_status', 190)->nullable();
                $table->timestamps();
            });
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('jiandu_questions');
        Schema::dropIfExists('jiandu_detection_settings');
    }
};
