<?php

namespace Tests\Feature;

use App\Models\Admin;
use App\Models\LeadForm;
use App\Models\LeadSubmission;
use App\Services\Api\ApiTokenService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

final class LeadManagementApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_dedicated_scopes_protect_contact_data_and_mutations(): void
    {
        $this->assertContains('leads:read', app(ApiTokenService::class)->getCliLoginScopes());
        $this->assertContains('leads:write', app(ApiTokenService::class)->getCliLoginScopes());
        $admin = $this->admin('lead-scope-admin');
        $wrong = $admin->createToken('analytics-only', ['analytics:read'])->plainTextToken;
        $read = $admin->createToken('lead-read', ['leads:read'])->plainTextToken;

        $this->withToken($wrong)->getJson('/api/v1/leads')
            ->assertForbidden()
            ->assertJsonPath('error.details.required_scope', 'leads:read');

        $this->withToken($read)->getJson('/api/v1/leads')->assertOk();
        $this->withToken($read)
            ->withHeader('X-Idempotency-Key', 'lead-form-scope-denied')
            ->postJson('/api/v1/lead-forms', $this->formPayload())
            ->assertForbidden()
            ->assertJsonPath('error.details.required_scope', 'leads:write');
    }

    public function test_admin_can_create_replay_update_and_change_status_of_form(): void
    {
        $token = $this->token($this->admin('lead-form-admin'), ['leads:read', 'leads:write']);
        $payload = $this->formPayload();

        $created = $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'lead-form-create-1')
            ->postJson('/api/v1/lead-forms', $payload)
            ->assertCreated()
            ->assertJsonPath('data.form.slug', 'product-demo')
            ->assertJsonPath('data.form.fields.1.options.1', '5万以上')
            ->json('data.form');

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'lead-form-create-1')
            ->postJson('/api/v1/lead-forms', $payload)
            ->assertCreated()
            ->assertJsonPath('data.form.id', $created['id']);
        $this->assertSame(1, LeadForm::query()->count());

        $updated = $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'lead-form-update-1')
            ->patchJson('/api/v1/lead-forms/'.$created['id'], [
                'name' => '新版咨询表单',
                'expected_updated_at' => $created['updated_at'],
            ])
            ->assertOk()
            ->assertJsonPath('data.form.name', '新版咨询表单')
            ->json('data.form');

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'lead-form-stale-update')
            ->patchJson('/api/v1/lead-forms/'.$created['id'], [
                'name' => '覆盖他人更新',
                'expected_updated_at' => '2020-01-01T00:00:00.000000+00:00',
            ])
            ->assertConflict()
            ->assertJsonPath('error.code', 'lead_form_conflict');

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'lead-form-status-1')
            ->postJson('/api/v1/lead-forms/'.$created['id'].'/status', [
                'status' => LeadForm::STATUS_INACTIVE,
                'expected_updated_at' => $updated['updated_at'],
            ])
            ->assertOk()
            ->assertJsonPath('data.form.status', LeadForm::STATUS_INACTIVE);

        $this->assertDatabaseHas('admin_activity_logs', [
            'action' => 'api.lead_form.create',
            'target_type' => 'lead_form',
        ]);
    }

    public function test_form_with_submissions_cannot_be_deleted_but_empty_form_can(): void
    {
        $token = $this->token($this->admin('lead-delete-admin'), ['leads:write']);
        $used = $this->leadForm('used-form');
        LeadSubmission::query()->create([
            'lead_form_id' => $used->id,
            'payload' => ['name' => 'Alice'],
            'ip_address' => '127.0.0.1',
        ]);

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'lead-form-delete-used')
            ->deleteJson('/api/v1/lead-forms/'.$used->id, ['expected_updated_at' => $this->version($used)])
            ->assertConflict()
            ->assertJsonPath('error.code', 'lead_form_has_submissions');

        $empty = $this->leadForm('empty-form');
        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'lead-form-delete-empty')
            ->deleteJson('/api/v1/lead-forms/'.$empty->id, ['expected_updated_at' => $this->version($empty)])
            ->assertOk()
            ->assertJsonPath('data.deleted', true);

        $this->assertDatabaseHas('lead_forms', ['id' => $used->id]);
        $this->assertDatabaseMissing('lead_forms', ['id' => $empty->id]);
    }

    public function test_admin_can_filter_read_and_update_persisted_leads(): void
    {
        $admin = $this->admin('lead-handler');
        $token = $this->token($admin, ['leads:read', 'leads:write']);
        $form = $this->leadForm('contact');
        $lead = LeadSubmission::query()->create([
            'lead_form_id' => $form->id,
            'status' => LeadSubmission::STATUS_NEW,
            'payload' => ['name' => 'Alice', 'email' => 'alice@example.test'],
            'source_url' => '/pricing',
            'ip_address' => '127.0.0.1',
            'user_agent' => 'Feature Test',
        ]);
        LeadSubmission::query()->create([
            'lead_form_id' => $form->id,
            'status' => LeadSubmission::STATUS_INVALID,
            'payload' => ['name' => 'Bob'],
            'source_url' => '/spam',
            'ip_address' => '127.0.0.2',
        ]);

        $this->withToken($token)
            ->getJson('/api/v1/leads?status=new&search=alice')
            ->assertOk()
            ->assertJsonCount(1, 'data.items')
            ->assertJsonPath('data.items.0.payload.email', 'alice@example.test')
            ->assertJsonMissingPath('data.items.0.ip_address');

        $detail = $this->withToken($token)
            ->getJson('/api/v1/leads/'.$lead->id)
            ->assertOk()
            ->assertJsonPath('data.lead.ip_address', '127.0.0.1')
            ->assertJsonPath('data.lead.form.name', '联系表单')
            ->json('data.lead');

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'lead-handle-1')
            ->patchJson('/api/v1/leads/'.$lead->id, [
                'status' => LeadSubmission::STATUS_QUALIFIED,
                'note' => '已确认预算',
                'expected_updated_at' => $detail['updated_at'],
            ])
            ->assertOk()
            ->assertJsonPath('data.lead.status', LeadSubmission::STATUS_QUALIFIED)
            ->assertJsonPath('data.lead.handler.username', 'lead-handler');

        $this->assertDatabaseHas('lead_submissions', [
            'id' => $lead->id,
            'status' => LeadSubmission::STATUS_QUALIFIED,
            'note' => '已确认预算',
            'handled_by' => $admin->id,
        ]);
        $this->assertDatabaseHas('admin_activity_logs', [
            'admin_id' => $admin->id,
            'action' => 'api.lead.update',
        ]);
    }

    public function test_lead_export_preserves_filters_and_blocks_formula_injection(): void
    {
        $token = $this->token($this->admin('lead-export-admin'), ['leads:read']);
        $form = $this->leadForm('export-form');
        LeadSubmission::query()->create([
            'lead_form_id' => $form->id,
            'status' => LeadSubmission::STATUS_NEW,
            'payload' => ['name' => '=IMPORTXML("https://bad.test")'],
            'source_url' => '/pricing',
            'ip_address' => '127.0.0.1',
        ]);
        LeadSubmission::query()->create([
            'lead_form_id' => $form->id,
            'status' => LeadSubmission::STATUS_INVALID,
            'payload' => ['name' => 'Spam'],
            'source_url' => '/spam',
            'ip_address' => '127.0.0.2',
        ]);

        $response = $this->withToken($token)->get('/api/v1/leads/export?status=new');
        $response->assertOk()->assertHeader('content-type', 'text/csv; charset=UTF-8');
        $content = $response->streamedContent();
        // The complete payload is exported as a JSON object. Its CSV cell
        // starts with "{" rather than "=", so spreadsheet formula execution
        // is impossible while the original submitted value is preserved.
        $this->assertStringContainsString('=IMPORTXML', $content);
        $this->assertStringContainsString('{""name"":""=IMPORTXML', $content);
        $this->assertStringNotContainsString('Spam', $content);
    }

    /** @return array<string,mixed> */
    private function formPayload(): array
    {
        return [
            'name' => '产品咨询表单',
            'slug' => 'product-demo',
            'status' => LeadForm::STATUS_ACTIVE,
            'description' => '收集产品咨询需求',
            'submit_button_label' => '预约演示',
            'success_message' => '已收到预约',
            'fields' => [
                ['label' => '姓名', 'name' => 'name', 'type' => 'text', 'required' => true, 'options' => []],
                ['label' => '预算', 'name' => 'budget', 'type' => 'select', 'required' => true, 'options' => ['1万以内', '5万以上']],
            ],
        ];
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

    /** @param list<string> $scopes */
    private function token(Admin $admin, array $scopes): string
    {
        return $admin->createToken('lead-api', $scopes)->plainTextToken;
    }

    private function leadForm(string $slug): LeadForm
    {
        return LeadForm::query()->create([
            'name' => '联系表单',
            'slug' => $slug,
            'status' => LeadForm::STATUS_ACTIVE,
            'fields' => [['name' => 'name', 'label' => '姓名', 'type' => 'text', 'required' => true, 'options' => []]],
        ]);
    }

    private function version(LeadForm $form): string
    {
        return $form->fresh()->updated_at?->format('Y-m-d\TH:i:s.uP') ?? '';
    }
}
