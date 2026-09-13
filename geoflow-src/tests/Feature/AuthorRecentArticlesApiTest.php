<?php

namespace Tests\Feature;

use App\Models\Admin;
use App\Models\Article;
use App\Models\Author;
use App\Models\Category;
use App\Services\GeoFlow\MaterialLibraryService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * `GET materials/authors/{id}/articles` —— 旧后台作者详情页那张「最近文章」列表。
 *
 * 锁的是口径：倒序、固定条数、**不含回收站**。旧页 select 了 `deleted_at` 却没调
 * `withTrashed()`，软删除全局作用域仍然生效，所以回收站文章不出现——照抄结果，
 * 不要因为「反正查了 deleted_at」就把它改成包含回收站。
 */
final class AuthorRecentArticlesApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_it_returns_the_authors_most_recent_articles_newest_first(): void
    {
        $author = Author::query()->create(['name' => '张三']);
        $this->article($author, '较早的一篇', '2026-01-01 00:00:00');
        $this->article($author, '最新的一篇', '2026-03-01 00:00:00');
        $this->article($author, '居中一篇', '2026-02-01 00:00:00');
        // 别人的文章不能混进来。
        $this->article(Author::query()->create(['name' => '李四']), '别人的文章', '2026-04-01 00:00:00');

        $this->withToken($this->token())
            ->getJson('/api/v1/materials/authors/'.$author->id.'/articles')
            ->assertOk()
            ->assertJsonPath('data.author_id', $author->id)
            ->assertJsonPath('data.articles.0.title', '最新的一篇')
            ->assertJsonPath('data.articles.1.title', '居中一篇')
            ->assertJsonPath('data.articles.2.title', '较早的一篇')
            ->assertJsonCount(3, 'data.articles');
    }

    public function test_it_defaults_to_ten_articles_like_the_legacy_page(): void
    {
        $author = Author::query()->create(['name' => '高产作者']);
        foreach (range(1, 14) as $index) {
            $this->article($author, '第 '.$index.' 篇', '2026-01-'.str_pad((string) $index, 2, '0', STR_PAD_LEFT).' 00:00:00');
        }

        $response = $this->withToken($this->token())
            ->getJson('/api/v1/materials/authors/'.$author->id.'/articles')
            ->assertOk();
        $this->assertCount(MaterialLibraryService::AUTHOR_ARTICLE_LIMIT, $response->json('data.articles'));
        // 取的是最新的十条：第 14 篇在最前，第 5 篇在最后。
        $this->assertSame('第 14 篇', $response->json('data.articles.0.title'));
        $this->assertSame('第 5 篇', $response->json('data.articles.9.title'));

        $this->withToken($this->token())
            ->getJson('/api/v1/materials/authors/'.$author->id.'/articles?limit=3')
            ->assertOk()
            ->assertJsonCount(3, 'data.articles');

        // 上限封顶，不接受把整个作者的文章一次性拉走。
        $this->withToken($this->token())
            ->getJson('/api/v1/materials/authors/'.$author->id.'/articles?limit=100000')
            ->assertOk()
            ->assertJsonCount(14, 'data.articles');
    }

    public function test_recycled_articles_stay_out_of_the_list(): void
    {
        $author = Author::query()->create(['name' => '有回收站的作者']);
        $this->article($author, '还在的文章', '2026-01-01 00:00:00');
        $this->article($author, '被删掉的文章', '2026-02-01 00:00:00')->delete();

        $this->withToken($this->token())
            ->getJson('/api/v1/materials/authors/'.$author->id.'/articles')
            ->assertOk()
            ->assertJsonCount(1, 'data.articles')
            ->assertJsonPath('data.articles.0.title', '还在的文章');
    }

    public function test_it_reports_an_unknown_author(): void
    {
        $this->withToken($this->token())
            ->getJson('/api/v1/materials/authors/99999/articles')
            ->assertStatus(404)
            ->assertJsonPath('error.code', 'material_not_found');
    }

    private function article(Author $author, string $title, string $createdAt): Article
    {
        $category = Category::query()->firstOrCreate(
            ['slug' => 'default'],
            ['name' => '默认分类', 'description' => ''],
        );

        $article = Article::query()->create([
            'title' => $title,
            'slug' => 'article-'.md5($title),
            'content' => '正文',
            'category_id' => $category->id,
            'author_id' => $author->id,
            'status' => 'draft',
            'review_status' => 'approved',
        ]);
        $article->forceFill(['created_at' => $createdAt, 'updated_at' => $createdAt])->save();

        return $article->refresh();
    }

    private function token(): string
    {
        // 同一个测试里可能取多次 token，管理员只建一个。
        $admin = Admin::query()->firstOrCreate(
            ['username' => 'author_articles_admin'],
            [
                'password' => 'Password123!',
                'email' => 'author-articles@example.test',
                'display_name' => 'Author Articles Admin',
                'role' => 'admin',
                'status' => 'active',
            ],
        );

        return $admin->createToken('api', ['materials:read'])->plainTextToken;
    }
}
