import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@webview': resolve(__dirname, 'eca-webview/src'),
    },
  },
  build: {
    outDir: 'dist',
  },
  server: {
    port: 5180,
  },
});
