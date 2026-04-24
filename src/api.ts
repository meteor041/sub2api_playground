import type {
  ApiKey,
  ConversationPayload,
  ConversationSummary,
  GalleryItem,
  Group,
  ImageTaskStatus,
  LoginResponse,
  PaginatedResponse,
  ShareGalleryResponse,
  UserProfile
} from './types'

const baseUrl = (import.meta.env.VITE_SUB2API_BASE_URL || '').replace(/\/$/, '')

const ACCESS_TOKEN_KEY = 'auth_token'
const REFRESH_TOKEN_KEY = 'refresh_token'
const TOKEN_EXPIRES_AT_KEY = 'token_expires_at'
const AUTH_USER_KEY = 'auth_user'

interface ApiEnvelope<T> {
  code?: number
  message?: string
  data?: T
}

export function getAccessToken(): string | null {
  return localStorage.getItem(ACCESS_TOKEN_KEY)
}

export function clearAuth(): void {
  localStorage.removeItem(ACCESS_TOKEN_KEY)
  localStorage.removeItem(REFRESH_TOKEN_KEY)
  localStorage.removeItem(TOKEN_EXPIRES_AT_KEY)
  localStorage.removeItem(AUTH_USER_KEY)
}

function saveAuthTokens(data: LoginResponse): void {
  localStorage.setItem(ACCESS_TOKEN_KEY, data.access_token)
  if (data.refresh_token) {
    localStorage.setItem(REFRESH_TOKEN_KEY, data.refresh_token)
  }
  if (data.expires_in) {
    localStorage.setItem(TOKEN_EXPIRES_AT_KEY, String(Date.now() + data.expires_in * 1000))
  }
  if (data.user) {
    localStorage.setItem(AUTH_USER_KEY, JSON.stringify(data.user))
  }
}

function apiUrl(path: string): string {
  return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) {
    return null
  }
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function extractError(data: unknown, fallback: string): string {
  if (typeof data === 'string' && data.trim()) {
    return data
  }
  if (!data || typeof data !== 'object') {
    return fallback
  }
  const record = data as Record<string, any>
  if (typeof record.message === 'string') {
    return record.message
  }
  if (typeof record.detail === 'string') {
    return record.detail
  }
  if (record.error && typeof record.error === 'object') {
    const error = record.error as Record<string, any>
    if (typeof error.message === 'string') {
      return error.message
    }
  }
  return fallback
}

async function request<T>(path: string, init: RequestInit = {}, useAuth = true): Promise<T> {
  const headers = new Headers(init.headers)
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json')
  }
  if (useAuth) {
    const token = getAccessToken()
    if (token) {
      headers.set('Authorization', `Bearer ${token}`)
    }
  }

  const response = await fetch(apiUrl(path), {
    ...init,
    headers
  })
  const data = await readJson(response)

  if (!response.ok) {
    throw new Error(extractError(data, `HTTP ${response.status}`))
  }

  if (data && typeof data === 'object' && 'code' in data) {
    const envelope = data as ApiEnvelope<T>
    if (envelope.code === 0) {
      return envelope.data as T
    }
    throw new Error(envelope.message || 'Request failed')
  }

  return data as T
}

export async function login(email: string, password: string): Promise<LoginResponse> {
  const data = await request<LoginResponse>(
    '/api/v1/auth/login',
    {
      method: 'POST',
      body: JSON.stringify({ email, password })
    },
    false
  )
  if (data.requires_2fa) {
    throw new Error('当前 Playground MVP 暂不支持二次验证登录，请先在主站登录或关闭测试账号的 2FA。')
  }
  saveAuthTokens(data)
  return data
}

export async function logout(): Promise<void> {
  const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY)
  if (refreshToken) {
    try {
      await request('/api/v1/auth/logout', {
        method: 'POST',
        body: JSON.stringify({ refresh_token: refreshToken })
      }, false)
    } catch {
      // Local logout should still complete if the server-side revoke fails.
    }
  }
  clearAuth()
}

export function hasAuthToken(): boolean {
  return Boolean(getAccessToken())
}

export function getProfile(): Promise<UserProfile> {
  return request<UserProfile>('/api/v1/user/profile')
}

export function listApiKeys(): Promise<PaginatedResponse<ApiKey>> {
  return request<PaginatedResponse<ApiKey>>('/api/v1/keys?page=1&page_size=100')
}

export function listAvailableGroups(): Promise<Group[]> {
  return request<Group[]>('/api/v1/groups/available')
}

export function createApiKey(name: string, groupId: number): Promise<ApiKey> {
  return request<ApiKey>('/api/v1/keys', {
    method: 'POST',
    body: JSON.stringify({
      name,
      group_id: groupId
    })
  })
}

export async function sendResponsesRequest(
  apiKey: string,
  payload: Record<string, unknown>
): Promise<unknown> {
  const response = await fetch(apiUrl('/v1/responses'), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  })
  const data = await readJson(response)
  if (!response.ok) {
    throw new Error(extractError(data, `Responses request failed: HTTP ${response.status}`))
  }
  return data
}

