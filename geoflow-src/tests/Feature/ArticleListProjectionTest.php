<?php

namespace Tests\Feature;

use App\Models\Admin;
use App\Models\Article;
use App\Models\Author;
use App\Models\Category;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class ArticleListProjectionTest extends TestCase
{
    use RefreshDatabase;

    public function test_article_list_contains_editorial_metadata_and_relation_names(): void
    {
        $admin = Admin::query()->create([
            'username' => 'article_list_projection_admin',
            'password' => 'password',
            'email' => 'article-list-projection@example.test',
            'display_name' => 'Article List Projection Admin',
            'role' => 'admin',
            'status' => 'active',
        ]);
        $category = Category::query()->create([
            'name' => 'GEO 方法论',
            'slug' => 'geo-methodology',
        ]);
        $author = Author::query()->create(['name' => '内容团队']);
        $article = Article::query()->create([
            'title' => '可追溯的 GEO 文章',
            'slug' => 'traceable-geo-article',
            'excerpt' => '列表页需要显示这段摘要。',
            'content' => '正文内容',
            'keywords' => 'GEO, RAG',
            'meta_description' => '用于列表和编辑器的描述。',
            'view_count' => 17,
            'category_id' => $category->id,
            'author_id' => $author->id,
            'status' => 'draft',
            'review_status' => 'pending',
        ]);
        $token = $admin->createToken('article-list-reader', ['articles:read'])->plainTextToken;

        $this->withHeader('Authorization', 'Bearer '.$token)
            ->getJson('/api/v1/articles?per_page=10')
            ->assertOk()
            ->assertJsonPath('data.items.0.id', (int) $article->id)
            ->assertJsonPath('data.items.0.excerpt', '列表页需要显示这段摘要。')
            ->assertJsonPath('data.items.0.keywords', 'GEO, RAG')
            ->assertJsonPath('data.items.0.meta_description', '用于列表和编辑器的描述。')
            ->assertJsonPath('data.items.0.view_count', 17)
            ->assertJsonPath('data.items.0.category_name', 'GEO 方法论')
            ->assertJsonPath('data.items.0.author_name', '内容团队');
    }
}
