import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.VITE_SUB2API_PROXY_TARGET || 'http://localhost:8080'
  const playgroundServerTarget = env.VITE_PLAYGROUND_SERVER_TARGET || 'http://localhost:8081'

  return {
    plugins: [vue()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url))
      }
    },
    server: {
      port: 5174,
      proxy: {
        '/api/playground': {
          target: playgroundServerTarget,
          changeOrigin: true
        },
        '/api/v1': {
          target,
          changeOrigin: true
        },
        '/v1': {
          target,
          changeOrigin: true
        },
        '/images': {
          target,
          changeOrigin: true
        }
      }
    }
  }
})
