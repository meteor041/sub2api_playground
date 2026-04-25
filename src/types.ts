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

export interface ChatImageAttachment {
  id: string
  name: string
  mimeType: string
  dataUrl: string
  assetToken?: string
  image_url?: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  attachments?: ChatImageAttachment[]
  imageDataUrl?: string
  imageAssetToken?: string
  image_url?: string
}

export interface GeneratedImage {
  id: string
  shareKey?: string
  taskId?: string
  status?: 'loading' | 'ready'
  prompt: string
  size: string
  dataUrl?: string
  remoteUrl?: string
  createdAt: number
  assetToken?: string
  image_url?: string
}

export interface GalleryItem {
  id: string
  prompt: string
  size: string
  image_url?: string
  imageUrl: string
  thumbnailUrl: string
  originalUrl: string
  sourceConversationId: string
  sourceImageId: string
  sharedByUserId: number
  sharedByName?: string
  createdAt: string
}

export interface ShareGalleryResponse {
  item: GalleryItem
  alreadyExists: boolean
}

export interface GalleryPage {
  items: GalleryItem[]
  nextOffset: number | null
  hasMore: boolean
}

export interface ImageTaskResultItem {
  id: string
  prompt: string
  size: string
  data_url: string | null
  remote_url: string | null
  image_url: string | null
}

export interface ImageTaskResult {
  images: ImageTaskResultItem[]
  raw?: {
    stream?: boolean
    events?: unknown[]
  } | unknown
}

export interface ImageTaskStatus {
  task_id: string
  status: 'queued' | 'processing' | 'completed' | 'failed'
  conversation_id: string | null
  mode: 'generate' | 'edit'
  prompt: string
  size: string
  created_at: string
  updated_at: string
  error: string | null
  result: ImageTaskResult | null
}

export interface ConversationSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  lastMessageAt?: string | null
}

export interface ConversationPayload {
  conversation: ConversationSummary
  state: {
    chatMessages: ChatMessage[]
    generatedImages: GeneratedImage[]
  }
}
