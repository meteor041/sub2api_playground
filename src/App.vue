<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import logoUrl from '../asset/logo.png'
import {
  createConversation,
  createApiKey,
  createImageTask,
  getConversation,
  getImageTask,
  getProfile,
  hasAuthToken,
  listConversations,
  listApiKeys,
  listAvailableGroups,
  login,
  logout,
  listGalleryItems,
  saveConversationState,
  sendResponsesRequest,
  shareGalleryImage
} from './api'
import type {
  ApiKey,
  ChatImageAttachment,
  ChatMessage,
  ConversationSummary,
  GalleryItem,
  GeneratedImage,
  Group,
  ImageTaskStatus,
  UserProfile
} from './types'

const textModels = [
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'gpt-5.3-codex-spark',
  'gpt-5.2'
]

const imageModel = 'gpt-image-2'
const imageSizes = ['1024x1024', '1536x1024', '1024x1536']
const maxImageToolCallsPerTurn = 1
const ACTIVE_CONVERSATION_KEY = 'playground_active_conversation_id'
const PENDING_IMAGE_TASKS_KEY = 'playground_pending_image_tasks'
const THEME_MODE_KEY = 'playground_theme_mode'
const galleryPreviewWidth = 480
const conversationPreviewWidth = 960
const modalPreviewWidth = 1280
const imageExtensionByMime: Record<string, string> = {
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp'
}
const imageGenerationTool = {
  type: 'function',
  name: 'generate_image',
  description: 'Generate an image when the user explicitly asks to draw, create, render, illustrate, or make a picture.',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'A complete image prompt describing the desired visual result.'
      },
      size: {
        type: 'string',
        enum: imageSizes,
        description: 'Requested output size.'
      },
      n: {
        type: 'integer',
        minimum: 1,
        maximum: 1,
        description: 'Number of images to generate. Always use 1.'
      }
    },
    required: ['prompt'],
    additionalProperties: false
  }
}
const imageEditingTool = {
  type: 'function',
  name: 'edit_image',
  description: 'Edit the user-provided image when the user uploaded an image and wants changes applied to it.',
  parameters: imageGenerationTool.parameters
}
const imageToolInstructions = [
  'You are a helpful assistant.',
  'Reply in Chinese unless the user asks for another language.',
  'When the user explicitly asks you to create, draw, generate, render, illustrate, or make an image, call an image tool instead of only describing the prompt.',
  'If the user uploaded image(s), you must call edit_image so the uploaded image is modified rather than merely described.',
  'If the user did not upload any image, call generate_image.',
  'Only call one image tool at most once in a single turn.',
  'If no image is needed, answer normally.'
].join(' ')

const isAuthenticated = ref(hasAuthToken())
const activeView = ref<'gallery' | 'create'>('gallery')
const createMode = ref<'chat' | 'direct'>('chat')
const themeMode = ref<'light' | 'dark'>('light')
const sessionsCollapsed = ref(false)
const imagesPanelOpen = ref(false)
const email = ref('')
const password = ref('')
const loginBusy = ref(false)
const loadingApp = ref(false)
const errorMessage = ref('')
const successMessage = ref('')
const galleryBatchSize = 8
const galleryItems = ref<GalleryItem[]>([])
const galleryBusy = ref(false)
const galleryLoadingMore = ref(false)
const galleryHasMore = ref(true)
const galleryNextOffset = ref(0)
const galleryColumnCount = ref(4)
const gallerySentinel = ref<HTMLElement | null>(null)
let galleryObserver: IntersectionObserver | null = null
const sharingImageKeys = ref<string[]>([])
const sharedImageKeys = ref<string[]>([])

const profile = ref<UserProfile | null>(null)
const apiKeys = ref<ApiKey[]>([])
const groups = ref<Group[]>([])
const selectedApiKeyId = ref<number | null>(null)
const conversations = ref<ConversationSummary[]>([])
const currentConversationId = ref('')
const conversationBusy = ref(false)
const conversationSaving = ref(false)

const selectedTextModel = ref(textModels[0])
const chatInput = ref('')
const chatBusy = ref(false)
const chatMessages = ref<ChatMessage[]>([])
const composerImages = ref<ChatImageAttachment[]>([])
const composerFileInput = ref<HTMLInputElement | null>(null)

const imagePrompt = ref('')
const imageSize = ref(imageSizes[0])
const imageBusy = ref(false)
const imageTaskLabel = ref('')
const generatedImages = ref<GeneratedImage[]>([])
const selectedImageKey = ref('')
const selectedGalleryItem = ref<GalleryItem | null>(null)
const selectedComposerImage = ref<ChatImageAttachment | null>(null)
const imageSource = ref<ChatImageAttachment | null>(null)
const imageSourceInput = ref<HTMLInputElement | null>(null)

const openAiGroups = computed(() =>
  groups.value.filter((group) => group.platform === 'openai' && group.status === 'active')
)

const openAiApiKeys = computed(() =>
  apiKeys.value.filter((key) => key.status === 'active' && key.group?.platform === 'openai')
)

const selectedApiKey = computed(() => {
  if (selectedApiKeyId.value == null) {
    return openAiApiKeys.value[0] || null
  }
  return openAiApiKeys.value.find((key) => key.id === selectedApiKeyId.value) || null
})

const selectedKeySecret = computed(() => selectedApiKey.value?.key || '')

const balanceLabel = computed(() => {
  if (!profile.value) {
    return '$0.0000'
  }
  return `$${profile.value.balance.toFixed(4)}`
})

const displayName = computed(() => profile.value?.username || profile.value?.email || '已登录用户')

const selectedImage = computed(() => (
  generatedImages.value.find((image, index) => imageShareKey(image, index) === selectedImageKey.value) || null
))

const selectedImageIndex = computed(() => (
  generatedImages.value.findIndex((image, index) => imageShareKey(image, index) === selectedImageKey.value)
))

const currentConversation = computed(() => (
  conversations.value.find((conversation) => conversation.id === currentConversationId.value) || null
))

const activePendingTaskIds = new Set<string>()

interface ResponseFunctionCall {
  type: 'function_call'
  id?: string
  call_id: string
  name: string
  arguments: string
}

interface GenerateImageToolArgs {
  prompt: string
  size: string
  n: number
}

type ImageTaskPayload = Record<string, unknown> & {
  mode: 'generate' | 'edit'
}

interface PendingImageTask {
  taskId: string
  conversationId: string
  mode: 'generate' | 'edit'
  prompt: string
  size: string
  source: 'chat' | 'direct'
  assistantMessageId?: string
}

interface DisplayImageSource {
  src: string
  fallbackSrc: string
  downloadSrc: string
}

