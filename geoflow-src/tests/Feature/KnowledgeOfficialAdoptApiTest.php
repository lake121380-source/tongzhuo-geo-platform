<?php

namespace Tests\Feature;

use App\Models\Admin;
use App\Models\KnowledgeBase;
use App\Services\AiWorkspace\SystemKnowledgeBaseManager;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Queue;
use Tests\TestCase;

/**
 * `POST knowledge-bases/{id}/official/adopt` —— 采纳随包发布的官方版本。
 *
 * 这是知识库与事实域唯一「真的没有 API」的一条。**旧的 revisions/restore 替代不了**：
 * 它只在内容哈希恰好等于绑定记录的 `official_content_hash` 时才清 `customized_at`，
 * 不会刷新 `official_version` / `official_content_hash`——所以产品升级后运营方永远
 * 采纳不了新版本，`system_health` 会一直报「有官方更新可用」。
 *
 * 这条锁三件事：① 内容真的被重置为官方版本且绑定记录刷新；② 权限边界（受保护工作流）；
 * ③ 不是系统知识库的要被明确拒绝，而不是悄悄成功。
 */
final class KnowledgeOfficialAdoptApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_it_resets_the_content_to_the_official_version(): void
    {
        Queue::fake();
        $manager = app(SystemKnowledgeBaseManager::class);
        $knowledgeBase = $manager->sync()['knowledge_base'];
        $officialContent = (string) $knowledgeBase->content;
        $admin = $this->admin('adopt_super', 'super_admin');
        $manager->update($knowledgeBase, $admin, [
            'name' => $knowledgeBase->name,
            'description' => $knowledgeBase->description,
            'content' => $officialContent."\n\n## 本地改动\n\n被采纳操作覆盖掉的那一段。\n",
        ]);
        $this->assertNotNull($knowledgeBase->fresh()->systemBinding?->customized_at);

        $this->withToken($this->tokenFor($admin))
            ->withHeader('X-Idempotency-Key', 'adopt-official-1')
            ->postJson('/api/v1/knowledge-bases/'.$knowledgeBase->id.'/official/adopt')
            ->assertOk()
            ->assertJsonPath('data.content_changed', true)
            ->assertJsonPath('data.knowledge_base_id', $knowledgeBase->id);

        $fresh = $knowledgeBase->fresh('systemBinding');
        $this->assertSame($officialContent, (string) $fresh->content);
        // 采纳的真义在这里：绑定记录被刷新，「有官方更新可用」才会消失。
        $this->assertNull($fresh->systemBinding?->customized_at);
        $this->assertNotNull($fresh->systemBinding?->last_synced_at);
    }

    public function test_a_non_system_knowledge_base_is_rejected(): void
    {
        Queue::fake();
        $knowledgeBase = KnowledgeBase::query()->create([
            'name' => '普通知识库',
            'description' => '',
            'content' => '普通内容',
            'file_type' => 'markdown',
        ]);
        $admin = $this->admin('adopt_super_2', 'super_admin');

        $this->withToken($this->tokenFor($admin))
            ->withHeader('X-Idempotency-Key', 'adopt-official-not-system')
            ->postJson('/api/v1/knowledge-bases/'.$knowledgeBase->id.'/official/adopt')
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'system_knowledge_not_bound');
    }

    public function test_a_regular_admin_cannot_adopt_the_official_version(): void
    {
        Queue::fake();
        $manager = app(SystemKnowledgeBaseManager::class);
        $knowledgeBase = $manager->sync()['knowledge_base'];
        $ordinary = $this->admin('adopt_ordinary', 'admin');

        $this->withToken($this->tokenFor($ordinary))
            ->withHeader('X-Idempotency-Key', 'adopt-official-forbidden')
            ->postJson('/api/v1/knowledge-bases/'.$knowledgeBase->id.'/official/adopt')
            ->assertStatus(403)
            ->assertJsonPath('error.code', 'protected_knowledge_read_only');
    }

    public function test_a_replayed_key_does_not_adopt_twice(): void
    {
        Queue::fake();
        $manager = app(SystemKnowledgeBaseManager::class);
        $knowledgeBase = $manager->sync()['knowledge_base'];
        $officialContent = (string) $knowledgeBase->content;
        $admin = $this->admin('adopt_super_3', 'super_admin');
        $manager->update($knowledgeBase, $admin, [
            'name' => $knowledgeBase->name,
            'description' => $knowledgeBase->description,
            'content' => $officialContent.'

## 本地改动
',
        ]);
        $revisionsBefore = $knowledgeBase->revisions()->count();
        $token = $this->tokenFor($admin);

        foreach ([1, 2] as $attempt) {
            $this->withToken($token)
                ->withHeader('X-Idempotency-Key', 'adopt-official-replay')
                ->postJson('/api/v1/knowledge-bases/'.$knowledgeBase->id.'/official/adopt')
                ->assertOk();
        }

        // 回放命中缓存，不会再写一条修订。
        $this->assertSame($revisionsBefore + 1, $knowledgeBase->revisions()->count());
    }

    private function tokenFor(Admin $admin): string
    {
        return $admin->createToken('api', ['materials:read', 'materials:write'])->plainTextToken;
    }

    private function admin(string $username, string $role): Admin
    {
        return Admin::query()->create([
            'username' => $username,
            'password' => 'Password123!',
            'email' => $username.'@example.test',
            'display_name' => $username,
            'role' => $role,
            'status' => 'active',
        ]);
    }
}
