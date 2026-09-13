<?php

namespace App\Services\Admin;

/**
 * Builds commands for the Linux updater host, independent of the PHP host
 * that renders or tests the admin application.
 */
final class SystemUpdaterInstallCommandService
{
    /** @param array<string, mixed>|null $prepared @return array<string, string> */
    public function commands(?array $prepared): array
    {
        $hostRoot = trim((string) config('geoflow.updater_host_root', ''));
        $instanceId = (string) config('geoflow.updater_instance_id', 'primary');
        if ($prepared === null
            || ! str_starts_with($hostRoot, '/')
            || preg_match('/\A[a-z][a-z0-9-]{0,62}\z/', $instanceId) !== 1) {
            return [];
        }

        $archive = $this->posixArgument((string) ($prepared['filename'] ?? ''));
        $instance = $this->posixArgument($instanceId);
        $root = $this->posixArgument($hostRoot);
        $environment = $this->posixArgument(rtrim($hostRoot, '/').'/.env.prod');
        $releaseEnvironment = $this->posixArgument('/var/lib/geoflow-updater/instances/'.$instanceId.'/release.env');
        $compose = $this->posixArgument('/var/lib/geoflow-updater/instances/'.$instanceId.'/docker-compose.managed.yml');

        return [
            'unpack' => 'tar -xzf '.$archive,
            'install' => 'sudo ./packaging/scripts/install.sh',
            'enroll' => 'sudo geoflow-updater enroll --instance-id '.$instance.' --instance-root '.$root,
            'authorize' => 'sudo geoflow-updater authorization-uri --instance '.$instance,
            'activate' => 'sudo docker compose --env-file '.$environment.' --env-file '.$releaseEnvironment.' -f '.$compose." down --remove-orphans\n".'sudo docker compose --env-file '.$environment.' --env-file '.$releaseEnvironment.' -f '.$compose.' up -d --remove-orphans',
            'doctor' => 'sudo geoflow-updater doctor --instance '.$instance,
        ];
    }

    private function posixArgument(string $value): string
    {
        return "'".str_replace("'", "'\\''", $value)."'";
    }
}
