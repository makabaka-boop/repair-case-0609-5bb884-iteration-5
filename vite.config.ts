import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 纯前端核验台：只读本地文件，不配置任何代理或在线服务。
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    strictPort: true
  },
  preview: {
    host: true,
    port: 7171,
    strictPort: true
  }
});