function uid(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function sanitizeFilenamePart(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
}

function buildImageFilename(seed: string, index = 1, extension = '.png'): string {
  const safeSeed = sanitizeFilenamePart(seed) || 'playground-image'
  return `${safeSeed}-${index}${extension}`
}

function inferImageExtension(source: string, mimeType = ''): string {
  const normalizedMimeType = mimeType.split(';', 1)[0]?.trim().toLowerCase() || ''
  if (normalizedMimeType && imageExtensionByMime[normalizedMimeType]) {
    return imageExtensionByMime[normalizedMimeType]
  }
  if (source.startsWith('data:')) {
    const dataMimeType = source.slice(5, source.indexOf(';')).trim().toLowerCase()
    if (dataMimeType && imageExtensionByMime[dataMimeType]) {
      return imageExtensionByMime[dataMimeType]
    }
  }
  const match = source.match(/\.([a-z0-9]+)(?:[?#]|$)/i)
  const ext = match ? `.${match[1].toLowerCase()}` : ''
  if (ext === '.jpeg') {
    return '.jpg'
  }
  if (ext && ['.gif', '.jpg', '.png', '.webp'].includes(ext)) {
    return ext
  }
  return '.png'
}

function imageShareKey(image: GeneratedImage, index = 0): string {
  return image.shareKey || image.assetToken || image.image_url || image.remoteUrl || `${image.id}:${image.createdAt}:${index}`
}

function normalizeGeneratedImages(images: GeneratedImage[]): GeneratedImage[] {
  const seen = new Map<string, number>()
  return images.map((image, index) => {
    const baseKey = image.shareKey || image.assetToken || image.image_url || image.remoteUrl || `${image.id}:${image.createdAt || index}`
    const count = seen.get(baseKey) || 0
    seen.set(baseKey, count + 1)
    return {
      ...image,
      shareKey: count === 0 ? baseKey : `${baseKey}:${count}`
    }
  })
}

function imageSourceUrl(image: GeneratedImage): string {
  return image.image_url || image.dataUrl || image.remoteUrl || ''
}

function imageDownloadUrl(image: GeneratedImage): string {
  return imageFallbackUrl(image) || imageSourceUrl(image)
}

function isSameOriginUrl(value: string): boolean {
  if (!value || value.startsWith('data:') || value.startsWith('blob:')) {
    return true
  }
  try {
    return new URL(value, window.location.href).origin === window.location.origin
  } catch {
    return false
  }
}

function buildNativeDownloadHref(source: string, filename = ''): string {
  if (!source || source.startsWith('data:') || source.startsWith('blob:')) {
    return source
  }

  try {
    const url = new URL(source, window.location.href)
    if (url.origin === window.location.origin && url.pathname.startsWith('/api/playground/assets/')) {
      url.searchParams.set('download', '1')
      if (filename.trim()) {
        url.searchParams.set('filename', filename)
      }
      return `${url.pathname}${url.search}${url.hash}`
    }
  } catch {
    return source
  }

  return source
}

function buildCompressedPreviewUrl(source: string, width = galleryPreviewWidth): string {
  if (!source || source.startsWith('data:')) {
    return source
  }
  const safeWidth = Number.isFinite(width) && width > 0 ? Math.round(width) : galleryPreviewWidth
  const absoluteSource = toAbsoluteAssetUrl(source)
  if (!/^https?:\/\//i.test(absoluteSource)) {
    return source
  }
  return `/cdn-cgi/image/width=${safeWidth},quality=70,format=webp,fit=scale-down/${absoluteSource}`
}

function imagePreviewUrl(image: GeneratedImage, width = conversationPreviewWidth): string {
  const originalSource = imageSourceUrl(image)
  return buildCompressedPreviewUrl(originalSource, width) || originalSource
}

function imageFallbackUrl(image: GeneratedImage): string {
  return image.dataUrl || (image.assetToken ? `/api/playground/assets/${image.assetToken}` : '') || image.remoteUrl || ''
}

function galleryImageUrl(item: GalleryItem): string {
  return item.thumbnailUrl || buildCompressedPreviewUrl(item.image_url || item.originalUrl || '', galleryPreviewWidth) || item.image_url || item.imageUrl || item.originalUrl || ''
}

function galleryModalUrl(item: GalleryItem): string {
  return buildCompressedPreviewUrl(item.image_url || item.originalUrl || '', modalPreviewWidth) || item.originalUrl || galleryImageUrl(item)
}

function galleryFallbackUrl(item: GalleryItem): string {
  return item.originalUrl || item.thumbnailUrl || item.imageUrl || ''
}

function parseImageSize(size?: string): { width: number, height: number } | null {
  if (!size) {
    return null
  }
  const match = size.trim().match(/^(\d+)\s*x\s*(\d+)$/i)
  if (!match) {
    return null
  }
  const width = Number.parseInt(match[1], 10)
  const height = Number.parseInt(match[2], 10)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null
  }
  return { width, height }
}

function imageAspectRatio(size?: string): string | undefined {
  const dimensions = parseImageSize(size)
  if (!dimensions) {
    return undefined
  }
  return `${dimensions.width} / ${dimensions.height}`
}

function imageRelativeHeight(size?: string): number {
  const dimensions = parseImageSize(size)
  if (!dimensions) {
    return 1
  }
  return dimensions.height / dimensions.width
}

function resolveGalleryColumnCount(viewportWidth: number): number {
  if (viewportWidth <= 820) {
    return 2
  }
  if (viewportWidth <= 1180) {
    return 3
  }
  return 4
}

function syncGalleryColumnCount(): void {
  galleryColumnCount.value = resolveGalleryColumnCount(window.innerWidth)
}

function buildDisplayImageSource(primary?: string, fallback?: string, width = conversationPreviewWidth): DisplayImageSource | null {
  const downloadSrc = fallback || primary || ''
  if (!downloadSrc) {
    return null
  }
  return {
    src: buildCompressedPreviewUrl(primary || downloadSrc, width) || primary || downloadSrc,
    fallbackSrc: fallback || downloadSrc,
    downloadSrc
  }
}

function handleImageError(event: Event, fallbackSrc: string): void {
  const image = event.currentTarget as HTMLImageElement | null
  if (!image || !fallbackSrc || image.dataset.fallbackApplied === 'true' || image.src === fallbackSrc) {
    return
  }
  image.dataset.fallbackApplied = 'true'
  image.src = fallbackSrc
}

function handleGeneratedImageError(event: Event, image: GeneratedImage): void {
  handleImageError(event, imageFallbackUrl(image))
}

function closeImageModal(): void {
  selectedImageKey.value = ''
  selectedGalleryItem.value = null
  selectedComposerImage.value = null
}

function openImageModal(image: GeneratedImage, index: number): void {
  selectedImageKey.value = imageShareKey(image, index)
  selectedGalleryItem.value = null
  selectedComposerImage.value = null
}

function openGalleryModal(item: GalleryItem): void {
  selectedGalleryItem.value = item
  selectedImageKey.value = ''
  selectedComposerImage.value = null
}

function openComposerImageModal(image: ChatImageAttachment): void {
  selectedComposerImage.value = image
  selectedImageKey.value = ''
  selectedGalleryItem.value = null
}

function handleGalleryImageError(event: Event, item: GalleryItem): void {
  handleImageError(event, galleryFallbackUrl(item))
}

const galleryColumns = computed(() => {
  const columnCount = Math.max(galleryColumnCount.value, 1)
  const columns = Array.from({ length: columnCount }, () => [] as GalleryItem[])
  const columnHeights = Array.from({ length: columnCount }, () => 0)

  for (const item of galleryItems.value) {
    let targetColumnIndex = 0
    for (let index = 1; index < columnCount; index += 1) {
      if (columnHeights[index] < columnHeights[targetColumnIndex]) {
        targetColumnIndex = index
      }
    }
    columns[targetColumnIndex].push(item)
    columnHeights[targetColumnIndex] += imageRelativeHeight(item.size) + 0.02
  }

  return columns
})

function triggerDownload(url: string, filename: string): void {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener noreferrer'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, '\n')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function toAbsoluteAssetUrl(value: string): string {
  if (/^https?:\/\//i.test(value) || value.startsWith('data:')) {
    return value
  }
  if (value.startsWith('/')) {
    return `${window.location.origin}${value}`
  }
  return value
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
        return
      }
      reject(new Error('读取图片失败'))
    }
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

async function createChatImageAttachment(file: File): Promise<ChatImageAttachment> {
  if (!file.type.startsWith('image/')) {
    throw new Error(`仅支持图片文件：${file.name}`)
  }
  return {
    id: uid('attachment'),
    name: file.name || 'image.png',
    mimeType: file.type || 'image/png',
    dataUrl: await readFileAsDataUrl(file)
  }
}

function setError(message: string): void {
  errorMessage.value = message
  successMessage.value = ''
}

function setSuccess(message: string): void {
  successMessage.value = message
  errorMessage.value = ''
}

function applyThemeMode(mode: 'light' | 'dark'): void {
  themeMode.value = mode
  document.documentElement.dataset.theme = mode
  localStorage.setItem(THEME_MODE_KEY, mode)
}

function initializeThemeMode(): void {
  const savedMode = localStorage.getItem(THEME_MODE_KEY)
  applyThemeMode(savedMode === 'dark' ? 'dark' : 'light')
}

function toggleThemeMode(): void {
  applyThemeMode(themeMode.value === 'dark' ? 'light' : 'dark')
}

function applyBranding(): void {
  document.title = 'MeteorAPI Image Playground'

  let favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (!favicon) {
    favicon = document.createElement('link')
    favicon.rel = 'icon'
    document.head.appendChild(favicon)
  }
  favicon.href = logoUrl
}

function sortConversations(items: ConversationSummary[]): ConversationSummary[] {
  return [...items].sort((left, right) => {
    const leftTime = Date.parse(left.updatedAt || left.createdAt || '')
    const rightTime = Date.parse(right.updatedAt || right.createdAt || '')
    return rightTime - leftTime
  })
}

function persistActiveConversationId(conversationId: string): void {
  currentConversationId.value = conversationId
  if (conversationId) {
    localStorage.setItem(ACTIVE_CONVERSATION_KEY, conversationId)
  } else {
    localStorage.removeItem(ACTIVE_CONVERSATION_KEY)
  }
}

function resetConversationState(): void {
  conversations.value = []
  persistActiveConversationId('')
  chatMessages.value = []
  generatedImages.value = []
  selectedImageKey.value = ''
  sharedImageKeys.value = []
  localStorage.removeItem(PENDING_IMAGE_TASKS_KEY)
}

function readPendingImageTasks(): PendingImageTask[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(PENDING_IMAGE_TASKS_KEY) || '[]') as unknown
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.filter((task): task is PendingImageTask => (
      task &&
      typeof task === 'object' &&
      typeof task.taskId === 'string' &&
      typeof task.conversationId === 'string' &&
      (task.mode === 'generate' || task.mode === 'edit') &&
      typeof task.prompt === 'string' &&
      typeof task.size === 'string' &&
      (task.source === 'chat' || task.source === 'direct')
    ))
  } catch {
    return []
  }
}

function writePendingImageTasks(tasks: PendingImageTask[]): void {
  const uniqueTasks = tasks.filter((task, index, items) => (
    items.findIndex((item) => item.taskId === task.taskId) === index
  ))
  localStorage.setItem(PENDING_IMAGE_TASKS_KEY, JSON.stringify(uniqueTasks))
}

