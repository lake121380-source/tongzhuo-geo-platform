<?php

namespace Tests\Feature;

use App\Models\Admin;
use App\Models\KnowledgeBase;
use App\Models\KnowledgeChunk;
use App\Models\KnowledgeFact;
use App\Models\KnowledgeFactLibrary;
use App\Models\SystemKnowledgeBase;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class KnowledgeFactApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_fact_workbench_requires_read_scope_and_paginates_only_the_requested_library(): void
    {
        $admin = $this->admin('fact-api-reader');
        $knowledgeBase = $this->knowledgeBase('Fact API Reader');
        $otherKnowledgeBase = $this->knowledgeBase('Other Fact API Reader');
        $library = KnowledgeFactLibrary::query()->create(['knowledge_base_id' => $knowledgeBase->id]);
        $otherLibrary = KnowledgeFactLibrary::query()->create(['knowledge_base_id' => $otherKnowledgeBase->id]);

        $first = $library->facts()->create($this->factAttributes('company.first', 'First fact'));
        $second = $library->facts()->create($this->factAttributes('company.second', 'Second fact'));
        $library->facts()->create($this->factAttributes('company.third', 'Third fact'));
        $otherLibrary->facts()->create($this->factAttributes('other.hidden', 'Other library fact'));

        $wrongToken = $admin->createToken('facts-wrong-scope', ['materials:write'])->plainTextToken;
        $this->withHeader('Authorization', 'Bearer '.$wrongToken)
            ->getJson($this->factsUrl($knowledgeBase))
            ->assertForbidden()
            ->assertJsonPath('error.code', 'forbidden');

        $readToken = $admin->createToken('facts-read', ['materials:read'])->plainTextToken;
        $this->withHeader('Authorization', 'Bearer '.$readToken)
            ->getJson($this->factsUrl($knowledgeBase).'?page=2&per_page=1')
            ->assertOk()
            ->assertJsonPath('data.knowledge_base.id', (int) $knowledgeBase->id)
            ->assertJsonPath('data.items.0.id', (int) $second->id)
            ->assertJsonPath('data.pagination.page', 2)
            ->assertJsonPath('data.pagination.per_page', 1)
            ->assertJsonPath('data.pagination.total', 3)
            ->assertJsonPath('data.pagination.total_pages', 3)
            ->assertJsonMissing(['label' => 'Other library fact']);

        $this->assertSame((int) $first->id + 1, (int) $second->id);
    }

    public function test_fact_creation_requires_an_idempotency_key_and_replays_without_creating_a_duplicate(): void
    {
        $admin = $this->admin('fact-api-writer');
        $knowledgeBase = $this->knowledgeBase('Fact API Writer');
        $token = $admin->createToken('facts-write', ['materials:read', 'materials:write'])->plainTextToken;
        $payload = $this->factAttributes('company.founded_year', 'Founded year');

        $this->withHeader('Authorization', 'Bearer '.$token)
            ->postJson($this->factsUrl($knowledgeBase), $payload)
            ->assertUnprocessable()
            ->assertJsonPath('error.code', 'idempotency_key_required');
        $this->assertDatabaseCount('knowledge_fact_libraries', 0);

        $headers = [
            'Authorization' => 'Bearer '.$token,
            'X-Idempotency-Key' => 'facts-create-once',
        ];
        $first = $this->withHeaders($headers)
            ->postJson($this->factsUrl($knowledgeBase), $payload)
            ->assertCreated()
            ->assertJsonPath('data.fact.stable_key', 'company.founded_year');
        $factId = (int) $first->json('data.fact.id');

        $this->withHeaders($headers)
            ->postJson($this->factsUrl($knowledgeBase), $payload)
            ->assertCreated()
            ->assertJsonPath('data.fact.id', $factId);

        $this->assertDatabaseCount('knowledge_facts', 1);

        $this->withHeaders($headers)
            ->postJson($this->factsUrl($knowledgeBase), [...$payload, 'label' => 'Changed payload'])
            ->assertConflict()
            ->assertJsonPath('error.code', 'idempotency_conflict');
    }

    public function test_fact_mutations_require_materials_write_scope_before_processing_a_request(): void
    {
        $admin = $this->admin('fact-api-read-only');
        $knowledgeBase = $this->knowledgeBase('Fact API read-only');
        $token = $admin->createToken('facts-read-only', ['materials:read'])->plainTextToken;

        $this->withHeaders($this->headers($token, 'facts-read-only-create'))
            ->postJson($this->factsUrl($knowledgeBase), $this->factAttributes('company.read_only', 'Read-only fact'))
            ->assertForbidden()
            ->assertJsonPath('error.code', 'forbidden');

        $this->assertDatabaseCount('knowledge_facts', 0);
    }

    public function test_evidence_is_derived_from_a_chunk_in_the_same_knowledge_base(): void
    {
        $admin = $this->admin('fact-api-evidence');
        $knowledgeBase = $this->knowledgeBase('Evidence API');
        $otherKnowledgeBase = $this->knowledgeBase('Other evidence API');
        $token = $admin->createToken('facts-evidence', ['materials:read', 'materials:write'])->plainTextToken;

        $fact = $this->createFactViaApi($knowledgeBase, $token, 'company.patent_count', 'Patent count');
        $valueResponse = $this->withHeaders($this->headers($token, 'facts-create-value'))
            ->postJson($this->factsUrl($knowledgeBase).'/'.$fact->id.'/values', [
                'canonical_value_json' => ['value' => '128', 'unit' => 'items'],
                'canonical_answer' => 'The company has 128 patents.',
            ])
            ->assertCreated();
        $valueId = (int) $valueResponse->json('data.value.id');

        $foreignChunk = $this->chunk($otherKnowledgeBase, 'Foreign source content.', 'foreign-section');
        $this->withHeaders($this->headers($token, 'facts-foreign-evidence'))
            ->postJson($this->factValueUrl($knowledgeBase, $valueId).'/evidences', [
                'knowledge_chunk_id' => $foreignChunk->id,
                'excerpt' => 'Client supplied excerpt must be ignored.',
            ])
            ->assertUnprocessable()
            ->assertJsonPath('error.code', 'validation_failed');
        $this->assertDatabaseCount('knowledge_fact_evidences', 0);

        $chunk = $this->chunk($knowledgeBase, 'Trusted source states there are 128 patents.', 'trusted-section');
        $this->withHeaders($this->headers($token, 'facts-own-evidence'))
            ->postJson($this->factValueUrl($knowledgeBase, $valueId).'/evidences', [
                'knowledge_chunk_id' => $chunk->id,
                'is_primary' => true,
                'source_locator_json' => ['section_path' => 'spoofed-section'],
                'excerpt' => 'Client supplied excerpt must be ignored.',
            ])
            ->assertCreated()
            ->assertJsonPath('data.evidence.knowledge_chunk_id', (int) $chunk->id)
            ->assertJsonPath('data.evidence.source_hash', (string) $chunk->source_hash)
            ->assertJsonPath('data.evidence.content_hash', (string) $chunk->content_hash)
            ->assertJsonPath('data.evidence.source_locator.section_path', 'trusted-section')
            ->assertJsonPath('data.evidence.excerpt', 'Trusted source states there are 128 patents.')
            ->assertJsonPath('data.evidence.is_primary', true);
    }

    public function test_publish_and_restore_keep_immutable_fact_revisions(): void
    {
        $admin = $this->admin('fact-api-publisher', 'super_admin');
        $sourceHash = str_repeat('a', 64);
        $knowledgeBase = $this->knowledgeBase('Publish API', [
            'chunk_sync_status' => 'ready',
            'chunk_source_hash' => $sourceHash,
            'chunk_serving_source_hash' => $sourceHash,
        ]);
        $chunk = $this->chunk($knowledgeBase, 'The company was founded in 2020.', 'history', $sourceHash);
        $library = KnowledgeFactLibrary::query()->create(['knowledge_base_id' => $knowledgeBase->id]);
        $fact = $library->facts()->create([
            ...$this->factAttributes('company.founded_year', 'Founded year'),
            'review_status' => 'reviewed',
            'created_by_admin_id' => $admin->id,
            'updated_by_admin_id' => $admin->id,
        ]);
        $value = $fact->values()->create([
            'canonical_value_json' => ['value' => '2020', 'unit' => null],
            'canonical_answer' => 'The company was founded in 2020.',
            'scope_json' => [],
            'scope_hash' => hash('sha256', '[]'),
            'review_status' => 'reviewed',
            'created_by_admin_id' => $admin->id,
            'updated_by_admin_id' => $admin->id,
        ]);
        $value->evidences()->create([
            'knowledge_chunk_id' => $chunk->id,
            'source_hash' => $sourceHash,
            'content_hash' => $chunk->content_hash,
            'source_locator_json' => ['section_path' => 'history'],
            'excerpt' => (string) $chunk->content,
            'excerpt_hash' => hash('sha256', (string) $chunk->content),
            'is_primary' => true,
            'created_by_admin_id' => $admin->id,
        ]);
        $token = $admin->createToken('facts-publish', ['materials:read', 'materials:write'])->plainTextToken;

        $first = $this->withHeaders($this->headers($token, 'facts-publish-v1'))
            ->postJson($this->factsUrl($knowledgeBase).'/publish')
            ->assertOk()
            ->assertJsonPath('data.revision.version', 1)
            ->assertJsonPath('data.revision.manifest.facts.0.label', 'Founded year');
        $firstRevisionId = (int) $first->json('data.revision.id');

        $this->withHeaders($this->headers($token, 'facts-update-v2'))
            ->patchJson($this->factsUrl($knowledgeBase).'/'.$fact->id, [
                'lock_version' => 1,
                'label' => 'Company founding year',
            ])
            ->assertOk()
            ->assertJsonPath('data.fact.review_status', 'draft')
            ->assertJsonPath('data.fact.lock_version', 2);

        $this->withHeaders($this->headers($token, 'facts-review-v2'))
            ->postJson($this->factsUrl($knowledgeBase).'/'.$fact->id.'/review', [
                'lock_version' => 2,
                'review_status' => 'reviewed',
            ])
            ->assertOk()
            ->assertJsonPath('data.fact.review_status', 'reviewed')
            ->assertJsonPath('data.fact.lock_version', 3);

        $this->withHeaders($this->headers($token, 'facts-publish-v2'))
            ->postJson($this->factsUrl($knowledgeBase).'/publish')
            ->assertOk()
            ->assertJsonPath('data.revision.version', 2)
            ->assertJsonPath('data.revision.manifest.facts.0.label', 'Company founding year');

        $this->withHeaders($this->headers($token, 'facts-restore-v1'))
            ->postJson($this->factRevisionUrl($knowledgeBase, $firstRevisionId).'/restore')
            ->assertOk()
            ->assertJsonPath('data.revision.version', 3)
            ->assertJsonPath('data.revision.restored_from_revision_id', $firstRevisionId)
            ->assertJsonPath('data.revision.manifest.facts.0.label', 'Founded year');
    }

    public function test_standard_admin_cannot_mutate_a_system_managed_knowledge_base(): void
    {
        $admin = $this->admin('fact-api-protected');
        $knowledgeBase = $this->knowledgeBase('Protected fact API');
        SystemKnowledgeBase::query()->create([
            'system_key' => 'protected-fact-api',
            'knowledge_base_id' => $knowledgeBase->id,
            'official_version' => 'v1',
            'official_content_hash' => str_repeat('b', 64),
        ]);
        $token = $admin->createToken('facts-protected', ['materials:write'])->plainTextToken;

        $this->withHeaders($this->headers($token, 'facts-protected-write'))
            ->postJson($this->factsUrl($knowledgeBase), $this->factAttributes('company.protected', 'Protected fact'))
            ->assertForbidden()
            ->assertJsonPath('error.code', 'protected_knowledge_read_only');
    }

    private function admin(string $username, string $role = 'admin'): Admin
    {
        return Admin::query()->create([
            'username' => $username,
            'password' => 'password',
            'email' => $username.'@example.test',
            'display_name' => $username,
            'role' => $role,
            'status' => 'active',
        ]);
    }

    /** @param array<string, mixed> $overrides */
    private function knowledgeBase(string $name, array $overrides = []): KnowledgeBase
    {
        return KnowledgeBase::query()->create(array_merge([
            'name' => $name,
            'content' => 'Knowledge base source content.',
            'file_type' => 'markdown',
            'character_count' => 30,
            'word_count' => 5,
        ], $overrides));
    }

    /** @param array<string, mixed> $overrides */
    private function chunk(KnowledgeBase $knowledgeBase, string $content, string $sectionPath, ?string $sourceHash = null, array $overrides = []): KnowledgeChunk
    {
        $sourceHash ??= hash('sha256', $knowledgeBase->id.'|'.$content);

        return KnowledgeChunk::query()->create(array_merge([
            'knowledge_base_id' => $knowledgeBase->id,
            'chunk_index' => 0,
            'content' => $content,
            'content_hash' => hash('sha256', $content),
            'source_hash' => $sourceHash,
            'section_path' => $sectionPath,
        ], $overrides));
    }

    /** @return array<string, mixed> */
    private function factAttributes(string $stableKey, string $label): array
    {
        return [
            'stable_key' => $stableKey,
            'label' => $label,
            'subject' => 'Example Company',
            'predicate' => 'has value',
            'value_type' => 'integer',
        ];
    }

    private function createFactViaApi(KnowledgeBase $knowledgeBase, string $token, string $stableKey, string $label): KnowledgeFact
    {
        $response = $this->withHeaders($this->headers($token, 'facts-create-'.$stableKey))
            ->postJson($this->factsUrl($knowledgeBase), $this->factAttributes($stableKey, $label))
            ->assertCreated();

        return KnowledgeFact::query()->findOrFail((int) $response->json('data.fact.id'));
    }

    private function factsUrl(KnowledgeBase $knowledgeBase): string
    {
        return '/api/v1/materials/knowledge-bases/'.$knowledgeBase->id.'/facts';
    }

    private function factValueUrl(KnowledgeBase $knowledgeBase, int $valueId): string
    {
        return '/api/v1/materials/knowledge-bases/'.$knowledgeBase->id.'/fact-values/'.$valueId;
    }

    private function factRevisionUrl(KnowledgeBase $knowledgeBase, int $revisionId): string
    {
        return '/api/v1/materials/knowledge-bases/'.$knowledgeBase->id.'/fact-revisions/'.$revisionId;
    }

    /** @return array<string, string> */
    private function headers(string $token, string $idempotencyKey): array
    {
        return [
            'Authorization' => 'Bearer '.$token,
            'X-Idempotency-Key' => $idempotencyKey,
        ];
    }
}
