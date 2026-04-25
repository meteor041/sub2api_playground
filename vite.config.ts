import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { createPlaygroundMockPlugin } from './mock/playgroundMock'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.VITE_SUB2API_PROXY_TARGET || 'http://localhost:8080'
  const playgroundServerTarget = env.VITE_PLAYGROUND_SERVER_TARGET || 'http://localhost:8081'
  const mockEnabled = mode === 'mock' || env.VITE_ENABLE_MOCK === 'true'
  const mockLatencyMs = Number.parseInt(env.VITE_MOCK_LATENCY_MS || '180', 10)

  return {
    plugins: [
      createPlaygroundMockPlugin({
        enabled: mockEnabled,
        latencyMs: Number.isFinite(mockLatencyMs) ? mockLatencyMs : 180
      }),
      vue()
    ],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url))
      }
    },
    server: {
      port: 5174,
      proxy: mockEnabled ? undefined : {
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
