<?php

namespace Tests\Feature;

use App\Models\Admin;
use App\Models\UrlScanReport;
use App\Services\GeoFlow\UrlScannerService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

final class UrlScannerApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_scan_is_persisted_and_idempotent(): void
    {
        $admin = $this->admin('url-scanner-owner');
        $this->mock(UrlScannerService::class, function ($mock): void {
            $mock->shouldReceive('scan')->once()->with('https://example.test/page')->andReturn($this->report());
        });
        $token = $admin->createToken('url-scanner-token', ['materials:read', 'materials:write'])->plainTextToken;
        $headers = ['Authorization' => 'Bearer '.$token, 'X-Idempotency-Key' => 'url-scan-create-1'];

        $first = $this->withHeaders($headers)->postJson('/api/v1/url-scans', ['url' => 'https://example.test/page'])
            ->assertCreated()->assertJsonPath('data.scan.status', 'completed')
            ->assertJsonPath('data.scan.report.overall_score', 88);
        $second = $this->withHeaders($headers)->postJson('/api/v1/url-scans', ['url' => 'https://example.test/page'])
            ->assertCreated()->assertJsonPath('data.scan.id', $first->json('data.scan.id'));

        $this->assertDatabaseCount('url_scan_reports', 1);
        $this->assertDatabaseHas('url_scan_reports', ['status' => 'completed', 'source_domain' => 'example.test']);
        $this->assertSame($first->json('data.scan.id'), $second->json('data.scan.id'));
    }

    public function test_scan_requires_write_scope_and_idempotency_key(): void
    {
        $admin = $this->admin('url-scanner-scope');
        $token = $admin->createToken('url-scanner-read-token', ['materials:read'])->plainTextToken;
        $this->withToken($token)->postJson('/api/v1/url-scans', ['url' => 'https://example.test/page'])
            ->assertForbidden()->assertJsonPath('error.details.required_scope', 'materials:write');

        $write = $admin->createToken('url-scanner-write-token', ['materials:write'])->plainTextToken;
        $this->withToken($write)->postJson('/api/v1/url-scans', ['url' => 'https://example.test/page'])
            ->assertStatus(422)->assertJsonPath('error.code', 'idempotency_key_required');
    }

    public function test_invalid_url_is_reported_without_leaking_transport_details(): void
    {
        $admin = $this->admin('url-scanner-invalid');
        $this->mock(UrlScannerService::class, function ($mock): void {
            $mock->shouldReceive('scan')->once()->andThrow(new \InvalidArgumentException('URL 包含内部地址'));
        });
        $token = $admin->createToken('url-scanner-invalid-token', ['materials:read', 'materials:write'])->plainTextToken;
        $response = $this->withHeaders(['Authorization' => 'Bearer '.$token, 'X-Idempotency-Key' => 'url-scan-invalid-1'])
            ->postJson('/api/v1/url-scans', ['url' => 'http://127.0.0.1/private'])
            ->assertStatus(422)->assertJsonPath('error.code', 'invalid_url');

        $this->assertStringNotContainsString('password', $response->getContent());
        $this->assertDatabaseHas('url_scan_reports', ['status' => 'failed', 'error_code' => 'invalid_url']);
    }

    public function test_owner_boundary_and_markdown_export(): void
    {
        $owner = $this->admin('url-scanner-export-owner');
        $peer = $this->admin('url-scanner-export-peer');
        $scan = UrlScanReport::query()->create([
            'url' => 'https://example.test/page', 'normalized_url' => 'https://example.test/page', 'source_domain' => 'example.test',
            'status' => 'completed', 'report_json' => json_encode($this->report()), 'created_by' => $owner->username, 'admin_id' => $owner->id,
            'started_at' => now(), 'finished_at' => now(),
        ]);
        $ownerToken = $owner->createToken('url-scanner-export-owner-token', ['materials:read'])->plainTextToken;
        $peerToken = $peer->createToken('url-scanner-export-peer-token', ['materials:read'])->plainTextToken;

        $this->withToken($peerToken)->getJson('/api/v1/url-scans/'.$scan->id)->assertNotFound();
        $this->withToken($ownerToken)->getJson('/api/v1/url-scans/'.$scan->id)
            ->assertOk()->assertJsonPath('data.scan.report.robots_txt_status.gpt_bot_allowed', true);
        $this->withToken($ownerToken)->get('/api/v1/url-scans/'.$scan->id.'/export')
            ->assertOk()->assertHeader('content-type', 'text/markdown; charset=UTF-8');
    }

    public function test_failed_scan_is_recorded_and_can_be_retried(): void
    {
        $admin = $this->admin('url-scanner-retry');
        $this->mock(UrlScannerService::class, function ($mock): void {
            $mock->shouldReceive('scan')->twice()->andReturnUsing(function (): array {
                static $attempt = 0;
                $attempt++;
                if ($attempt === 1) {
                    throw new \RuntimeException('network failure');
                }

                return $this->report();
            });
        });
        $token = $admin->createToken('url-scanner-retry-token', ['materials:read', 'materials:write'])->plainTextToken;
        $first = $this->withHeaders(['Authorization' => 'Bearer '.$token, 'X-Idempotency-Key' => 'url-scan-fail-1'])
            ->postJson('/api/v1/url-scans', ['url' => 'https://example.test/page'])
            ->assertStatus(422)->assertJsonPath('error.code', 'url_scan_failed');
        $id = (int) UrlScanReport::query()->latest('id')->value('id');
        $this->withHeaders(['Authorization' => 'Bearer '.$token, 'X-Idempotency-Key' => 'url-scan-retry-1'])
            ->postJson('/api/v1/url-scans/'.$id.'/retry')->assertOk()->assertJsonPath('data.scan.status', 'completed');
    }

    private function admin(string $username): Admin
    {
        return Admin::query()->create(['username' => $username, 'password' => 'password', 'email' => $username.'@example.test', 'display_name' => $username, 'role' => 'admin', 'status' => 'active']);
    }

    /** @return array<string,mixed> */
    private function report(): array
    {
        return ['url' => 'https://example.test/page', 'normalized_url' => 'https://example.test/page', 'source_domain' => 'example.test', 'scanned_at' => now()->toIso8601String(), 'overall_score' => 88, 'grade' => 'A', 'robots_txt_status' => ['accessible' => true, 'status' => 200, 'gpt_bot_allowed' => true, 'claude_bot_allowed' => true, 'perplexity_allowed' => true, 'bytespider_allowed' => true], 'llms_txt_status' => ['present' => true, 'format_standard' => true, 'url_count' => 2, 'has_directives' => true, 'status' => 200], 'schema_status' => ['has_schema' => true, 'types_found' => ['Article'], 'json_ld_valid' => true], 'content_quality' => ['word_count' => 800, 'table_count' => 1, 'faq_section_detected' => true, 'fluff_ratio' => 3.2], 'items' => [], 'quick_fix_plan' => []];
    }
}
