<?php

namespace Tests\Feature;

use App\Models\Admin;
use App\Models\EnterpriseKnowledgeProject;
use App\Models\KnowledgeBase;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

final class KnowledgeAssetApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_knowledge_asset_projection_requires_material_scope_and_exposes_revisions_and_media(): void
    {
        $admin = $this->admin('asset-reader');
        $knowledge = KnowledgeBase::query()->create([
            'name' => '企业资料',
            'description' => '测试资料',
            'content' => "# 产品\n\n企业资料正文",
            'file_type' => 'markdown',
            'character_count' => 10,
            'word_count' => 10,
        ]);
        $token = $admin->createToken('asset-reader', ['materials:read'])->plainTextToken;

        $this->withToken($token)
            ->getJson('/api/v1/knowledge-bases/'.$knowledge->id)
            ->assertOk()
            ->assertJsonPath('data.item.id', $knowledge->id)
            ->assertJsonPath('data.item.name', '企业资料')
            ->assertJsonPath('data.item.is_system_managed', false)
            ->assertJsonPath('data.revisions', [])
            ->assertJsonPath('data.media', []);
    }

    public function test_enterprise_knowledge_listing_is_available_in_the_same_material_scope(): void
    {
        $admin = $this->admin('enterprise-reader');
        $token = $admin->createToken('enterprise-reader', ['materials:read'])->plainTextToken;

        $this->withToken($token)
            ->getJson('/api/v1/enterprise-knowledge')
            ->assertOk()
            ->assertJsonPath('data.items', [])
            ->assertJsonPath('data.pagination.total', 0);
    }

    public function test_enterprise_editor_image_upload_returns_a_durable_markdown_asset(): void
    {
        Storage::fake('public');

        $admin = $this->admin('enterprise-image-writer');
        $project = EnterpriseKnowledgeProject::query()->create([
            'name' => '企业图片项目',
            'status' => 'reviewing',
            'draft_content' => '# 草稿',
            'created_by_admin_id' => (int) $admin->id,
        ]);
        $readToken = $admin->createToken('enterprise-image-read', ['materials:read'])->plainTextToken;

        $this->withToken($readToken)
            ->post('/api/v1/enterprise-knowledge/'.$project->id.'/editor/images/upload', [
                'image' => $this->png('diagram.png'),
            ])
            ->assertStatus(403)
            ->assertJsonPath('error.code', 'forbidden');

        $writeToken = $admin->createToken('enterprise-image-write', ['materials:write'])->plainTextToken;
        $response = $this->withToken($writeToken)
            ->post('/api/v1/enterprise-knowledge/'.$project->id.'/editor/images/upload', [
                'image' => $this->png('diagram.png'),
                'alt' => '产品截图',
            ], [
                'Accept' => 'application/json',
                'X-Idempotency-Key' => 'enterprise-image-upload-1',
            ]);

        $response
            ->assertCreated()
            ->assertJsonPath('data.project_id', $project->id)
            ->assertJsonPath('data.image.alt', '产品截图');

        $payload = $response->json('data.image');
        $this->assertIsArray($payload);
        $this->assertStringContainsString('![产品截图](', (string) ($payload['markdown'] ?? ''));
        $this->assertStringContainsString('/storage/uploads/enterprise-knowledge/'.$project->id.'/', (string) ($payload['url'] ?? ''));
        Storage::disk('public')->assertExists((string) ($payload['storage_path'] ?? ''));
    }

    public function test_enterprise_knowledge_api_requires_write_scope_and_persists_publishable_revisions(): void
    {
        $admin = $this->admin('enterprise-workflow-writer');
        $project = EnterpriseKnowledgeProject::query()->create([
            'name' => '企业知识 API 项目',
            'description' => '产品资料',
            'status' => 'reviewing',
            'draft_content' => '# 初始草稿',
            'created_by_admin_id' => (int) $admin->id,
        ]);
        $content = implode("\n\n", [
            '# 企业介绍', '测试企业。',
            '# 业务信息摘要', '测试业务。',
            '# 产品能力', '测试能力。',
            '# 应用场景', '测试场景。',
            '# 典型案例', '测试案例。',
            '# FAQ', '测试问答。',
            '# 禁用表述', '避免绝对化承诺。',
            '# 风险与冲突', '需人工确认。',
            '# 待人工确认', '资料待补充。',
        ]);
        $readToken = $admin->createToken('enterprise-workflow-read', ['materials:read'])->plainTextToken;

        $this->withToken($readToken)
            ->postJson('/api/v1/enterprise-knowledge/'.$project->id.'/autosave', ['content' => $content])
            ->assertStatus(403)
            ->assertJsonPath('error.code', 'forbidden');

        $writeToken = $admin->createToken('enterprise-workflow-write', ['materials:read', 'materials:write'])->plainTextToken;
        $headers = [
            'Accept' => 'application/json',
            'X-Idempotency-Key' => 'enterprise-autosave-v1',
        ];
        $this->withToken($writeToken)
            ->withHeaders($headers)
            ->postJson('/api/v1/enterprise-knowledge/'.$project->id.'/autosave', ['content' => $content])
            ->assertOk()
            ->assertJsonStructure(['data' => ['saved_at', 'validation_items', 'validation_count']]);
        $this->assertDatabaseCount('enterprise_knowledge_revisions', 1);
        $revisionId = (int) $project->revisions()->value('id');

        $this->withToken($writeToken)
            ->withHeader('X-Idempotency-Key', 'enterprise-publish-v1')
            ->postJson('/api/v1/enterprise-knowledge/'.$project->id.'/publish')
            ->assertOk()
            ->assertJsonPath('data.item.status', 'published');

        $published = $project->fresh();
        $this->assertNotNull($published->published_knowledge_base_id);
        $this->assertDatabaseHas('knowledge_bases', [
            'id' => $published->published_knowledge_base_id,
            'name' => '企业知识 API 项目',
        ]);

        $this->withToken($writeToken)
            ->withHeader('X-Idempotency-Key', 'enterprise-restore-v1')
            ->postJson('/api/v1/enterprise-knowledge/'.$project->id.'/revisions/'.$revisionId.'/restore')
            ->assertOk()
            ->assertJsonPath('data.item.status', 'reviewing')
            ->assertJsonPath('data.item.draft_content', $content);
    }

    private function admin(string $username): Admin
    {
        return Admin::query()->create([
            'username' => $username,
            'password' => 'secret-123',
            'email' => $username.'@example.test',
            'display_name' => $username,
            'role' => 'admin',
            'status' => 'active',
        ]);
    }

    private function png(string $name): UploadedFile
    {
        $bytes = base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', true);

        return UploadedFile::fake()->createWithContent($name, (string) $bytes);
    }
}
