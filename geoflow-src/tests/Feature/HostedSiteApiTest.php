<?php

namespace Tests\Feature;

use App\Models\Admin;
use App\Models\DistributionChannel;
use App\Models\HostedSiteProfile;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class HostedSiteApiTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        config()->set('geoflow.hosted_sites.enabled', true);
        config()->set('geoflow.hosted_sites.root_domains', ['sites.test']);
        config()->set('geoflow.hosted_sites.network_preflight_enabled', false);
        config()->set('geoflow.hosted_sites.index_observation_minutes', 0);
    }

    private function admin(string $username, string $role = 'super_admin'): Admin
    {
        return Admin::query()->create([
            'username' => $username,
            'password' => 'secret',
            'email' => $username.'@example.test',
            'display_name' => 'Hosted Site API',
            'role' => $role,
            'status' => 'active',
        ]);
    }

    /** @param list<string> $scopes */
    private function token(Admin $admin, array $scopes): string
    {
        return $admin->createToken('hosted-site-api', $scopes)->plainTextToken;
    }

    /** @return array<string,mixed> */
    private function payload(string $hostname = 'alpha.sites.test'): array
    {
        return [
            'name' => 'Alpha Hosted Site',
            'hostname' => $hostname,
            'topic' => 'AI operations',
            'locale' => 'zh_CN',
            'timezone' => 'Asia/Shanghai',
            'daily_publish_limit' => 3,
            'publish_weight' => 100,
            'min_publish_interval_minutes' => 0,
            'min_articles_before_index' => 1,
            'template_key' => 'default',
            'site_description' => 'A hosted site for API tests.',
            'site_keywords' => 'AI, GEO',
            'about_title' => 'About Alpha',
            'about_content' => 'Alpha hosted site information.',
            'contact_email' => 'contact@example.test',
            'lead_form_slugs' => [],
        ];
    }

    public function test_list_and_show_are_super_admin_only_and_generic_channels_are_not_hosted_sites(): void
    {
        $regular = $this->admin('hosted-regular', 'admin');
        $readToken = $this->token($regular, ['distribution:read']);

        $this->withHeader('Authorization', 'Bearer '.$readToken)
            ->getJson('/api/v1/distribution/hosted-sites')
            ->assertForbidden()
            ->assertJsonPath('error.code', 'forbidden');

        $generic = DistributionChannel::query()->create([
            'name' => 'Generic channel',
            'domain' => 'generic.test',
            'endpoint_url' => 'https://generic.test/agent',
            'channel_type' => DistributionChannel::TYPE_GEOFLOW_AGENT,
            'status' => DistributionChannel::STATUS_ACTIVE,
        ]);
        $superToken = $this->token($this->admin('hosted-super'), ['distribution:read']);

        $this->withHeader('Authorization', 'Bearer '.$superToken)
            ->getJson('/api/v1/distribution/hosted-sites')
            ->assertOk()
            ->assertJsonPath('data.pagination.total', 0);
        $this->withHeader('Authorization', 'Bearer '.$superToken)
            ->getJson('/api/v1/distribution/hosted-sites/'.$generic->id)
            ->assertNotFound()
            ->assertJsonPath('error.code', 'hosted_site_not_found');
    }

    public function test_create_is_persisted_and_idempotent_replay_does_not_duplicate(): void
    {
        $token = $this->token($this->admin('hosted-create'), ['distribution:read', 'distribution:write']);
        $headers = ['Authorization' => 'Bearer '.$token, 'X-Idempotency-Key' => 'hosted-create-1'];

        $first = $this->withHeaders($headers)
            ->postJson('/api/v1/distribution/hosted-sites', $this->payload());
        $first->assertCreated()
            ->assertJsonPath('data.hosted_site.channel_type', DistributionChannel::TYPE_HOSTED_SITE)
            ->assertJsonPath('data.hosted_site.profile.hostname', 'alpha.sites.test');
        $second = $this->withHeaders($headers)
            ->postJson('/api/v1/distribution/hosted-sites', $this->payload());
        $second->assertCreated();

        $this->assertSame($first->json('data.hosted_site.id'), $second->json('data.hosted_site.id'));
        $this->assertDatabaseCount('distribution_channels', 1);
        $this->assertDatabaseCount('hosted_site_profiles', 1);
        $this->assertDatabaseHas('hosted_site_profiles', [
            'hostname' => 'alpha.sites.test',
            'serving_status' => HostedSiteProfile::SERVING_MAINTENANCE,
            'indexing_status' => HostedSiteProfile::INDEXING_NOINDEX,
        ]);
    }

    public function test_lifecycle_actions_persist_safe_state_transitions(): void
    {
        $token = $this->token($this->admin('hosted-lifecycle'), ['distribution:read', 'distribution:write']);
        $headers = ['Authorization' => 'Bearer '.$token];
        $created = $this->withHeaders($headers)
            ->withHeader('X-Idempotency-Key', 'hosted-lifecycle-create')
            ->postJson('/api/v1/distribution/hosted-sites', $this->payload())
            ->assertCreated();
        $id = (int) $created->json('data.hosted_site.id');

        $this->withHeaders($headers)->withHeader('X-Idempotency-Key', 'hosted-preflight')
            ->postJson('/api/v1/distribution/hosted-sites/'.$id.'/preflight')
            ->assertOk()->assertJsonPath('data.preflight.passed', true);
        $this->withHeaders($headers)->withHeader('X-Idempotency-Key', 'hosted-activate')
            ->postJson('/api/v1/distribution/hosted-sites/'.$id.'/activate')
            ->assertOk()->assertJsonPath('data.hosted_site.profile.serving_status', HostedSiteProfile::SERVING_ONLINE);
        $this->withHeaders($headers)->withHeader('X-Idempotency-Key', 'hosted-pause')
            ->postJson('/api/v1/distribution/hosted-sites/'.$id.'/pause')
            ->assertOk()->assertJsonPath('data.hosted_site.status', DistributionChannel::STATUS_PAUSED);
        $this->withHeaders($headers)->withHeader('X-Idempotency-Key', 'hosted-maintenance')
            ->postJson('/api/v1/distribution/hosted-sites/'.$id.'/maintenance')
            ->assertOk()->assertJsonPath('data.hosted_site.profile.serving_status', HostedSiteProfile::SERVING_MAINTENANCE);
        $this->withHeaders($headers)->withHeader('X-Idempotency-Key', 'hosted-archive')
            ->postJson('/api/v1/distribution/hosted-sites/'.$id.'/archive', ['hostname' => 'alpha.sites.test'])
            ->assertOk()->assertJsonPath('data.hosted_site.profile.serving_status', HostedSiteProfile::SERVING_ARCHIVED);

        $this->assertDatabaseHas('hosted_site_profiles', [
            'hostname' => 'alpha.sites.test',
            'serving_status' => HostedSiteProfile::SERVING_ARCHIVED,
        ]);
    }

    public function test_mutations_require_idempotency_and_update_rejects_archived_site(): void
    {
        $admin = $this->admin('hosted-validation');
        $token = $this->token($admin, ['distribution:write']);
        $headers = ['Authorization' => 'Bearer '.$token];

        $this->withHeaders($headers)
            ->postJson('/api/v1/distribution/hosted-sites', $this->payload())
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'idempotency_key_required');

        $superToken = $this->token($this->admin('hosted-archive-update'), ['distribution:write']);
        $created = $this->withHeaders(['Authorization' => 'Bearer '.$superToken])
            ->withHeader('X-Idempotency-Key', 'hosted-archive-create')
            ->postJson('/api/v1/distribution/hosted-sites', $this->payload('beta.sites.test'))
            ->assertCreated();
        $id = (int) $created->json('data.hosted_site.id');
        $this->withHeaders(['Authorization' => 'Bearer '.$superToken])
            ->withHeader('X-Idempotency-Key', 'hosted-archive-action')
            ->postJson('/api/v1/distribution/hosted-sites/'.$id.'/archive', ['hostname' => 'beta.sites.test'])
            ->assertOk();
        $this->withHeaders(['Authorization' => 'Bearer '.$superToken])
            ->withHeader('X-Idempotency-Key', 'hosted-archive-edit')
            ->patchJson('/api/v1/distribution/hosted-sites/'.$id, $this->payload('beta.sites.test'))
            ->assertStatus(409)
            ->assertJsonPath('error.code', 'hosted_site_update_failed');
    }
}