function addPendingImageTask(task: PendingImageTask): void {
  writePendingImageTasks([task, ...readPendingImageTasks().filter((item) => item.taskId !== task.taskId)])
}

function removePendingImageTask(taskId: string): void {
  writePendingImageTasks(readPendingImageTasks().filter((task) => task.taskId !== taskId))
}

function replaceOrAppendMessage(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const index = messages.findIndex((item) => item.id === message.id)
  if (index < 0) {
    return [...messages, message]
  }
  const nextMessages = [...messages]
  nextMessages.splice(index, 1, {
    ...nextMessages[index],
    ...message
  })
  return nextMessages
}

async function saveConversationSnapshot(
  conversationId: string,
  nextChatMessages: ChatMessage[],
  nextGeneratedImages: GeneratedImage[]
): Promise<void> {
  const result = await saveConversationState(conversationId, {
    chatMessages: nextChatMessages,
    generatedImages: nextGeneratedImages
  })
  conversations.value = sortConversations(conversations.value.map((conversation) => (
    conversation.id === conversationId
      ? {
        ...conversation,
        title: result.title,
        updatedAt: result.savedAt,
        lastMessageAt: result.savedAt
      }
      : conversation
  )))
  if (currentConversationId.value === conversationId) {
    chatMessages.value = nextChatMessages
    generatedImages.value = normalizeGeneratedImages(nextGeneratedImages)
    selectedImageKey.value = ''
    sharedImageKeys.value = []
  }
}

async function refreshConversationIndex(): Promise<void> {
  conversations.value = sortConversations(await listConversations())
}

async function loadConversationById(conversationId: string): Promise<void> {
  conversationBusy.value = true
  try {
    const payload = await getConversation(conversationId)
    persistActiveConversationId(payload.conversation.id)
    chatMessages.value = payload.state.chatMessages || []
    generatedImages.value = normalizeGeneratedImages(payload.state.generatedImages || [])
    selectedImageKey.value = ''
    sharedImageKeys.value = []
  } finally {
    conversationBusy.value = false
  }
}

async function startNewConversation(): Promise<void> {
  conversationBusy.value = true
  try {
    const created = await createConversation()
    conversations.value = sortConversations([created, ...conversations.value.filter((item) => item.id !== created.id)])
    persistActiveConversationId(created.id)
    chatMessages.value = []
    generatedImages.value = []
    selectedImageKey.value = ''
    sharedImageKeys.value = []
  } finally {
    conversationBusy.value = false
  }
}

async function ensureConversationLoaded(): Promise<void> {
  await refreshConversationIndex()

  const savedConversationId = localStorage.getItem(ACTIVE_CONVERSATION_KEY) || ''
  const preferredConversation = conversations.value.find((item) => item.id === savedConversationId) || conversations.value[0] || null

  if (!preferredConversation) {
    await startNewConversation()
    return
  }

  await loadConversationById(preferredConversation.id)
}

async function persistConversationSnapshot(): Promise<void> {
  if (!currentConversationId.value || !isAuthenticated.value) {
    return
  }

  conversationSaving.value = true
  try {
    await saveConversationSnapshot(currentConversationId.value, chatMessages.value, generatedImages.value)
  } catch {
    // Saving should be best-effort so local UI progress is not interrupted.
  } finally {
    conversationSaving.value = false
  }
}

async function handleConversationSelect(): Promise<void> {
  if (!currentConversationId.value) {
    return
  }
  await loadConversationById(currentConversationId.value)
}

async function refreshWorkspace(): Promise<void> {
  loadingApp.value = true
  try {
    const [nextProfile, nextKeys, nextGroups] = await Promise.all([
      getProfile(),
      listApiKeys(),
      listAvailableGroups()
    ])
    profile.value = nextProfile
    apiKeys.value = nextKeys.items || []
    groups.value = nextGroups || []
    if (!selectedApiKeyId.value && openAiApiKeys.value.length > 0) {
      selectedApiKeyId.value = openAiApiKeys.value[0].id
    }
  } catch (error) {
    setError(error instanceof Error ? error.message : '加载用户信息失败')
  } finally {
    loadingApp.value = false
  }
}

async function handleLogin(): Promise<void> {
  if (!email.value.trim() || !password.value) {
    setError('请输入邮箱和密码。')
    return
  }
  loginBusy.value = true
  try {
    await login(email.value.trim(), password.value)
    isAuthenticated.value = true
    setSuccess('登录成功，正在加载 Playground。')
    await refreshWorkspace()
    await ensureConversationLoaded()
  } catch (error) {
    setError(error instanceof Error ? error.message : '登录失败')
  } finally {
    loginBusy.value = false
  }
}

async function handleLogout(): Promise<void> {
  await logout()
  isAuthenticated.value = false
  activeView.value = 'gallery'
  profile.value = null
  apiKeys.value = []
  groups.value = []
  selectedApiKeyId.value = null
  chatInput.value = ''
  composerImages.value = []
  if (composerFileInput.value) {
    composerFileInput.value.value = ''
  }
  clearManualImageSource()
  resetConversationState()
}

async function handleCreateApiKey(): Promise<void> {
  const group = openAiGroups.value[0]
  if (!group) {
    setError('当前用户没有可用的 OpenAI 分组，请先在 sub2api 主站配置或授权分组。')
    return
  }
  try {
    const key = await createApiKey('Image Playground', group.id)
    setSuccess(`已创建 API Key：${key.name}`)
    await refreshWorkspace()
    selectedApiKeyId.value = key.id
  } catch (error) {
    setError(error instanceof Error ? error.message : '创建 API Key 失败')
  }
}

async function refreshGallery(): Promise<void> {
  galleryBusy.value = true
  galleryNextOffset.value = 0
  galleryHasMore.value = true
  try {
    const page = await listGalleryItems(0, galleryBatchSize)
    galleryItems.value = page.items
    galleryNextOffset.value = page.nextOffset || galleryItems.value.length
    galleryHasMore.value = page.hasMore
  } catch (error) {
    setError(error instanceof Error ? error.message : '加载公共画廊失败')
  } finally {
    galleryBusy.value = false
  }
}

async function loadMoreGallery(): Promise<void> {
  if (galleryBusy.value || galleryLoadingMore.value || !galleryHasMore.value) {
    return
  }
  galleryLoadingMore.value = true
  try {
    const page = await listGalleryItems(galleryNextOffset.value, galleryBatchSize)
    const existingIds = new Set(galleryItems.value.map((item) => item.id))
    galleryItems.value = [
      ...galleryItems.value,
      ...page.items.filter((item) => !existingIds.has(item.id))
    ]
    galleryNextOffset.value = page.nextOffset || galleryItems.value.length
    galleryHasMore.value = page.hasMore
  } catch (error) {
    setError(error instanceof Error ? error.message : '加载更多画廊失败')
  } finally {
    galleryLoadingMore.value = false
  }
}

function setupGalleryObserver(): void {
  galleryObserver?.disconnect()
  if (!gallerySentinel.value) {
    return
  }
  galleryObserver = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) {
      void loadMoreGallery()
    }
  }, {
    rootMargin: '40px 0px'
  })
  galleryObserver.observe(gallerySentinel.value)
}

function imageMatchesGalleryItem(image: GeneratedImage, item: GalleryItem): boolean {
  if (item.sourceConversationId !== currentConversationId.value) {
    return false
  }
  const source = imageSourceUrl(image)
  return (
    (image.assetToken && item.originalUrl.endsWith(`/api/playground/assets/${image.assetToken}`)) ||
    (image.remoteUrl && item.originalUrl === image.remoteUrl) ||
    Boolean(source && item.originalUrl === source)
  )
}

function isImageShared(image: GeneratedImage, index = 0): boolean {
  return sharedImageKeys.value.includes(imageShareKey(image, index)) ||
    galleryItems.value.some((item) => imageMatchesGalleryItem(image, item))
}

function isImageSharing(image: GeneratedImage, index = 0): boolean {
  return sharingImageKeys.value.includes(imageShareKey(image, index))
}

async function handleShareImage(image: GeneratedImage, index = 0): Promise<void> {
  if (!isAuthenticated.value) {
    activeView.value = 'create'
    setError('请先登录后再转发图片到公共画廊。')
    return
  }
  if (!currentConversationId.value) {
    setError('请先选择或创建一个会话。')
    return
  }
  const shareKey = imageShareKey(image, index)
  if (isImageSharing(image, index) || isImageShared(image, index)) {
    return
  }

  sharingImageKeys.value = [...sharingImageKeys.value, shareKey]
  try {
    await persistConversationSnapshot()
    const persisted = await getConversation(currentConversationId.value)
    const persistedImages = normalizeGeneratedImages(persisted.state.generatedImages || [])
    const shareImage = persistedImages.find((item, itemIndex) => imageShareKey(item, itemIndex) === shareKey) ||
      persistedImages[index] ||
      image
    generatedImages.value = persistedImages
    const result = await shareGalleryImage({
      conversationId: currentConversationId.value,
      imageId: shareImage.id,
      assetToken: shareImage.assetToken,
      remoteUrl: shareImage.remoteUrl
    })
    sharedImageKeys.value = [...new Set([...sharedImageKeys.value, shareKey])]
    galleryItems.value = [
      result.item,
      ...galleryItems.value.filter((item) => item.id !== result.item.id)
    ]
    galleryNextOffset.value = galleryItems.value.length
    setSuccess(result.alreadyExists ? '这张图片已经在公共画廊中。' : '已转发到公共画廊。')
  } catch (error) {
    setError(error instanceof Error ? error.message : '转发到公共画廊失败')
  } finally {
    sharingImageKeys.value = sharingImageKeys.value.filter((key) => key !== shareKey)
  }
}

