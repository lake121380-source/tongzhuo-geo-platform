<?php

namespace App\Http\Controllers\Api\V1;

use App\Exceptions\ApiException;
use App\Http\Requests\Api\StoreMaterialItemRequest;
use App\Services\Api\IdempotencyService;
use App\Services\GeoFlow\MaterialLibraryService;
use App\Support\ImageLibraryUploadPolicy;
use Closure;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\UploadedFile;
use Illuminate\Validation\Rules\File;

/**
 * API v1 素材库管理：分类、作者、关键词库、标题库、图片库、知识库。
 *
 * 读接口需 materials:read，写接口需 materials:write。写操作支持 X-Idempotency-Key。
 */
class MaterialController extends BaseApiController
{
    /**
     * 素材库类型摘要。
     */
    public function summary(Request $request, MaterialLibraryService $materials): JsonResponse
    {
        return $this->success($request, $materials->summary());
    }

    /**
     * 分页列出某类素材库。
     */
    public function index(Request $request, string $type, MaterialLibraryService $materials): JsonResponse
    {
        $search = $request->query('search');

        return $this->success($request, $materials->list(
            $type,
            $request->integer('page', 1),
            $request->integer('per_page', 20),
            ['search' => is_string($search) ? trim($search) : '']
        ));
    }

    /**
     * 创建素材库。
     */
    public function store(Request $request, string $type, MaterialLibraryService $materials): JsonResponse
    {
        return IdempotencyService::executeJson(
            $request,
            'POST /materials/{type}',
            fn (): JsonResponse => $this->success($request, $materials->create($type, $request->all()), 201),
        );
    }

    /**
     * 单个素材库详情。
     */
    public function show(Request $request, string $type, int $id, MaterialLibraryService $materials): JsonResponse
    {
        return $this->success($request, $materials->show($type, $id));
    }

    /**
     * 更新素材库。
     */
    public function update(Request $request, string $type, int $id, MaterialLibraryService $materials): JsonResponse
    {
        return IdempotencyService::executeJson(
            $request,
            'PATCH /materials/{type}/{id}',
            fn (): JsonResponse => $this->success($request, $materials->update($type, $id, $request->all())),
        );
    }

    /**
     * 删除素材库。
     */
    public function destroy(Request $request, string $type, int $id, MaterialLibraryService $materials): JsonResponse
    {
        return $this->success($request, $materials->delete($type, $id));
    }

    /**
     * 列出素材库条目（关键词、标题、图片元数据、知识库切块）。
     */
    public function items(Request $request, string $type, int $id, MaterialLibraryService $materials): JsonResponse
    {
        $search = $request->query('search');

        return $this->success($request, $materials->listItems(
            $type,
            $id,
            $request->integer('page', 1),
            $request->integer('per_page', 20),
            is_string($search) ? $search : ''
        ));
    }

    /**
     * 某作者最近的几篇文章（旧后台作者详情页的那张列表）。
     */
    public function authorArticles(Request $request, int $author, MaterialLibraryService $materials): JsonResponse
    {
        $limit = $request->query('limit');

        return $this->success($request, $materials->recentArticlesByAuthor(
            $author,
            is_numeric($limit) ? (int) $limit : MaterialLibraryService::AUTHOR_ARTICLE_LIMIT,
        ));
    }

