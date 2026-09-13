<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * `route_name` → `tab_path`。
 *
 * 2026-09-12 旧 Blade 后台退役：这些媒体截图原本指向 `admin.*` 的 Laravel 路由名
 * （`admin.tasks.create` 这类），旧后台删除后改为指向 React 后台的页签深链
 * （`/geo_admin?tab=tasks`）。**列里装的已经不是路由名了**，沿用旧列名会让下一个人
 * 继续把它当路由名去解析——退役过程中正是一次这样的半改名让 AI 助手的检索退化了。
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('knowledge_media_assets', function (Blueprint $table): void {
            $table->renameColumn('route_name', 'tab_path');
        });
    }

    public function down(): void
    {
        Schema::table('knowledge_media_assets', function (Blueprint $table): void {
            $table->renameColumn('tab_path', 'route_name');
        });
    }
};