function extractResponseText(data: unknown): string {
  if (!data || typeof data !== 'object') {
    return ''
  }
  const record = data as Record<string, any>
  if (typeof record.output_text === 'string' && record.output_text.trim()) {
    return record.output_text
  }
  if (Array.isArray(record.output)) {
    const parts: string[] = []
    for (const item of record.output) {
      if (!item || typeof item !== 'object') {
        continue
      }
      const content = (item as Record<string, any>).content
      if (!Array.isArray(content)) {
        continue
      }
      for (const part of content) {
        if (!part || typeof part !== 'object') {
          continue
        }
        const p = part as Record<string, any>
        if (typeof p.text === 'string') {
          parts.push(p.text)
        } else if (typeof p.output_text === 'string') {
          parts.push(p.output_text)
        }
      }
    }
    if (parts.length > 0) {
      return parts.join('\n')
    }
  }
  if (Array.isArray(record.choices)) {
    const first = record.choices[0]
    const content = first?.message?.content
    if (typeof content === 'string') {
      return content
    }
  }
  return JSON.stringify(data, null, 2)
}

function ensureResponseSucceeded(data: unknown): void {
  if (!data || typeof data !== 'object') {
    return
  }
  const record = data as Record<string, any>
  if (record.status === 'failed') {
    throw new Error(record.error?.message || '模型请求失败')
  }
  if (record.status === 'incomplete') {
    const reason = typeof record.incomplete_details?.reason === 'string'
      ? record.incomplete_details.reason
      : ''
    throw new Error(reason ? `模型输出不完整：${reason}` : '模型输出不完整')
  }
}

function extractResponseFunctionCalls(data: unknown): ResponseFunctionCall[] {
  if (!data || typeof data !== 'object') {
    return []
  }
  const output = (data as Record<string, any>).output
  if (!Array.isArray(output)) {
    return []
  }
  return output
    .filter((item) =>
      item &&
      typeof item === 'object' &&
      item.type === 'function_call' &&
      typeof item.call_id === 'string' &&
      typeof item.name === 'string'
    )
    .map((item) => ({
      type: 'function_call',
      id: typeof item.id === 'string' ? item.id : undefined,
      call_id: item.call_id,
      name: item.name,
      arguments: typeof item.arguments === 'string' ? item.arguments : '{}'
    }))
}

function parseGenerateImageToolArgs(functionCall: ResponseFunctionCall): GenerateImageToolArgs {
  let parsed: Record<string, unknown> = {}
  if (functionCall.arguments.trim()) {
    try {
      parsed = JSON.parse(functionCall.arguments) as Record<string, unknown>
    } catch {
      throw new Error('模型返回了无法解析的生图参数。')
    }
  }

  const prompt = typeof parsed.prompt === 'string' ? parsed.prompt.trim() : ''
  if (!prompt) {
    throw new Error('模型调用了生图工具，但没有提供有效提示词。')
  }

  const size = typeof parsed.size === 'string' && imageSizes.includes(parsed.size)
    ? parsed.size
    : imageSize.value

  return {
    prompt,
    size,
    n: 1
  }
}

function buildFunctionCallInput(functionCall: ResponseFunctionCall): Record<string, unknown> {
  return {
    type: 'function_call',
    ...(functionCall.id ? { id: functionCall.id } : {}),
    call_id: functionCall.call_id,
    name: functionCall.name,
    arguments: functionCall.arguments
  }
}

function buildFunctionCallOutput(images: GeneratedImage[], prompt: string, size: string): string {
  return JSON.stringify({
    ok: true,
    prompt,
    size,
    image_count: images.length,
    image_url: images[0]?.image_url || images[0]?.remoteUrl || null,
    preview_ready: true,
    note: 'The UI already has the generated image preview and will display it to the user.'
  })
}

function describeImageTaskStatus(status: ImageTaskStatus['status']): string {
  switch (status) {
    case 'queued':
      return '生图任务已创建，正在排队...'
    case 'processing':
      return '生图任务正在执行...'
    case 'completed':
      return '生图任务已完成，正在读取结果...'
    case 'failed':
      return '生图任务失败'
    default:
      return '生图任务处理中...'
  }
}

async function waitForImageTask(
  taskId: string,
  onStatus?: (task: ImageTaskStatus) => void
): Promise<ImageTaskStatus> {
  const startedAt = Date.now()
  const timeoutMs = 10 * 60 * 1000

  while (Date.now() - startedAt < timeoutMs) {
    const task = await getImageTask(taskId)
    onStatus?.(task)
    if (task.status === 'completed' || task.status === 'failed') {
      return task
    }
    await sleep(2000)
  }

  throw new Error('生图任务轮询超时，请稍后刷新页面查看结果。')
}

function buildImageTaskPayload(
  prompt: string,
  size: string,
  sourceImages: ChatImageAttachment[] = [],
  conversationId = currentConversationId.value,
  source: 'chat' | 'direct' = 'direct',
  assistantMessageId?: string
): ImageTaskPayload {
  const trimmedPrompt = prompt.trim()
  if (sourceImages.length > 0) {
    return {
      mode: 'edit',
      model: imageModel,
      prompt: trimmedPrompt,
      size,
      n: 1,
      response_format: 'b64_json',
      conversation_id: conversationId || null,
      source,
      assistant_message_id: assistantMessageId || null,
      images: sourceImages.map((image) => ({
        name: image.name,
        mime_type: image.mimeType,
        data_url: image.dataUrl
      }))
    }
  }

  return {
    mode: 'generate',
    model: imageModel,
    prompt: trimmedPrompt,
    size,
    n: 1,
    response_format: 'b64_json',
    conversation_id: conversationId || null,
    source,
    assistant_message_id: assistantMessageId || null
  }
}

function buildChatMessageInput(message: ChatMessage): Record<string, unknown> {
  if (message.role !== 'user' || !message.attachments?.length) {
    return {
      role: message.role,
      content: message.content
    }
  }

  const parts: Array<Record<string, string>> = []
  if (message.content) {
    parts.push({
      type: 'input_text',
      text: message.content
    })
  }
  for (const attachment of message.attachments) {
    parts.push({
      type: 'input_image',
      image_url: toAbsoluteAssetUrl(attachment.dataUrl)
    })
  }

  return {
    role: message.role,
    content: parts
  }
}

function buildConversationInput(): Array<Record<string, unknown>> {
  return chatMessages.value
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-12)
    .map((message) => buildChatMessageInput(message))
}

function updateChatMessage(id: string, updates: Partial<ChatMessage>): void {
  const index = chatMessages.value.findIndex((message) => message.id === id)
  if (index < 0) {
    return
  }
  const current = chatMessages.value[index]
  chatMessages.value.splice(index, 1, {
    ...current,
    ...updates
  })
}

function removeComposerImage(id: string): void {
  composerImages.value = composerImages.value.filter((image) => image.id !== id)
}

function clearManualImageSource(): void {
  imageSource.value = null
  if (imageSourceInput.value) {
    imageSourceInput.value.value = ''
  }
}

function openManualImagePicker(): void {
  imageSourceInput.value?.click()
}

async function handleManualImageChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement | null
  const file = input?.files?.[0]
  if (!file) {
    return
  }
  try {
    imageSource.value = await createChatImageAttachment(file)
    errorMessage.value = ''
  } catch (error) {
    clearManualImageSource()
    setError(error instanceof Error ? error.message : '读取编辑原图失败')
  }
}

function messageImages(message: ChatMessage): DisplayImageSource[] {
  const images = (message.attachments || [])
    .map((image) => buildDisplayImageSource(image.image_url, image.dataUrl, conversationPreviewWidth))
    .filter((image): image is DisplayImageSource => Boolean(image))
  const inlineImage = buildDisplayImageSource(message.image_url, message.imageDataUrl, conversationPreviewWidth)
  if (inlineImage) {
    images.push(inlineImage)
  }
  return images
}

