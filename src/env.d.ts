/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUB2API_BASE_URL?: string
  readonly VITE_SUB2API_PROXY_TARGET?: string
  readonly VITE_PLAYGROUND_SERVER_TARGET?: string
  readonly VITE_ENABLE_MOCK?: string
  readonly VITE_MOCK_LATENCY_MS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
