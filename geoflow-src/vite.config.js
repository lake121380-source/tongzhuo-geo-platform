import { defineConfig } from 'vite';
import laravel from 'laravel-vite-plugin';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
    plugins: [
        laravel({
            input: [
                'resources/css/app.css',
                // 前台站点（官网端）的 Tailwind 入口：替代 Play CDN，见 resources/css/site.css
                'resources/css/site.css',
                'resources/js/app.js',
                'resources/js/pwa.js',
            ],
            refresh: true,
        }),
        tailwindcss(),
    ],
    server: {
        watch: {
            ignored: ['**/storage/framework/views/**'],
        },
    },
});