async function downloadImage(source: string, filenameSeed: string, index = 1): Promise<void> {
  if (!source) {
    return
  }

  const filename = buildImageFilename(filenameSeed, index, inferImageExtension(source))
  const href = buildNativeDownloadHref(source, filename)
  const link = document.createElement('a')
  const shouldOpenInNewTab = !isSameOriginUrl(href)

  link.href = href
  link.download = filename
  link.rel = 'noopener noreferrer'
  link.style.display = 'none'
  if (shouldOpenInNewTab) {
    link.target = '_blank'
  }

  document.body.appendChild(link)

  try {
    link.click()
  } catch {
    window.open(href, '_blank', 'noopener,noreferrer')
    setError('无法直接下载该图片，已为你打开原图链接。')
  } finally {
    link.remove()
    if (href.startsWith('blob:')) {
      window.setTimeout(() => URL.revokeObjectURL(href), 30_000)
    }
  }
}

function openComposerFilePicker(): void {
  composerFileInput.value?.click()
}

async function appendComposerImages(files: File[]): Promise<void> {
  const imageFiles = files.filter((file) => file.type.startsWith('image/'))
  if (imageFiles.length === 0) {
    setError('只能添加图片文件。')
    return
  }

  try {
    const attachments = await Promise.all(imageFiles.map((file) => createChatImageAttachment(file)))
    composerImages.value = [...composerImages.value, ...attachments]
    errorMessage.value = ''
  } catch (error) {
    setError(error instanceof Error ? error.message : '添加图片失败')
  }
}

async function handleComposerFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement | null
  const files = Array.from(input?.files || [])
  await appendComposerImages(files)
  if (input) {
    input.value = ''
  }
}

async function handleComposerPaste(event: ClipboardEvent): Promise<void> {
  const clipboard = event.clipboardData
  if (!clipboard) {
    return
  }

  const imageFiles = Array.from(clipboard.items)
    .filter((item) => item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file))

  if (imageFiles.length === 0) {
    return
  }

  event.preventDefault()
  const text = normalizeLineEndings(clipboard.getData('text/plain'))
  if (text.trim()) {
    chatInput.value = chatInput.value
      ? `${chatInput.value}${chatInput.value.endsWith('\n') ? '' : '\n'}${text}`
      : text
  }
  await appendComposerImages(imageFiles)
}

function handleComposerKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) {
    return
  }
  event.preventDefault()
  if (chatBusy.value) {
    return
  }
  void handleSendChat()
}

async function handleSendChat(): Promise<void> {
  if (!currentConversationId.value) {
    await startNewConversation()
  }
  const originConversationId = currentConversationId.value
  const apiKey = selectedKeySecret.value
  const content = chatInput.value.trim()
  const attachments = composerImages.value.map((image) => ({ ...image }))
  if (!apiKey) {
    setError('请先选择或创建一个 OpenAI 分组 API Key。')
    return
  }
  if (!content && attachments.length === 0) {
    setError('请输入对话内容或添加图片。')
    return
  }

  errorMessage.value = ''
  successMessage.value = ''
  chatInput.value = ''
  composerImages.value = []
  chatBusy.value = true
  chatMessages.value.push({
    id: uid('user'),
    role: 'user',
    content,
    createdAt: Date.now(),
    attachments: attachments.length > 0 ? attachments : undefined
  })
  const conversationInput = buildConversationInput()
  const assistantMessage: ChatMessage = {
    id: uid('assistant'),
    role: 'assistant',
    content: '正在等待模型响应...',
    createdAt: Date.now()
  }
  chatMessages.value.push(assistantMessage)
  await saveConversationSnapshot(originConversationId, chatMessages.value, generatedImages.value)

  let pendingTask: PendingImageTask | null = null
  try {
    const initialResponse = await sendResponsesRequest(apiKey, {
      model: selectedTextModel.value,
      instructions: imageToolInstructions,
      input: conversationInput,
      tools: [imageGenerationTool, imageEditingTool],
      tool_choice: 'auto'
    })
    ensureResponseSucceeded(initialResponse)

    const functionCalls = extractResponseFunctionCalls(initialResponse)
    if (functionCalls.length > maxImageToolCallsPerTurn) {
      throw new Error('当前 Playground 每轮最多只允许一次自动生图调用。')
    }

    if (functionCalls.length === 0) {
      updateChatMessage(assistantMessage.id, {
        content: extractResponseText(initialResponse) || '（模型没有返回文本）'
      })
      await refreshBalanceOnly()
      if (currentConversationId.value === originConversationId) {
        await persistConversationSnapshot()
      } else {
        const payload = await getConversation(originConversationId)
        await saveConversationSnapshot(
          originConversationId,
          replaceOrAppendMessage(payload.state.chatMessages || [], {
            ...assistantMessage,
            content: extractResponseText(initialResponse) || '（模型没有返回文本）'
          }),
          normalizeGeneratedImages(payload.state.generatedImages || [])
        )
      }
      return
    }

    const functionCall = functionCalls[0]
    if (functionCall.name !== 'generate_image' && functionCall.name !== 'edit_image') {
      throw new Error(`模型尝试调用未受支持的工具：${functionCall.name}`)
    }

    const toolArgs = parseGenerateImageToolArgs(functionCall)
    const shouldEditSourceImage = attachments.length > 0
    updateChatMessage(assistantMessage.id, {
      content: shouldEditSourceImage
        ? `模型已决定编辑你上传的图片，正在生成 ${toolArgs.size} 结果...`
        : `模型已决定调用生图工具，正在生成 ${toolArgs.size} 图片...`
    })

    imageBusy.value = true
    try {
      const { task_id } = await createImageTask(
        apiKey,
        buildImageTaskPayload(
          toolArgs.prompt,
          toolArgs.size,
          shouldEditSourceImage ? attachments : [],
          originConversationId,
          'chat',
          assistantMessage.id
        )
      )
      pendingTask = {
        taskId: task_id,
        conversationId: originConversationId,
        mode: shouldEditSourceImage ? 'edit' : 'generate',
        prompt: toolArgs.prompt,
        size: toolArgs.size,
        source: 'chat',
        assistantMessageId: assistantMessage.id
      }
      addPendingImageTask(pendingTask)
      updateChatMessage(assistantMessage.id, {
        content: shouldEditSourceImage
          ? `编辑任务已创建（${task_id.slice(0, 8)}），正在轮询结果...`
          : `生图任务已创建（${task_id.slice(0, 8)}），正在轮询结果...`
      })

      const task = await waitForImageTask(task_id, (nextTask) => {
        updateChatMessage(assistantMessage.id, {
          content: describeImageTaskStatus(nextTask.status)
        })
      })

      if (task.status === 'failed') {
        throw new Error(task.error || '图片生成失败')
      }
      const images = extractGeneratedImagesFromTask(task)
      if (images.length === 0) {
        throw new Error('图片生成成功，但响应中没有可展示的图片。')
      }
      await completePendingImageTask(pendingTask, task)
      removePendingImageTask(task_id)
      if (!errorMessage.value) {
        setSuccess(currentConversationId.value === originConversationId
          ? '模型已自动调用生图工具并完成生成。'
          : '后台生图任务已完成，结果已保存到原会话。')
      }
    } finally {
      imageBusy.value = false
    }
    await refreshBalanceOnly()
  } catch (error) {
    const message = error instanceof Error ? error.message : '对话请求失败'
    if (pendingTask) {
      removePendingImageTask(pendingTask.taskId)
      if (currentConversationId.value === pendingTask.conversationId) {
        await loadConversationById(pendingTask.conversationId)
      } else {
        await refreshConversationIndex()
      }
    } else if (currentConversationId.value === originConversationId) {
      chatMessages.value = chatMessages.value.filter((message) => message.id !== assistantMessage.id)
      await persistConversationSnapshot()
    } else {
      await archiveAssistantFailure(originConversationId, assistantMessage.id, message)
    }
    setError(message)
    imageBusy.value = false
  } finally {
    chatBusy.value = false
  }
}

function extractGeneratedImages(data: unknown, prompt: string, size: string): GeneratedImage[] {
  if (!data || typeof data !== 'object') {
    return []
  }
  const record = data as Record<string, any>
  if (!Array.isArray(record.data)) {
    return []
  }
  return record.data
    .map((item: Record<string, any>) => {
      const b64 = typeof item.b64_json === 'string' ? item.b64_json : ''
      const remoteUrl = typeof item.url === 'string' ? item.url : ''
      return {
        id: uid('image'),
        shareKey: uid('share'),
        prompt,
        size,
        dataUrl: b64 ? `data:image/png;base64,${b64}` : undefined,
        remoteUrl: remoteUrl || undefined,
        image_url: remoteUrl || undefined,
        createdAt: Date.now()
      } satisfies GeneratedImage
    })
    .filter((item: GeneratedImage) => item.dataUrl || item.image_url || item.remoteUrl)
}

function extractGeneratedImagesFromTask(task: ImageTaskStatus): GeneratedImage[] {
  return (task.result?.images || [])
    .map((item, index) => ({
      id: `${task.task_id}-${item.id || index + 1}`,
      shareKey: `${task.task_id}-${item.id || index + 1}`,
      prompt: item.prompt,
      size: item.size,
      dataUrl: item.data_url || undefined,
      remoteUrl: item.remote_url || undefined,
      image_url: item.image_url || undefined,
      createdAt: Date.now()
    } satisfies GeneratedImage))
    .filter((item) => item.dataUrl || item.image_url || item.remoteUrl)
}

