<?php

namespace Tests\Feature;

use App\Models\Admin;
use App\Models\Article;
use App\Models\ArticleImage;
use App\Models\Author;
use App\Models\Category;
use App\Models\Image;
use App\Models\ImageLibrary;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

/**
 * api/v1 的图片库图片管理：多图上传、条目搜索、使用量统计。
 *
 * 这三条都是「旧后台有、api/v1 没有」的能力，不是新发明的功能：
 * 上传对齐 `Admin\ImageLibraryController::uploadImages`（一次多图、逐张独立成败），
 * 搜索对齐 `::loadDetailImages`（按 original_name / filename / file_name 匹配），
 * 使用量对齐三个详情页各自的 `usageTotal` 口径。
 *
 * 删除（单条/批量、连带清理 ArticleImage 与受管文件）本就有等价入口，
 * 由 `ImageLibrarySecurityTest` 守着，这里不重复。
 */
final class ImageLibraryApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_it_uploads_several_images_in_one_request(): void
    {
        Storage::fake('public');
        $library = $this->library();

        $this->withToken($this->token())
            ->withHeader('Accept', 'application/json')
            ->post('/api/v1/materials/image-libraries/'.$library->id.'/images', [
                'images' => [
                    UploadedFile::fake()->image('第一张.png', 10, 10),
                    UploadedFile::fake()->image('第二张.png', 20, 10),
                    UploadedFile::fake()->image('第三张.png', 10, 20),
                ],
            ])
            ->assertCreated()
            ->assertJsonPath('data.uploaded', 3)
            ->assertJsonPath('data.skipped', 0)
            ->assertJsonPath('data.total', 3)
            ->assertJsonPath('data.failed_names', []);

        $this->assertSame(3, Image::query()->where('library_id', $library->id)->count());
        // 计数回写：库列表页显示的张数必须跟着动。
        $this->assertSame(3, (int) $library->fresh()->image_count);
        $this->assertCount(3, Storage::disk('public')->allFiles('uploads/images'));
        $this->assertSame(
            ['第一张.png', '第二张.png', '第三张.png'],
            Image::query()->where('library_id', $library->id)->orderBy('id')->pluck('original_name')->all(),
        );
    }

    /**
     * 旧后台上传页的语义是「逐张独立」：一张失败不牵连其余。
     *
     * 这里用「目标路径已被不同内容占位」来制造一张必失败的图
     * （`ManagedImageFileService` 发现内容寻址路径上的内容对不上就拒绝发布），
     * 它在单张上传时是一个 500，在批量里应当退化成「跳过这一张」。
     */
    public function test_one_bad_file_does_not_take_down_the_rest_of_the_batch(): void
    {
        Storage::fake('public');
        $library = $this->library();
        $this->poisonTargetPath();

        $response = $this->withToken($this->token())
            ->withHeader('Accept', 'application/json')
            ->post('/api/v1/materials/image-libraries/'.$library->id.'/images', [
                'images' => [
                    $this->upload('good.gif', alternate: true),
                    $this->upload('bad.gif'),
                ],
            ]);

        $response->assertCreated()
            ->assertJsonPath('data.uploaded', 1)
            ->assertJsonPath('data.skipped', 1)
            ->assertJsonPath('data.total', 2)
            ->assertJsonPath('data.failed_names', ['bad.gif']);

        $names = Image::query()->where('library_id', $library->id)->pluck('original_name')->all();
        $this->assertSame(['good.gif'], $names);
        $this->assertSame(1, (int) $library->fresh()->image_count);
        // 被占位的那张没有覆盖已有文件，也没有留下半个残骸。
        $this->assertSame('tampered content', Storage::disk('public')->get($this->targetPath()));
        $this->assertCount(2, Storage::disk('public')->allFiles('uploads/images'));
    }

    /**
     * 内容根本不是图片的文件在**存储层**被拒，因此只跳过它自己。
     *
     * 注意它和「入参不合法」不是一回事：`images.*` 规则不过（下面那条超限用例）
     * 会整批 422，一张都不写；单张内容有问题只是这一张不进库。
     */
    public function test_a_file_that_is_not_really_an_image_is_skipped_and_the_rest_land(): void
    {
        Storage::fake('public');
        $library = $this->library();

        $this->withToken($this->token())
            ->withHeader('Accept', 'application/json')
            ->post('/api/v1/materials/image-libraries/'.$library->id.'/images', [
                'images' => [
                    $this->upload('good.gif', alternate: true),
                    UploadedFile::fake()->createWithContent('forged.png', 'plain text payload'),
                ],
            ])
            ->assertCreated()
            ->assertJsonPath('data.uploaded', 1)
            ->assertJsonPath('data.skipped', 1)
            ->assertJsonPath('data.failed_names', ['forged.png']);

        $this->assertSame(['good.gif'], Image::query()->where('library_id', $library->id)->pluck('original_name')->all());
        // 失败那张没在磁盘上留下任何东西。
        $this->assertCount(1, Storage::disk('public')->allFiles('uploads/images'));
    }

    public function test_a_file_that_violates_the_upload_rules_rejects_the_whole_batch(): void
    {
        Storage::fake('public');
        config()->set('geoflow.max_upload_bytes', 1024);
        $library = $this->library();

        $this->withToken($this->token())
            ->withHeader('Accept', 'application/json')
            ->post('/api/v1/materials/image-libraries/'.$library->id.'/images', [
                'images' => [
                    UploadedFile::fake()->image('ok.png', 10, 10),
                    UploadedFile::fake()->image('oversized.png', 40, 40)->size(4),
                ],
            ])
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'validation_failed');

        $this->assertSame(0, Image::query()->where('library_id', $library->id)->count());
        $this->assertSame([], Storage::disk('public')->allFiles('uploads/images'));
    }

    public function test_it_rejects_an_empty_selection(): void
    {
        Storage::fake('public');
        $library = $this->library();

        $this->withToken($this->token())
            ->withHeader('Accept', 'application/json')
            ->post('/api/v1/materials/image-libraries/'.$library->id.'/images', ['images' => []])
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'validation_failed');

        $this->assertSame(0, Image::query()->count());
    }

    public function test_the_item_list_can_be_searched_like_the_legacy_detail_page(): void
    {
        Storage::fake('public');
        $library = $this->library();
        $this->image($library, '夏天海报.png');
        $this->image($library, '冬天海报.png');
        $this->image($library, '无关素材.png');
        $token = $this->token();

        $this->withToken($token)
            ->getJson('/api/v1/materials/image-libraries/'.$library->id.'/items?search=海报')
            ->assertOk()
            ->assertJsonCount(2, 'data.items');

        // 匹配的是文件名，不是别的字段。
        $names = array_column($this->withToken($token)
            ->getJson('/api/v1/materials/image-libraries/'.$library->id.'/items?search=夏天')
            ->json('data.items'), 'original_name');
        $this->assertSame(['夏天海报.png'], $names);

        $this->withToken($token)
            ->getJson('/api/v1/materials/image-libraries/'.$library->id.'/items')
            ->assertOk()
            ->assertJsonCount(3, 'data.items');
    }

    public function test_the_detail_reports_the_usage_total_of_each_library_kind(): void
    {
        Storage::fake('public');
        $library = $this->library();
        $image = $this->image($library, '被引用的图.png');
        ArticleImage::query()->create([
            'article_id' => $this->article()->id,
            'image_id' => $image->id,
            'position' => 0,
        ]);

        $token = $this->token();

        $this->withToken($token)
            ->getJson('/api/v1/materials/image-libraries/'.$library->id)
            ->assertOk()
            ->assertJsonPath('data.usage_total', 1);

        // 没有任何文章引用的库是真实的 0，不是「不可计算」。
        $empty = $this->library('空图片库');
        $this->withToken($token)
            ->getJson('/api/v1/materials/image-libraries/'.$empty->id)
            ->assertOk()
            ->assertJsonPath('data.usage_total', 0);

        // 分类没有「使用量」这个概念，旧后台也没有这个统计——用 null，不要拿 0 冒充。
        $category = Category::query()->firstOrFail();
        $this->withToken($token)
            ->getJson('/api/v1/materials/categories/'.$category->id)
            ->assertOk()
            ->assertJsonPath('data.usage_total', null);
    }

    private function article(): Article
    {
        $category = Category::query()->create(['name' => '默认分类', 'slug' => 'default', 'description' => '']);
        $author = Author::query()->create(['name' => '默认作者']);

        return Article::query()->create([
            'title' => '引用了图片的文章',
            'slug' => 'article-using-image',
            'content' => '正文',
            'category_id' => $category->id,
            'author_id' => $author->id,
            'status' => 'draft',
            'review_status' => 'approved',
        ]);
    }

    private function upload(string $name, bool $alternate = false): UploadedFile
    {
        return UploadedFile::fake()->createWithContent($name, $this->gifContents($alternate));
    }

    /** 一个真实可解码的 1×1 GIF；`$alternate` 让它与默认内容不同。 */
    private function gifContents(bool $alternate = false): string
    {
        $contents = base64_decode('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', true);
        $this->assertIsString($contents);
        if ($alternate) {
            $contents[13] = chr(ord($contents[13]) ^ 1);
        }

        return $contents;
    }

    /** `bad.gif` 那张图的内容寻址落点。 */
    private function targetPath(): string
    {
        $hash = hash('sha256', $this->gifContents());

        return 'uploads/images/sha256/'.substr($hash, 0, 2).'/'.substr($hash, 2, 2).'/'.$hash.'.gif';
    }

    private function poisonTargetPath(): void
    {
        Storage::disk('public')->put($this->targetPath(), 'tampered content');
    }

    private function library(string $name = '图片库'): ImageLibrary
    {
        return ImageLibrary::query()->create([
            'name' => $name,
            'description' => '',
            'image_count' => 0,
            'used_task_count' => 0,
        ]);
    }

    private function image(ImageLibrary $library, string $originalName): Image
    {
        return Image::query()->create([
            'library_id' => $library->id,
            'filename' => $originalName,
            'original_name' => $originalName,
            'file_name' => $originalName,
            'file_path' => 'storage/uploads/images/'.$originalName,
            'managed_path_hash' => hash('sha256', 'storage/uploads/images/'.$originalName),
            'file_size' => 128,
            'mime_type' => 'image/png',
            'width' => 10,
            'height' => 10,
            'tags' => '',
            'used_count' => 0,
            'usage_count' => 0,
        ]);
    }

    private function token(): string
    {
        $admin = Admin::query()->create([
            'username' => 'image_api_admin',
            'password' => 'Password123!',
            'email' => 'image-api@example.test',
            'display_name' => 'Image Api Admin',
            'role' => 'admin',
            'status' => 'active',
        ]);

        return $admin->createToken('api', ['materials:read', 'materials:write'])->plainTextToken;
    }
}
