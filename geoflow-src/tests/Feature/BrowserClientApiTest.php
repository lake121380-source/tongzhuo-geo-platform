<?php

namespace Tests\Feature;

use App\Models\Admin;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * api/v1 的浏览器客户端管理（插件的设备授权）。
 *
 * 与 `admin/tokens` 的**个人 API Token 不是一回事**：这些是浏览器插件走设备授权
 * 流程拿到的凭据。判据是 token 的 abilities 里有没有 `browser-operations:read`
 * ——所以「列表里混进普通 API Token」是这条最该防的错。
 *
 * 边界与旧后台一致：普通管理员只看得到、也只能撤销**自己的**客户端；超管看全部。
 */
final class BrowserClientApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_it_lists_browser_clients_and_leaves_regular_api_tokens_out(): void
    {
        $admin = $this->admin('browser_list');
        $admin->createToken('插件配对', ['browser-operations:read', 'browser-operations:execute']);
        $admin->createToken('脚本用', ['articles:read']);

        $items = $this->withToken($this->tokenFor($admin))
            ->getJson('/api/v1/admin/browser-clients')
            ->assertOk()
            ->json('data.items');

        $this->assertCount(1, $items);
        $this->assertSame('插件配对', $items[0]['name']);
    }

    public function test_it_revokes_a_browser_client(): void
    {
        $admin = $this->admin('browser_revoke');
        $client = $admin->createToken('待撤销的插件', ['browser-operations:read']);
        $clientId = (int) $client->accessToken->id;

        $this->withToken($this->tokenFor($admin))
            ->withHeader('X-Idempotency-Key', 'revoke-browser-client')
            ->deleteJson('/api/v1/admin/browser-clients/'.$clientId)
            ->assertOk()
            ->assertJsonPath('data.status', 'revoked')
            ->assertJsonPath('data.token_id', $clientId);

        $this->assertSame(0, $admin->tokens()->whereKey($clientId)->count());
        $this->assertSame(
            [],
            $this->withToken($this->tokenFor($admin))->getJson('/api/v1/admin/browser-clients')->json('data.items'),
        );
    }

    public function test_a_regular_admin_cannot_see_or_revoke_another_admins_client(): void
    {
        $owner = $this->admin('browser_owner');
        $bystander = $this->admin('browser_bystander');
        $clientId = (int) $owner->createToken('别人的插件', ['browser-operations:read'])->accessToken->id;

        $token = $this->tokenFor($bystander);

        $this->assertSame([], $this->withToken($token)->getJson('/api/v1/admin/browser-clients')->json('data.items'));

        // 404 而不是 403：403 会泄露「这个 id 确实存在」。
        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'revoke-foreign-client')
            ->deleteJson('/api/v1/admin/browser-clients/'.$clientId)
            ->assertStatus(404)
            ->assertJsonPath('error.code', 'browser_client_not_found');

        // 真的没被删掉。
        $this->assertSame(1, $owner->tokens()->whereKey($clientId)->count());
    }

    public function test_a_regular_api_token_cannot_be_revoked_through_this_route(): void
    {
        $admin = $this->admin('browser_wrong_kind');
        $regularId = (int) $admin->createToken('普通 token', ['articles:read'])->accessToken->id;

        $this->withToken($this->tokenFor($admin))
            ->withHeader('X-Idempotency-Key', 'revoke-regular-through-browser')
            ->deleteJson('/api/v1/admin/browser-clients/'.$regularId)
            ->assertStatus(404);

        // 走错入口不该误删普通 Token——那会让运营方的脚本突然失效。
        $this->assertSame(1, $admin->tokens()->whereKey($regularId)->count());
    }

    public function test_it_requires_an_idempotency_key(): void
    {
        $admin = $this->admin('browser_idem');
        $clientId = (int) $admin->createToken('幂等用插件', ['browser-operations:read'])->accessToken->id;

        $this->withToken($this->tokenFor($admin))
            ->deleteJson('/api/v1/admin/browser-clients/'.$clientId)
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'idempotency_key_required');

        $this->assertSame(1, $admin->tokens()->whereKey($clientId)->count());
    }

    private function tokenFor(Admin $admin): string
    {
        return $admin->createToken('api', ['account:read', 'account:write'])->plainTextToken;
    }

    private function admin(string $username): Admin
    {
        return Admin::query()->create([
            'username' => $username,
            'password' => 'Password123!',
            'email' => $username.'@example.test',
            'display_name' => $username,
            'role' => 'admin',
            'status' => 'active',
        ]);
    }
}