async function archivePendingImageFailure(pendingTask: PendingImageTask, message: string): Promise<void> {
  const payload = await getConversation(pendingTask.conversationId)
  let nextMessages = payload.state.chatMessages || []
  const nextImages = normalizeGeneratedImages(payload.state.generatedImages || [])
  const failedMessage: ChatMessage = {
    id: pendingTask.assistantMessageId || uid('assistant-image-failed'),
    role: 'assistant',
    content: `图片任务失败：${message}`,
    createdAt: Date.now()
  }
  nextMessages = replaceOrAppendMessage(nextMessages, failedMessage)
  await saveConversationSnapshot(pendingTask.conversationId, nextMessages, nextImages)
}

async function archiveAssistantFailure(
  conversationId: string,
  assistantMessageId: string,
  message: string
): Promise<void> {
  const payload = await getConversation(conversationId)
  const nextMessages = replaceOrAppendMessage(payload.state.chatMessages || [], {
    id: assistantMessageId,
    role: 'assistant',
    content: `对话请求失败：${message}`,
    createdAt: Date.now()
  })
  await saveConversationSnapshot(conversationId, nextMessages, normalizeGeneratedImages(payload.state.generatedImages || []))
}

async function completePendingImageTask(
  pendingTask: PendingImageTask,
  task: ImageTaskStatus
): Promise<boolean> {
  if (task.status === 'failed') {
    if (currentConversationId.value === pendingTask.conversationId) {
      await loadConversationById(pendingTask.conversationId)
    } else {
      await refreshConversationIndex()
    }
    return false
  }

  const images = extractGeneratedImagesFromTask(task)
  if (images.length === 0) {
    if (currentConversationId.value === pendingTask.conversationId) {
      await loadConversationById(pendingTask.conversationId)
    } else {
      await refreshConversationIndex()
    }
    return false
  }

  if (currentConversationId.value === pendingTask.conversationId) {
    await loadConversationById(pendingTask.conversationId)
  } else {
    await refreshConversationIndex()
  }
  return true
}

async function monitorPendingImageTask(pendingTask: PendingImageTask): Promise<void> {
  if (activePendingTaskIds.has(pendingTask.taskId)) {
    return
  }
  activePendingTaskIds.add(pendingTask.taskId)
  try {
    const task = await waitForImageTask(pendingTask.taskId, (nextTask) => {
      if (pendingTask.source === 'chat' && currentConversationId.value === pendingTask.conversationId && pendingTask.assistantMessageId) {
        updateChatMessage(pendingTask.assistantMessageId, {
          content: describeImageTaskStatus(nextTask.status)
        })
      }
      if (pendingTask.source === 'direct' && currentConversationId.value === pendingTask.conversationId) {
        imageTaskLabel.value = describeImageTaskStatus(nextTask.status)
      }
    })
    const completed = await completePendingImageTask(pendingTask, task)
    removePendingImageTask(pendingTask.taskId)
    await refreshBalanceOnly()
    await refreshConversationIndex()
    if (completed) {
      setSuccess(currentConversationId.value === pendingTask.conversationId
        ? '图片任务已完成，结果已保存到当前会话。'
        : '后台图片任务已完成，结果已保存到原会话。')
    } else {
      setError('图片任务失败，详情已保存到原会话。')
    }
  } catch (error) {
    removePendingImageTask(pendingTask.taskId)
    const message = error instanceof Error ? error.message : '图片任务恢复失败'
    try {
      await archivePendingImageFailure(pendingTask, message)
    } catch {
      // If the task or conversation no longer exists, clearing the pending record prevents repeated failures.
    }
    setError(message)
  } finally {
    activePendingTaskIds.delete(pendingTask.taskId)
    if (currentConversationId.value === pendingTask.conversationId) {
      imageBusy.value = false
      imageTaskLabel.value = ''
    }
  }
}

function resumePendingImageTasks(): void {
  for (const pendingTask of readPendingImageTasks()) {
    void monitorPendingImageTask(pendingTask)
  }
}

async function handleGenerateImage(): Promise<void> {
  if (!currentConversationId.value) {
    await startNewConversation()
  }
  const originConversationId = currentConversationId.value
  const apiKey = selectedKeySecret.value
  const prompt = imagePrompt.value.trim()
  const sourceImages = imageSource.value ? [{ ...imageSource.value }] : []
  if (!apiKey) {
    setError('请先选择或创建一个 OpenAI 分组 API Key。')
    return
  }
  if (!prompt) {
    setError('请输入图片提示词。')
    return
  }

  imageBusy.value = true
  imageTaskLabel.value = sourceImages.length > 0 ? '正在创建图片编辑任务...' : '正在创建生图任务...'
  let pendingTask: PendingImageTask | null = null
  try {
    const { task_id } = await createImageTask(
      apiKey,
      buildImageTaskPayload(prompt, imageSize.value, sourceImages, originConversationId, 'direct')
    )
    pendingTask = {
      taskId: task_id,
      conversationId: originConversationId,
      mode: sourceImages.length > 0 ? 'edit' : 'generate',
      prompt,
      size: imageSize.value,
      source: 'direct'
    }
    addPendingImageTask(pendingTask)
    imageTaskLabel.value = sourceImages.length > 0
      ? `编辑任务已创建（${task_id.slice(0, 8)}），正在轮询结果...`
      : `任务已创建（${task_id.slice(0, 8)}），正在轮询结果...`

    const task = await waitForImageTask(task_id, (nextTask) => {
      imageTaskLabel.value = describeImageTaskStatus(nextTask.status)
    })
    if (task.status === 'failed') {
      throw new Error(task.error || '图片生成失败')
    }

    await completePendingImageTask(pendingTask, task)
    removePendingImageTask(task_id)
    imagePrompt.value = ''
    clearManualImageSource()
    setSuccess(currentConversationId.value === originConversationId
      ? (sourceImages.length > 0 ? '图片编辑完成，余额已刷新。' : '图片生成完成，余额已刷新。')
      : '后台图片任务已完成，结果已保存到原会话。')
    await refreshBalanceOnly()
  } catch (error) {
    if (pendingTask) {
      removePendingImageTask(pendingTask.taskId)
      if (currentConversationId.value === pendingTask.conversationId) {
        await loadConversationById(pendingTask.conversationId)
      } else {
        await refreshConversationIndex()
      }
    }
    setError(error instanceof Error ? error.message : (sourceImages.length > 0 ? '图片编辑失败' : '图片生成失败'))
  } finally {
    imageBusy.value = false
    imageTaskLabel.value = ''
  }
}

async function refreshBalanceOnly(): Promise<void> {
  try {
    profile.value = await getProfile()
  } catch {
    // A stale balance is less disruptive than replacing a successful response with an error.
  }
}

onMounted(async () => {
  initializeThemeMode()
  applyBranding()
  syncGalleryColumnCount()
  window.addEventListener('resize', syncGalleryColumnCount)
  await refreshGallery()
  setupGalleryObserver()
  if (isAuthenticated.value) {
    await refreshWorkspace()
    await ensureConversationLoaded()
    resumePendingImageTasks()
  }
})

onBeforeUnmount(() => {
  galleryObserver?.disconnect()
  window.removeEventListener('resize', syncGalleryColumnCount)
})
</script>

