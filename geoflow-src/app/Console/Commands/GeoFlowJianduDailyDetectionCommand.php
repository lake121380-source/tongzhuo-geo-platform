<?php

namespace App\Console\Commands;

use App\Exceptions\ApiException;
use App\Models\JianduDetectionSetting;
use App\Models\JianduQuestion;
use App\Services\Jiandu\JianduApiClient;
use App\Services\Jiandu\JianduConnectionService;
use Illuminate\Console\Command;

/**
 * 见度每日自动检测：把运营在后台维护的问题集交给见度跑一遍。
 *
 * 额度与积分由见度侧套餐约束（专业版 300 次/月）；见度侧还有「同日同入口重复」
 * 闸（409）——重复执行会被它挡下，这里把 409 记成「没跑成但非故障」。
 * 任何失败只记日志 + 写回 last_run_status，不让调度器爆红。
 */
class GeoFlowJianduDailyDetectionCommand extends Command
{
    protected $signature = 'geoflow:jiandu-daily-detection';

    protected $description = '见度GEO：按后台维护的问题集触发每日检测';

    public function handle(JianduConnectionService $connections, JianduApiClient $client): int
    {
        $settings = JianduDetectionSetting::current();

        if (! $settings->enabled) {
            $this->info('每日自动检测已在后台关闭，跳过。');

            return self::SUCCESS;
        }
        if ($connections->current() === null) {
            $this->info('尚未连接见度系统，跳过。');

            return self::SUCCESS;
        }

        $questions = JianduQuestion::query()
            ->where('is_active', true)
            ->orderBy('sort_order')
            ->orderBy('id')
            ->limit(JianduDetectionSetting::MAX_QUESTIONS)
            ->pluck('question')
            ->all();
        if ($questions === []) {
            $this->info('检测问题集为空，跳过（在「AI 模型与提示词 → 见度对接」里添加问题）。');

            return self::SUCCESS;
        }

        $platforms = $settings->platforms();
        if ($platforms === []) {
            $this->warn('没有勾选任何平台入口，跳过。');

            return self::SUCCESS;
        }

        try {
            $task = $connections->withFreshToken(function (string $token) use ($client, $settings, $platforms, $questions): array {
                $projectId = trim((string) $settings->project_id);
                if ($projectId === '') {
                    $projects = $client->fetchProjects($token);
                    $projectId = (string) ($projects[0]['id'] ?? '');
                }
                if ($projectId === '') {
                    throw new ApiException('jiandu_no_project', '见度账号下没有项目，无法自动检测', 409);
                }

                return $client->createDetection($token, $projectId, $platforms, $questions, '每日自动检测 '.now()->toDateString());
            });
        } catch (ApiException $exception) {
            if ($exception->getHttpStatus() === 409) {
                $settings->update(['last_run_at' => now(), 'last_run_status' => 'skipped:'.$exception->getMessage()]);
                $this->warn('见度侧未接受本次检测：'.$exception->getMessage());

                return self::SUCCESS;
            }

            $settings->update(['last_run_at' => now(), 'last_run_status' => 'failed:'.$exception->getMessage()]);
            $this->error('见度每日检测失败：'.$exception->getMessage());

            return self::FAILURE;
        } catch (\Throwable $exception) {
            $settings->update(['last_run_at' => now(), 'last_run_status' => 'failed:'.$exception->getMessage()]);
            $this->error('见度每日检测失败：'.$exception->getMessage());

            return self::FAILURE;
        }

        $settings->update(['last_run_at' => now(), 'last_run_status' => 'submitted:'.(string) ($task['id'] ?? '')]);
        $this->info(sprintf(
            '已提交每日检测：%s（%d 个问题 × %d 个入口）',
            (string) ($task['id'] ?? ''),
            count($questions),
            count($platforms),
        ));

        return self::SUCCESS;
    }
}