function extractStreamDelta(event: Record<string, any>): string {
  if (typeof event.delta === 'string') {
    return event.delta
  }
  if (typeof event.text === 'string' && String(event.type || '').includes('delta')) {
    return event.text
  }
  if (event.delta && typeof event.delta === 'object' && typeof event.delta.text === 'string') {
    return event.delta.text
  }
  const choiceDelta = event.choices?.[0]?.delta
  if (choiceDelta && typeof choiceDelta.content === 'string') {
    return choiceDelta.content
  }
  return ''
}

function parseSSEBlock(block: string): { data: unknown; delta: string } | null {
  const dataLines = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())

  if (dataLines.length === 0) {
    return null
  }

  const raw = dataLines.join('\n').trim()
  if (!raw || raw === '[DONE]') {
    return null
  }

  try {
    const data = JSON.parse(raw)
    if (data && typeof data === 'object') {
      return {
        data,
        delta: extractStreamDelta(data as Record<string, any>)
      }
    }
    return { data, delta: '' }
  } catch {
    return null
  }
}

export async function sendResponsesStream(
  apiKey: string,
  payload: Record<string, unknown>,
  onDelta: (delta: string) => void
): Promise<unknown> {
  const response = await fetch(apiUrl('/v1/responses'), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      ...payload,
      stream: true
    })
  })

  const contentType = response.headers.get('Content-Type') || ''
  if (!response.ok || !response.body || !contentType.includes('text/event-stream')) {
    const data = await readJson(response)
    if (!response.ok) {
      throw new Error(extractError(data, `Responses request failed: HTTP ${response.status}`))
    }
    return data
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finalData: unknown = null

  while (true) {
    const { value, done } = await reader.read()
    if (done) {
      break
    }
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')

    let separatorIndex = buffer.indexOf('\n\n')
    while (separatorIndex >= 0) {
      const block = buffer.slice(0, separatorIndex)
      buffer = buffer.slice(separatorIndex + 2)
      const parsed = parseSSEBlock(block)
      if (parsed) {
        finalData = parsed.data
        if (parsed.delta) {
          onDelta(parsed.delta)
        }
      }
      separatorIndex = buffer.indexOf('\n\n')
    }
  }

  if (buffer.trim()) {
    const parsed = parseSSEBlock(buffer)
    if (parsed) {
      finalData = parsed.data
      if (parsed.delta) {
        onDelta(parsed.delta)
      }
    }
  }

  if (finalData && typeof finalData === 'object' && 'response' in finalData) {
    return (finalData as Record<string, unknown>).response
  }
  return finalData
}

export async function generateImage(
  apiKey: string,
  payload: Record<string, unknown>
): Promise<unknown> {
  const response = await fetch(apiUrl('/v1/images/generations'), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  })
  const data = await readJson(response)
  if (!response.ok) {
    throw new Error(extractError(data, `Image request failed: HTTP ${response.status}`))
  }
  return data
}

export function createImageTask(
  apiKey: string,
  payload: Record<string, unknown>
): Promise<{ task_id: string; status: string }> {
  return request<{ task_id: string; status: string }>('/api/playground/tasks', {
    method: 'POST',
    body: JSON.stringify({
      api_key: apiKey,
      payload
    })
  })
}

export function getImageTask(taskId: string): Promise<ImageTaskStatus> {
  return request<ImageTaskStatus>(`/api/playground/tasks/${encodeURIComponent(taskId)}`)
}

export function listGalleryItems(): Promise<GalleryItem[]> {
  return request<GalleryItem[]>('/api/playground/gallery', {}, false)
}

export function shareGalleryImage(payload: {
  conversationId: string
  imageId: string
}): Promise<ShareGalleryResponse> {
  return request<ShareGalleryResponse>('/api/playground/gallery', {
    method: 'POST',
    body: JSON.stringify({
      conversation_id: payload.conversationId,
      image_id: payload.imageId
    })
  })
}

export function listConversations(): Promise<ConversationSummary[]> {
  return request<ConversationSummary[]>('/api/playground/conversations')
}

export function createConversation(title = ''): Promise<ConversationSummary> {
  return request<ConversationSummary>('/api/playground/conversations', {
    method: 'POST',
    body: JSON.stringify({ title })
  })
}

export function getConversation(conversationId: string): Promise<ConversationPayload> {
  return request<ConversationPayload>(`/api/playground/conversations/${encodeURIComponent(conversationId)}`)
}

export function saveConversationState(
  conversationId: string,
  payload: { chatMessages: unknown[]; generatedImages: unknown[] }
): Promise<{ savedAt: string; title: string }> {
  return request<{ savedAt: string; title: string }>(
    `/api/playground/conversations/${encodeURIComponent(conversationId)}`,
    {
      method: 'PUT',
      body: JSON.stringify(payload)
    }
  )
}
