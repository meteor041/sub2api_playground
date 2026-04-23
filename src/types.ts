export type UserRole = 'admin' | 'user'

export interface UserProfile {
  id: number
  email: string
  username: string
  role: UserRole
  status: string
  balance: number
  concurrency: number
}

export interface Group {
  id: number
  name: string
  description?: string
  platform: string
  status: string
  rate_multiplier: number
  image_price_1k?: number | null
  image_price_2k?: number | null
  image_price_4k?: number | null
}

export interface ApiKey {
  id: number
  user_id: number
  key: string
  name: string
  group_id: number | null
  status: 'active' | 'inactive' | 'quota_exhausted' | 'expired'
  quota: number
  quota_used: number
  group?: Group
}

export interface PaginatedResponse<T> {
  items: T[]
  total: number
  page: number
  page_size: number
}

export interface LoginResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
  user?: UserProfile
  requires_2fa?: boolean
  temp_token?: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  imageDataUrl?: string
}

export interface GeneratedImage {
  id: string
  prompt: string
  size: string
  dataUrl?: string
  remoteUrl?: string
  createdAt: number
}
