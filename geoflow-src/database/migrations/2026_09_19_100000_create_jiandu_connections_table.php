<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * 「见度GEO」检测系统的连接凭据（一企业一部署下的**全局单连接**）。
 *
 * 用途：让运营在桐灼GEO 后台里输入见度账号密码换取服务端会话，后台各页面
 * 用它拉取提及率/检测批次等数据（见 App\Services\Jiandu\*）。
 *
 * token 存**密文**（`ApiKeyCrypto::encrypt` 的 `enc:v1:` 形态，与
 * `ai_models.api_key`、`distribution_channel_secrets.secret_ciphertext` 同一套加密）；
 * 明文只在换取的瞬间存在于内存，落库即密文，模型侧 `$hidden` 兜底，任何投影
 * 都不把密文发给前端。
 *
 * status 语义：`active` = 当前生效；`revoked` = 用户主动断开；`expired` =
 * refresh 也被吊销/过期（如用户在见度侧改了密码），需要重新连接。
 */
return new class extends Migration
{
    public function up(): void
    {
        if (Schema::hasTable('jiandu_connections')) {
            return;
        }

        Schema::create('jiandu_connections', function (Blueprint $table): void {
            $table->id();
            $table->string('account', 190);
            $table->string('organization_name', 190)->default('');
            $table->string('user_name', 190)->default('');
            $table->text('access_token_ciphertext');
            $table->text('refresh_token_ciphertext');
            $table->timestamp('access_expires_at')->nullable();
            $table->timestamp('refresh_expires_at')->nullable();
            $table->string('status', 20)->default('active');
            $table->foreignId('connected_by_admin_id')->nullable()->constrained('admins')->nullOnDelete();
            $table->timestamp('last_refreshed_at')->nullable();
            $table->timestamps();

            $table->index(['status', 'created_at'], 'jiandu_connections_status_created_idx');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('jiandu_connections');
    }
};
