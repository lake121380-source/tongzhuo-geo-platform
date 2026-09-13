<?php

namespace Tests\Feature;

use App\Models\Admin;
use App\Models\KnowledgeBase;
use App\Services\GeoFlow\KnowledgeRetrievalService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Mockery;
use Tests\TestCase;

class KnowledgeSearchApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_search_requires_materials_read_scope(): void
    {
        $admin = $this->admin('knowledge_scope_admin');
        $knowledge = $this->knowledgeBase();
        $token = $admin->createToken('wrong-scope', ['materials:write'])->plainTextToken;

        $this->withHeader('Authorization', 'Bearer '.$token)
            ->getJson("/api/v1/materials/knowledge-bases/{$knowledge->id}/search?query=GEO")
            ->assertForbidden()
            ->assertJsonPath('error.code', 'forbidden');
    }

    public function test_search_validates_query_before_running_retrieval(): void
    {
        $admin = $this->admin('knowledge_validation_admin');
        $knowledge = $this->knowledgeBase();
        $token = $admin->createToken('reader', ['materials:read'])->plainTextToken;

        $this->withHeader('Authorization', 'Bearer '.$token)
            ->getJson("/api/v1/materials/knowledge-bases/{$knowledge->id}/search")
            ->assertUnprocessable()
            ->assertJsonPath('error.code', 'validation_failed')
            ->assertJsonPath('error.details.field_errors.query', '检索问题不能为空');
    }

    public function test_search_returns_traceable_evidence_without_fabricated_scores(): void
    {
        $admin = $this->admin('knowledge_reader_admin');
        $knowledge = $this->knowledgeBase();
        $token = $admin->createToken('reader', ['materials:read'])->plainTextToken;

        $service = Mockery::mock(KnowledgeRetrievalService::class);
        $service->shouldReceive('retrieveEvidence')->once()->andReturn([[
            'chunk_id' => 31,
            'chunk_index' => 2,
            'generation_key' => 'generation-1',
            'chunk_title' => '服务范围',
            'section_path' => '产品 / GEO 服务',
            'content' => str_repeat('所有结论都应能回溯到企业资料。', 30),
            'content_hash' => 'hash-31',
            'source_hash' => 'source-hash-31',
            'score' => 0.73123456,
            'vector_score' => 0.8,
            'keyword_score' => 0.54,
            'metadata' => [
                'source_name' => '服务手册',
                'source_url' => 'https://example.test/handbook',
                'effective_date' => '2026-09-01',
                'review_status' => 'reviewed',
            ],
            'retrieval_meta' => [
                'embedding_mode' => 'keyword_fallback',
                'reason' => 'index_has_no_real_embedding',
            ],
        ]]);
        $this->app->instance(KnowledgeRetrievalService::class, $service);

        $response = $this->withHeader('Authorization', 'Bearer '.$token)
            ->getJson("/api/v1/materials/knowledge-bases/{$knowledge->id}/search?query=企业资料&limit=4&max_chars=256")
            ->assertOk()
            ->assertJsonPath('data.knowledge_base.id', (int) $knowledge->id)
            ->assertJsonPath('data.query', '企业资料')
            ->assertJsonPath('data.allow_remote_embedding', false)
            ->assertJsonPath('data.max_chars', 256)
            ->assertJsonPath('data.retrieval.embedding_mode', 'keyword_fallback')
            ->assertJsonPath('data.items.0.chunk_id', 31)
            ->assertJsonPath('data.items.0.generation_key', 'generation-1')
            ->assertJsonPath('data.items.0.source_hash', 'source-hash-31')
            ->assertJsonPath('data.items.0.score', 0.731235)
            ->assertJsonPath('data.items.0.source.name', '服务手册')
            ->assertJsonPath('data.items.0.retrieval.embedding_mode', 'keyword_fallback')
            ->assertJsonPath('data.items.0.content_truncated', true);

        $this->assertLessThanOrEqual(
            256,
            mb_strlen((string) $response->json('data.items.0.content'), 'UTF-8')
        );
    }

    public function test_search_rejects_stale_expected_generation_before_retrieval(): void
    {
        $admin = $this->admin('knowledge_generation_admin');
        $knowledge = $this->knowledgeBase(['chunk_serving_generation' => 'generation-current']);
        $token = $admin->createToken('reader', ['materials:read'])->plainTextToken;

        $service = Mockery::mock(KnowledgeRetrievalService::class);
        $service->shouldReceive('retrieveEvidence')->never();
        $this->app->instance(KnowledgeRetrievalService::class, $service);

        $this->withHeader('Authorization', 'Bearer '.$token)
            ->getJson("/api/v1/materials/knowledge-bases/{$knowledge->id}/search?query=GEO&expected_generation=generation-old")
            ->assertConflict()
            ->assertJsonPath('error.code', 'knowledge_generation_conflict')
            ->assertJsonPath('error.details.expected_generation', 'generation-old')
            ->assertJsonPath('error.details.serving_generation', 'generation-current');
    }

    public function test_search_can_explicitly_enable_remote_embedding(): void
    {
        $admin = $this->admin('knowledge_remote_embedding_admin');
        $knowledge = $this->knowledgeBase();
        $token = $admin->createToken('reader', ['materials:read'])->plainTextToken;

        $service = Mockery::mock(KnowledgeRetrievalService::class);
        $service->shouldReceive('retrieveEvidence')->once()->andReturn([]);
        $this->app->instance(KnowledgeRetrievalService::class, $service);

        $this->withHeader('Authorization', 'Bearer '.$token)
            ->getJson("/api/v1/materials/knowledge-bases/{$knowledge->id}/search?query=GEO&allow_remote_embedding=true")
            ->assertOk()
            ->assertJsonPath('data.allow_remote_embedding', true)
            ->assertJsonPath('data.retrieval.embedding_mode', 'keyword_fallback')
            ->assertJsonPath('data.retrieval.reason', 'no_evidence');
    }

    public function test_search_rejects_generation_changed_during_retrieval(): void
    {
        $admin = $this->admin('knowledge_generation_race_admin');
        $knowledge = $this->knowledgeBase(['chunk_serving_generation' => 'generation-current']);
        $token = $admin->createToken('reader', ['materials:read'])->plainTextToken;

        $service = Mockery::mock(KnowledgeRetrievalService::class);
        $service->shouldReceive('retrieveEvidence')
            ->once()
            ->andReturnUsing(function () use ($knowledge): array {
                $knowledge->forceFill(['chunk_serving_generation' => 'generation-next'])->save();

                return [];
            });
        $this->app->instance(KnowledgeRetrievalService::class, $service);

        $this->withHeader('Authorization', 'Bearer '.$token)
            ->getJson("/api/v1/materials/knowledge-bases/{$knowledge->id}/search?query=GEO&expected_generation=generation-current")
            ->assertConflict()
            ->assertJsonPath('error.code', 'knowledge_generation_conflict')
            ->assertJsonPath('error.details.expected_generation', 'generation-current')
            ->assertJsonPath('error.details.serving_generation', 'generation-next');
    }

    public function test_search_rejects_an_unbounded_context_budget(): void
    {
        $admin = $this->admin('knowledge_budget_admin');
        $knowledge = $this->knowledgeBase();
        $token = $admin->createToken('reader', ['materials:read'])->plainTextToken;

        $this->withHeader('Authorization', 'Bearer '.$token)
            ->getJson("/api/v1/materials/knowledge-bases/{$knowledge->id}/search?query=GEO&max_chars=20001")
            ->assertUnprocessable()
            ->assertJsonPath('error.code', 'validation_failed')
            ->assertJsonPath('error.details.field_errors.max_chars', 'max_chars 必须在 256-20000 之间');
    }

    private function admin(string $username): Admin
    {
        return Admin::query()->create([
            'username' => $username,
            'password' => 'password',
            'email' => $username.'@example.test',
            'display_name' => 'Knowledge API Test',
            'role' => 'admin',
            'status' => 'active',
        ]);
    }

    private function knowledgeBase(array $overrides = []): KnowledgeBase
    {
        return KnowledgeBase::query()->create(array_merge([
            'name' => 'Knowledge API Test',
            'description' => '',
            'content' => '可信企业资料。',
            'file_type' => 'markdown',
            'character_count' => 7,
            'word_count' => 7,
        ], $overrides));
    }
}
