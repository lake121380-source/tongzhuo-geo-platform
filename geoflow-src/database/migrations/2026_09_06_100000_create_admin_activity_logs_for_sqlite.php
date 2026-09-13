<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * The PostgreSQL legacy schema already creates this table.  SQLite is used by
 * the isolated PHPUnit API suite, however, and intentionally skips that
 * PostgreSQL-only migration.  Keep the audit projection available there too
 * so account/security API tests exercise the same persistence contract.
 */
return new class extends Migration
{
    public function up(): void
    {
        if (DB::getDriverName() !== 'sqlite' || ! app()->environment('testing')) {
            return;
        }

        if (Schema::hasTable('admin_activity_logs')) {
            return;
        }

        Schema::create('admin_activity_logs', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('admin_id')->nullable()->constrained('admins')->nullOnDelete();
            $table->string('admin_username', 50);
            $table->string('admin_role', 20)->default('admin');
            $table->string('action', 120);
            $table->string('request_method', 10)->default('POST');
            $table->string('page', 255)->default('');
            $table->string('target_type', 50)->default('');
            $table->unsignedBigInteger('target_id')->nullable();
            $table->string('ip_address', 64)->default('');
            $table->text('details')->default('');
            $table->timestamp('created_at')->nullable();

            $table->index(['admin_id', 'created_at']);
            $table->index('created_at');
        });
    }

    public function down(): void
    {
        if (DB::getDriverName() === 'sqlite' && app()->environment('testing')) {
            Schema::dropIfExists('admin_activity_logs');
        }
    }
};
