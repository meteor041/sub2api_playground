/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUB2API_BASE_URL?: string
  readonly VITE_SUB2API_PROXY_TARGET?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