<template>
  <main class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <img class="brand-logo" :src="logoUrl" alt="MeteorAPI logo" loading="lazy" />
        <div>
          <strong>Image Lab</strong>
          <span>MeteorAPI</span>
        </div>
      </div>

      <button class="theme-toggle" type="button" :aria-label="themeMode === 'dark' ? '切换到白天模式' : '切换到黑夜模式'" @click="toggleThemeMode">
        <span>{{ themeMode === 'dark' ? '黑夜' : '白天' }}</span>
        <svg v-if="themeMode === 'dark'" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M17.7 6.3l-1.4 1.4M7.7 16.3l-1.4 1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" />
        </svg>
        <svg v-else viewBox="0 0 24 24" aria-hidden="true">
          <path d="M20 14.5A7.5 7.5 0 0 1 9.5 4a8.3 8.3 0 1 0 10.5 10.5Z" />
        </svg>
      </button>

      <nav class="side-nav" aria-label="Primary">
        <button :class="{ active: activeView === 'gallery' }" type="button" @click="activeView = 'gallery'">
          <span>画廊</span>
          <small>Public gallery</small>
        </button>
        <button :class="{ active: activeView === 'create' }" type="button" @click="activeView = 'create'">
          <span>创造</span>
          <small>Chat & create</small>
        </button>
      </nav>

      <div class="sidebar-account">
        <template v-if="isAuthenticated">
          <span>已登录</span>
          <strong>{{ displayName }}</strong>
          <small>{{ balanceLabel }}</small>
          <button class="ghost mini" type="button" @click="handleLogout">退出</button>
        </template>
        <template v-else>
          <span>游客模式</span>
          <strong>公共画廊可浏览</strong>
          <button class="primary mini" type="button" @click="activeView = 'create'">登录创造</button>
        </template>
      </div>
    </aside>

    <section v-if="activeView === 'gallery'" class="page gallery-page">
      <header class="page-header">
        <div>
          <p class="eyebrow">Public Gallery</p>
          <h1>共享灵感画廊</h1>
          <p>这里展示所有用户转发的生成图片，游客也可以浏览。</p>
        </div>
        <button class="ghost" type="button" :disabled="galleryBusy" @click="refreshGallery">
          {{ galleryBusy ? '刷新中...' : '刷新画廊' }}
        </button>
      </header>

      <div class="gallery-masonry" :style="{ '--gallery-columns': String(galleryColumnCount) }">
        <article v-if="galleryBusy" class="gallery-empty">
          正在读取公共画廊...
        </article>
        <article v-else-if="galleryItems.length === 0" class="gallery-empty">
          还没有公开分享的图片。登录后在创造页点击“转发”来发布第一张作品。
        </article>
        <template v-else>
          <div
            v-for="(column, columnIndex) in galleryColumns"
            :key="`gallery-column-${columnIndex}`"
            class="masonry-column"
          >
            <button
              v-for="item in column"
              :key="item.id"
              class="masonry-tile"
              type="button"
              :style="{ aspectRatio: imageAspectRatio(item.size) || '1 / 1' }"
              @click="openGalleryModal(item)"
            >
              <img
                :src="galleryImageUrl(item)"
                :alt="item.prompt"
                loading="lazy"
                decoding="async"
                @error="handleGalleryImageError($event, item)"
              />
            </button>
          </div>
        </template>
      </div>
      <div ref="gallerySentinel" class="gallery-sentinel" aria-hidden="true">
        <span v-if="galleryLoadingMore">正在加载更多...</span>
        <span v-else-if="!galleryHasMore && galleryItems.length > 0">已经到底了</span>
      </div>
    </section>

    <section v-else class="page create-page">
      <template v-if="!isAuthenticated">
        <section class="login-card panel">
          <div>
            <p class="eyebrow">Sign in</p>
            <h1>登录后开始创造</h1>
            <p>使用现有 sub2api 账号登录后，Playground 会读取余额和 OpenAI 分组 API Key。</p>
          </div>
          <form class="login-form" @submit.prevent="handleLogin">
            <label>
              邮箱
              <input v-model="email" type="email" autocomplete="email" placeholder="you@example.com" />
            </label>
            <label>
              密码
              <input v-model="password" type="password" autocomplete="current-password" placeholder="请输入密码" />
            </label>
            <button :disabled="loginBusy" type="submit">
              {{ loginBusy ? '登录中...' : '进入创造页' }}
            </button>
          </form>
        </section>
      </template>

      <section v-else class="creator-grid" :class="{ 'sessions-is-collapsed': sessionsCollapsed }">
        <aside class="sessions panel" :class="{ collapsed: sessionsCollapsed }">
          <template v-if="sessionsCollapsed">
            <button
              class="session-rail-button"
              type="button"
              aria-label="展开会话列表"
              @click="sessionsCollapsed = false"
            >
              <span>会话</span>
              <strong>{{ conversations.length }}</strong>
            </button>
            <button
              class="session-rail-new"
              type="button"
              aria-label="新建会话"
              :disabled="conversationBusy || conversationSaving"
              @click="startNewConversation"
            >
              +
            </button>
          </template>
          <template v-else>
            <div class="panel-header compact session-header">
              <div>
                <p class="eyebrow">Sessions</p>
                <h2>对话</h2>
                <span class="session-current">{{ currentConversation?.title || '暂无会话' }}</span>
              </div>
              <div class="session-header-actions">
                <button class="ghost mini" type="button" aria-label="收起会话列表" @click="sessionsCollapsed = true">
                  收起
                </button>
                <button class="mini" type="button" :disabled="conversationBusy || conversationSaving" @click="startNewConversation">
                  新建
                </button>
              </div>
            </div>

            <div class="session-list">
              <button
                v-for="conversation in conversations"
                :key="conversation.id"
                class="session-item"
                :class="{ active: conversation.id === currentConversationId }"
                type="button"
                :disabled="conversationBusy"
                @click="currentConversationId = conversation.id; handleConversationSelect()"
              >
                <strong>{{ conversation.title }}</strong>
                <span>{{ conversation.lastMessageAt || conversation.updatedAt }}</span>
              </button>
              <p v-if="conversations.length === 0" class="empty">暂无会话。</p>
            </div>
          </template>
        </aside>

        <section class="chat panel generator-card">
          <div class="creator-toolbar">
            <div class="creator-title">
              <p class="eyebrow">Create</p>
              <h2>创造空间</h2>
            </div>
            <div class="mode-tabs" role="tablist" aria-label="创造模式">
              <button
                type="button"
                role="tab"
                :aria-selected="createMode === 'chat'"
                :class="{ active: createMode === 'chat' }"
                @click="createMode = 'chat'"
              >
                对话生图
              </button>
              <button
                type="button"
                role="tab"
                :aria-selected="createMode === 'direct'"
                :class="{ active: createMode === 'direct' }"
                @click="createMode = 'direct'"
              >
                直接生图
              </button>
            </div>
            <div class="top-controls">
              <select v-model="selectedTextModel">
                <option v-for="model in textModels" :key="model" :value="model">{{ model }}</option>
              </select>
              <select v-model.number="selectedApiKeyId" :disabled="openAiApiKeys.length === 0">
                <option v-for="key in openAiApiKeys" :key="key.id" :value="key.id">
                  {{ key.name }} / {{ key.group?.name || 'OpenAI' }}
                </option>
              </select>
              <button class="ghost mini" type="button" :disabled="loadingApp" @click="refreshWorkspace">
                {{ loadingApp ? '刷新中...' : '刷新' }}
              </button>
              <button v-if="openAiApiKeys.length === 0" class="mini" type="button" @click="handleCreateApiKey">
                创建 Key
              </button>
            </div>
          </div>

          <template v-if="createMode === 'chat'">
            <div class="messages">
            <article v-if="conversationBusy" class="empty">
              正在加载会话...
            </article>
            <article v-else-if="chatMessages.length === 0" class="empty hero-empty">
              <strong>像使用 Codex 一样描述你想创造的画面。</strong>
              <span>可以输入提示词、粘贴截图，或让文字模型自动调用生图工具。</span>
            </article>
            <article
              v-for="message in chatMessages"
              :key="message.id"
              class="message"
              :class="message.role"
            >
              <div class="message-role">{{ message.role === 'user' ? '你' : '模型' }}</div>
              <p v-if="message.content">{{ message.content }}</p>
              <div v-if="messageImages(message).length > 0" class="message-images">
                <div
                  v-for="(image, index) in messageImages(message)"
                  :key="`${image.src}-${index}`"
                  class="message-image-card"
                >
                  <img
                    :src="image.src"
                    :alt="message.role === 'user' ? 'Uploaded image' : 'Generated image'"
                    loading="lazy"
                    @error="handleImageError($event, image.fallbackSrc)"
                  />
                  <button
                    class="ghost mini"
                    type="button"
                    @click="downloadImage(image.downloadSrc, message.content || `${message.role}-image`, index + 1)"
                  >
                    下载图片
                  </button>
                </div>
              </div>
            </article>
            </div>

            <form class="composer" @submit.prevent="handleSendChat">
            <input
              ref="composerFileInput"
              class="composer-file-input"
              type="file"
              accept="image/*"
              multiple
              @change="handleComposerFileChange"
            />
            <div class="composer-main">
              <div v-if="composerImages.length > 0" class="composer-attachments" aria-label="待发送图片">
                <article v-for="image in composerImages" :key="image.id" class="composer-attachment">
                  <button
                    class="composer-attachment-button"
                    type="button"
                    :aria-label="`查看图片 ${image.name}`"
                    @click="openComposerImageModal(image)"
                  >
                    <img :src="image.dataUrl" :alt="image.name" loading="lazy" />
                  </button>
                  <div class="composer-attachment-meta">
                    <span>{{ image.name }}</span>
                  </div>
                  <button
                    class="composer-attachment-remove"
                    type="button"
                    aria-label="移除图片"
                    @click.stop="removeComposerImage(image.id)"
                  >
                    ×
                  </button>
                </article>
              </div>
              <div class="composer-input-wrap">
                <textarea
                  v-model="chatInput"
                  rows="4"
                  placeholder="输入文字对话内容；明确要求画图时，模型会自动调用生图工具。"
                  @keydown="handleComposerKeydown"
                  @paste="handleComposerPaste"
                />
                <div class="composer-inline-actions">
                  <button
                    class="composer-icon-button"
                    type="button"
                    :disabled="chatBusy"
                    aria-label="添加图片"
                    title="添加图片"
                    @click="openComposerFilePicker"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  </button>
                  <button
                    class="composer-icon-button send"
                    type="submit"
                    :disabled="chatBusy || !selectedKeySecret"
                    :aria-label="chatBusy ? '发送中' : '发送对话'"
                    :title="chatBusy ? '发送中' : '发送对话'"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M5 12h13M13 6l6 6-6 6" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
            </form>
          </template>

          <form v-else class="image-form direct-form" @submit.prevent="handleGenerateImage">
            <input
              ref="imageSourceInput"
              class="composer-file-input"
              type="file"
              accept="image/*"
              @change="handleManualImageChange"
            />
            <div class="direct-grid">
              <label>
                图片尺寸
                <select v-model="imageSize">
                  <option v-for="size in imageSizes" :key="size" :value="size">{{ size }}</option>
                </select>
              </label>
              <div class="direct-upload">
                <span>原图</span>
                <div class="composer-tools">
                  <button class="secondary" type="button" :disabled="imageBusy" @click="openManualImagePicker">
                    {{ imageSource ? '更换原图' : '上传原图' }}
                  </button>
                  <button
                    v-if="imageSource"
                    class="ghost"
                    type="button"
                    :disabled="imageBusy"
                    @click="clearManualImageSource"
                  >
                    清除
                  </button>
                </div>
              </div>
            </div>
            <article v-if="imageSource" class="composer-preview direct-preview">
              <img :src="imageSource.dataUrl" :alt="imageSource.name" loading="lazy" />
              <div class="composer-preview-meta">
                <span>{{ imageSource.name }}</span>
                <span>编辑模式</span>
              </div>
            </article>
            <label class="direct-prompt">
              {{ imageSource ? '编辑指令' : '提示词' }}
              <textarea
                v-model="imagePrompt"
                rows="9"
                :placeholder="imageSource
                  ? '例如：保留主体构图，把背景改成雨夜霓虹街道'
                  : '例如：一张复古科幻电影海报，绿色霓虹、胶片颗粒'"
              />
            </label>
            <button :disabled="imageBusy || !selectedKeySecret" type="submit">
              {{ imageBusy ? imageTaskLabel || '处理中...' : (imageSource ? '编辑图片' : '生成图片') }}
            </button>
          </form>
        </section>

        <button
          class="images-fab"
          type="button"
          :aria-expanded="imagesPanelOpen"
          aria-controls="session-images-panel"
          @click="imagesPanelOpen = true"
        >
          图片
          <strong>{{ generatedImages.length }}</strong>
        </button>

        <div
          v-if="imagesPanelOpen"
          class="image-panel-scrim"
          aria-hidden="true"
          @click="imagesPanelOpen = false"
        ></div>

        <aside
          v-if="imagesPanelOpen"
          id="session-images-panel"
          class="image panel image-drawer"
          role="dialog"
          aria-modal="true"
          aria-label="当前会话图片"
        >
          <div class="panel-header">
            <div>
              <p class="eyebrow">Images</p>
              <h2>当前图片</h2>
            </div>
            <div class="image-drawer-actions">
              <span class="pill">{{ imageModel }}</span>
              <button class="ghost mini" type="button" aria-label="关闭图片栏" @click="imagesPanelOpen = false">
                关闭
              </button>
            </div>
          </div>

          <div class="local-gallery">
            <article
              v-for="(image, index) in generatedImages"
              :key="imageShareKey(image, index)"
              class="image-thumb"
              :class="{ active: selectedImageKey === imageShareKey(image, index) }"
              @click="openImageModal(image, index)"
            >
              <img
                v-if="imageSourceUrl(image)"
                :src="imagePreviewUrl(image, galleryPreviewWidth)"
                :alt="image.prompt"
                loading="lazy"
                @error="handleGeneratedImageError($event, image)"
              />
              <div class="thumb-overlay">
                <span>{{ image.size }}</span>
                <div class="image-actions" @click.stop>
                  <button
                    class="icon-button"
                    type="button"
                    aria-label="下载图片"
                    @click="downloadImage(imageDownloadUrl(image), image.prompt)"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M12 3v10m0 0 4-4m-4 4-4-4M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" />
                    </svg>
                  </button>
                  <button
                    class="icon-button"
                    type="button"
                    :class="{ shared: isImageShared(image, index) }"
                    :disabled="isImageSharing(image, index) || isImageShared(image, index)"
                    :aria-label="isImageShared(image, index) ? '已转发' : '转发到画廊'"
                    @click="handleShareImage(image, index)"
                  >
                    <svg v-if="isImageShared(image, index)" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="m5 12 4 4L19 6" />
                    </svg>
                    <svg v-else viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v13" />
                    </svg>
                  </button>
                </div>
              </div>
            </article>
            <p v-if="generatedImages.length === 0" class="empty">
              当前会话还没有生成图片。
            </p>
          </div>
        </aside>
      </section>
    </section>

    <div
      v-if="selectedImage || selectedGalleryItem"
      class="image-modal"
      role="dialog"
      aria-modal="true"
      aria-label="图片详情"
      @click.self="closeImageModal"
    >
      <article class="image-modal-card">
        <button class="modal-close" type="button" aria-label="关闭图片详情" @click="closeImageModal">×</button>
        <div class="modal-image-wrap">
          <img
            :src="selectedImage ? imagePreviewUrl(selectedImage, modalPreviewWidth) : (selectedGalleryItem ? galleryModalUrl(selectedGalleryItem) : '')"
            :alt="selectedImage?.prompt || selectedGalleryItem?.prompt"
            loading="lazy"
            @error="selectedImage
              ? handleGeneratedImageError($event, selectedImage)
              : (selectedGalleryItem ? handleGalleryImageError($event, selectedGalleryItem) : undefined)"
          />
          <div class="modal-actions">
            <button
              class="icon-button"
              type="button"
              aria-label="下载图片"
              @click="downloadImage(
                selectedImage ? imageDownloadUrl(selectedImage) : selectedGalleryItem?.originalUrl || '',
                selectedImage?.prompt || selectedGalleryItem?.prompt || 'gallery-image'
              )"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 3v10m0 0 4-4m-4 4-4-4M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" />
              </svg>
            </button>
            <button
              v-if="selectedImage"
              class="icon-button"
              type="button"
              :class="{ shared: isImageShared(selectedImage, selectedImageIndex) }"
              :disabled="isImageSharing(selectedImage, selectedImageIndex) || isImageShared(selectedImage, selectedImageIndex)"
              :aria-label="isImageShared(selectedImage, selectedImageIndex) ? '已转发' : '转发到画廊'"
              @click="handleShareImage(selectedImage, selectedImageIndex)"
            >
              <svg v-if="isImageShared(selectedImage, selectedImageIndex)" viewBox="0 0 24 24" aria-hidden="true">
                <path d="m5 12 4 4L19 6" />
              </svg>
              <svg v-else viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v13" />
              </svg>
            </button>
          </div>
        </div>
        <div class="modal-copy">
          <p class="eyebrow">Prompt</p>
          <h2>{{ selectedImage?.size || selectedGalleryItem?.size }}</h2>
          <div class="modal-prompt-scroll">
            <p>{{ selectedImage?.prompt || selectedGalleryItem?.prompt }}</p>
          </div>
          <small>
            {{ selectedImage
              ? new Date(selectedImage.createdAt).toLocaleString()
              : `${selectedGalleryItem?.sharedByName || '匿名用户'} · ${new Date(selectedGalleryItem?.createdAt || '').toLocaleString()}` }}
          </small>
        </div>
      </article>
    </div>

    <div
      v-if="selectedComposerImage"
      class="image-modal"
      role="dialog"
      aria-modal="true"
      aria-label="上传图片详情"
      @click.self="closeImageModal"
    >
      <article class="image-modal-card composer-image-modal-card">
        <button class="modal-close" type="button" aria-label="关闭图片详情" @click="closeImageModal">×</button>
        <div class="modal-image-wrap">
          <img
            :src="selectedComposerImage.dataUrl"
            :alt="selectedComposerImage.name"
            loading="lazy"
          />
          <div class="modal-actions">
            <button
              class="icon-button"
              type="button"
              aria-label="下载图片"
              @click="downloadImage(selectedComposerImage.dataUrl, selectedComposerImage.name || 'uploaded-image')"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 3v10m0 0 4-4m-4 4-4-4M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" />
              </svg>
            </button>
          </div>
        </div>
        <div class="modal-copy">
          <p class="eyebrow">Upload</p>
          <h2>{{ selectedComposerImage.name }}</h2>
          <div class="modal-prompt-scroll">
            <p>这张图片会作为当前对话的输入附件随消息一起发送。</p>
          </div>
          <small>{{ selectedComposerImage.mimeType }}</small>
        </div>
      </article>
    </div>

    <div v-if="errorMessage" class="toast error" role="alert">
      <span>{{ errorMessage }}</span>
      <button class="toast-close" type="button" aria-label="关闭错误提示" @click="errorMessage = ''">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
    </div>
    <div v-if="successMessage" class="toast success" role="status">
      <span>{{ successMessage }}</span>
      <button class="toast-close" type="button" aria-label="关闭成功提示" @click="successMessage = ''">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
    </div>
  </main>
</template>