    /**
     * 批量上传图片到图片库。
     *
     * 旧后台上传页是「一次多图、逐张独立成败」，`materials/{type}/{id}/items` 只收单张，
     * 所以这条路由是它在 api/v1 的唯一等价入口。张数上限交给 PHP 的 `max_file_uploads`。
     *
     * 这里**不挂 operationGuard**（单张的 storeItem 挂了）：那个守卫是为了让
     * 「清理无引用文件」的锁跨越整个幂等预留窗口，防的是 JSON `file_path` 指向的
     * **既有**文件在落库前被清掉。本路由只收上传文件，每张的存储与落库都在
     * {@see MaterialLibraryService::createUploadedImageItems} 内部的路径锁里完成。
     */
    public function storeImages(Request $request, int $library, MaterialLibraryService $materials): JsonResponse
    {
        $request->validate([
            'images' => ['required', 'array', 'min:1'],
            'images.*' => [
                'required',
                File::image()
                    ->types(ImageLibraryUploadPolicy::EXTENSIONS)
                    ->max(ImageLibraryUploadPolicy::maxKilobytes()),
            ],
        ], [
            'images.required' => '请选择要上传的图片',
            'images.array' => '请选择要上传的图片',
            // 这两条以前没配中文：超限时运营看到的是英文的
            // "The images.0 field must not be greater than 10240 kilobytes."，
            // 而前端以前只渲染 message，界面上就只剩「参数校验失败」。
            'images.*.max' => '单张图片不能超过 :max KB（约 '.round(ImageLibraryUploadPolicy::maxKilobytes() / 1024).' MB）',
            'images.*.image' => '只支持 JPG / PNG / GIF / WebP 图片',
        ]);

        $images = array_values(array_filter(
            (array) $request->file('images', []),
            static fn (mixed $file): bool => $file instanceof UploadedFile,
        ));
        if ($images === []) {
            throw new ApiException('validation_failed', '请选择要上传的图片', 422, [
                'field_errors' => ['images' => '请选择要上传的图片'],
            ]);
        }

        // 多选一次提交时，PHP 的 post_max_size（本机 64M）一旦被超过，**整个请求体都会被丢掉**，
        // 到这里的 $request->file() 直接是空数组——接口只能回「请选择要上传的图片」，运营完全
        // 看不出是「一次选得太多」。这里按收到的文件先算总量，给一句能看懂的话。
        $totalBytes = array_sum(array_map(static fn (UploadedFile $file): int => (int) $file->getSize(), $images));
        $postLimit = self::postMaxBytes();
        if ($postLimit > 0 && $totalBytes > $postLimit) {
            throw new ApiException('image_upload_too_large', '一次上传的图片总量过大，请分批上传', 422, [
                'field_errors' => ['images' => '一次上传的图片总量过大（约 '.round($totalBytes / 1048576).' MB），请分批上传'],
            ]);
        }

        return IdempotencyService::executeJson(
            $request,
            'POST /materials/image-libraries/{library}/images',
            function () use ($request, $library, $materials, $images): JsonResponse {
                $result = $materials->createUploadedImageItems('image-libraries', $library, $images);
                if ($result['uploaded'] === 0) {
                    // 一张都没成，就不算「部分成功」——整批报错，和旧后台的提示口径一致。
                    throw new ApiException('image_upload_failed', '所有图片都上传失败', 422, [
                        'field_errors' => ['images' => '所有图片都上传失败'],
                    ]);
                }

                return $this->success($request, [
                    'library_id' => $library,
                    'uploaded' => $result['uploaded'],
                    'skipped' => $result['skipped'],
                    'total' => $result['total'],
                    // 只回原始文件名，不回内部错误文案（可能带盘符与临时路径）。
                    'failed_names' => array_column($result['errors'], 'original_name'),
                ], 201);
            },
        );
    }

    /**
     * 新增素材库条目。
     */
    public function storeItem(StoreMaterialItemRequest $request, string $type, int $id, MaterialLibraryService $materials): JsonResponse
    {
        $routeKey = 'POST /materials/{type}/{id}/items';
        $image = $request->file('image');
        $normalizedType = str_replace('_', '-', $type);
        $payload = in_array($normalizedType, ['keyword-libraries', 'keywords', 'title-libraries', 'titles'], true)
            ? $request->validated()
            : $request->except('image');
        $operation = function () use ($request, $type, $id, $materials, $image, $payload): JsonResponse {
            $result = $image !== null
                ? $materials->createUploadedImageItem($type, $id, $image)
                : $materials->createItem($type, $id, $payload);

            return $this->success($request, $result, 201);
        };
        $operationGuard = $image !== null
            ? fn (Closure $callback): JsonResponse => $materials->withUploadedImagePathLock($type, $id, $image, $callback)
            : fn (Closure $callback): JsonResponse => $materials->withLegacyImagePathLock($type, $id, $payload, $callback);

        return IdempotencyService::executeJson($request, $routeKey, $operation, $operationGuard);
    }

    /**
     * 删除素材库条目。
     */
    public function destroyItems(Request $request, string $type, int $id, MaterialLibraryService $materials): JsonResponse
    {
        return $this->success($request, $materials->deleteItems($type, $id, $request->all()));
    }

    /**
     * PHP `post_max_size` 的字节数（0 表示取不到/无限制）。
     *
     * 超过它时 PHP 会丢掉整个请求体，Laravel 连 `$request->file()` 都拿不到——
     * 所以只能拿**已经收到**的文件总量去判，给运营一句能看懂的话。
     * 同时留 1MB 余量：multipart 的分隔符与其它字段也占体积。
     */
    private static function postMaxBytes(): int
    {
        $raw = trim((string) ini_get('post_max_size'));
        if ($raw === '' || $raw === '0') {
            return 0;
        }

        $unit = strtolower(substr($raw, -1));
        $value = (int) $raw;
        $bytes = match ($unit) {
            'g' => $value * 1024 * 1024 * 1024,
            'm' => $value * 1024 * 1024,
            'k' => $value * 1024,
            default => $value,
        };

        return max(0, $bytes - 1024 * 1024);
    }
}
