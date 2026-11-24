import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// 两个 HTML 入口：游戏本体（index.html）与独立 API 文档页（docs/index.html）。
// 后者构建成 dist/docs/index.html，由后端静态托管在 /docs/，免登录、无会话逻辑。
const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: root + 'index.html',
        docs: root + 'docs/index.html',
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:18420',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:18420',
        ws: true,
      },
    },
  },
});
