<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
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

const ENABLE_MOCK = import.meta.env.DEV

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
const mainSidebarCollapsed = ref(false)
const workTab = ref<'sessions' | 'chat' | 'images'>('chat')
const workSidebarOpen = ref(true)
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
const isMobileViewport = ref(false)
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
const selectedStandaloneImage = ref<StandalonePreviewImage | null>(null)
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

// -1 means "always show latest"; set to a concrete index by canvas nav arrows
const canvasImageIndex = ref(-1)
const latestGeneratedImage = computed(() => generatedImages.value[0] || null)

const displayImage = computed(() => {
  const imgs = generatedImages.value
  if (imgs.length === 0) return null
  const idx = canvasImageIndex.value
  return (idx >= 0 && idx < imgs.length) ? imgs[idx] : imgs[0]
})

const displayImageIndex = computed(() => {
  const imgs = generatedImages.value
  if (imgs.length === 0) return -1
  const idx = canvasImageIndex.value
  return (idx >= 0 && idx < imgs.length) ? idx : 0
})

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

interface StandalonePreviewImage {
  src: string
  fallbackSrc: string
  downloadSrc: string
  name: string
  description?: string
  mimeType?: string
  eyebrow?: string
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

function isImageLoading(image?: GeneratedImage | null): boolean {
  return image?.status === 'loading'
}

function taskImageIdPrefix(taskId: string): string {
  return `${taskId}-`
}

function stripLoadingImages(images: GeneratedImage[]): GeneratedImage[] {
  return images.filter((image) => !isImageLoading(image))
}

function createLoadingTaskImage(task: PendingImageTask): GeneratedImage {
  return {
    id: `${task.taskId}-loading`,
    shareKey: `${task.taskId}-loading`,
    taskId: task.taskId,
    status: 'loading',
    prompt: task.prompt,
    size: task.size,
    createdAt: Date.now()
  }
}

function upsertLoadingTaskImage(task: PendingImageTask): void {
  if (currentConversationId.value !== task.conversationId) {
    return
  }
  const prefix = taskImageIdPrefix(task.taskId)
  generatedImages.value = normalizeGeneratedImages([
    createLoadingTaskImage(task),
    ...generatedImages.value.filter((image) => !image.id.startsWith(prefix))
  ])
  canvasImageIndex.value = -1
}

function removeTaskImages(taskId: string): void {
  const prefix = taskImageIdPrefix(taskId)
  generatedImages.value = generatedImages.value.filter((image) => !image.id.startsWith(prefix))
  if (selectedImageKey.value.startsWith(prefix)) {
    selectedImageKey.value = ''
  }
}

function imageSourceUrl(image: GeneratedImage): string {
  if (isImageLoading(image)) {
    return ''
  }
  return image.image_url || image.dataUrl || image.remoteUrl || ''
}

function imageDownloadUrl(image: GeneratedImage): string {
  if (isImageLoading(image)) {
    return ''
  }
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

function imageAspectStyle(image?: GeneratedImage | null, fallback = '1 / 1'): Record<string, string> {
  return {
    aspectRatio: imageAspectRatio(image?.size) || fallback
  }
}

function loadingImageStyle(image?: GeneratedImage | null): Record<string, string> {
  const dimensions = parseImageSize(image?.size)
  const frameWidth = dimensions && dimensions.height > dimensions.width
    ? 'min(54%, 440px)'
    : dimensions && dimensions.width > dimensions.height
      ? 'min(78%, 820px)'
      : 'min(64%, 620px)'

  return {
    ...imageAspectStyle(image),
    '--loading-frame-width': frameWidth
  }
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

function syncViewportLayout(): void {
  const viewportWidth = window.innerWidth
  galleryColumnCount.value = resolveGalleryColumnCount(viewportWidth)
  isMobileViewport.value = viewportWidth <= 820
  if (isMobileViewport.value) {
    imagesPanelOpen.value = true
    sessionsCollapsed.value = false
  }
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

function findGeneratedImageByUrl(url: string): { image: GeneratedImage; index: number } | null {
  if (!url) return null
  for (let i = 0; i < generatedImages.value.length; i++) {
    const g = generatedImages.value[i]
    if (
      (g.image_url && g.image_url === url) ||
      (g.remoteUrl && g.remoteUrl === url) ||
      (g.dataUrl && g.dataUrl === url) ||
      (g.assetToken && url.includes(`/assets/${g.assetToken}`))
    ) {
      return { image: g, index: i }
    }
  }
  return null
}

function closeImageModal(): void {
  selectedImageKey.value = ''
  selectedGalleryItem.value = null
  selectedStandaloneImage.value = null
}

function openImageModal(image: GeneratedImage, index: number): void {
  if (isImageLoading(image)) {
    return
  }
  selectedImageKey.value = imageShareKey(image, index)
  selectedGalleryItem.value = null
  selectedStandaloneImage.value = null
}

function canvasNavigate(direction: -1 | 1): void {
  const count = generatedImages.value.length
  if (count < 2) return
  canvasImageIndex.value = (displayImageIndex.value + direction + count) % count
}

function openGalleryModal(item: GalleryItem): void {
  selectedGalleryItem.value = item
  selectedImageKey.value = ''
  selectedStandaloneImage.value = null
}

function openStandaloneImageModal(image: StandalonePreviewImage): void {
  selectedStandaloneImage.value = image
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

function restorePendingLoadingImages(conversationId: string): void {
  for (const pendingTask of readPendingImageTasks()) {
    if (pendingTask.conversationId === conversationId) {
      upsertLoadingTaskImage(pendingTask)
    }
  }
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
  const persistedImages = normalizeGeneratedImages(stripLoadingImages(nextGeneratedImages))
  const result = await saveConversationState(conversationId, {
    chatMessages: nextChatMessages,
    generatedImages: persistedImages
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
    restorePendingLoadingImages(payload.conversation.id)
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
  if (isImageLoading(image)) {
    return false
  }
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
  if (isImageLoading(image)) {
    return false
  }
  return sharedImageKeys.value.includes(imageShareKey(image, index)) ||
    galleryItems.value.some((item) => imageMatchesGalleryItem(image, item))
}

function isImageSharing(image: GeneratedImage, index = 0): boolean {
  if (isImageLoading(image)) {
    return false
  }
  return sharingImageKeys.value.includes(imageShareKey(image, index))
}

async function handleShareImage(image: GeneratedImage, index = 0): Promise<void> {
  if (isImageLoading(image)) {
    return
  }
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

function hasStreamingImageResult(task: ImageTaskStatus): boolean {
  return Boolean(task.result?.raw && typeof task.result.raw === 'object' && (task.result.raw as Record<string, unknown>).stream)
}

function mergeStreamingTaskImages(task: ImageTaskStatus): void {
  if (!currentConversationId.value || task.conversation_id !== currentConversationId.value) {
    return
  }
  const images = extractGeneratedImagesFromTask(task)
  if (images.length === 0) {
    return
  }

  const latestImage = images[images.length - 1]
  const taskImagePrefix = taskImageIdPrefix(task.task_id)
  generatedImages.value = normalizeGeneratedImages([
    latestImage,
    ...generatedImages.value.filter((image) => !image.id.startsWith(taskImagePrefix))
  ])
  canvasImageIndex.value = -1
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
    await sleep(1000)
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
      stream: true,
      partial_images: 2,
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
    stream: true,
    partial_images: 2,
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
      upsertLoadingTaskImage(pendingTask)
      updateChatMessage(assistantMessage.id, {
        content: shouldEditSourceImage
          ? `编辑任务已创建（${task_id.slice(0, 8)}），正在轮询结果...`
          : `生图任务已创建（${task_id.slice(0, 8)}），正在轮询结果...`
      })

      const task = await waitForImageTask(task_id, (nextTask) => {
        mergeStreamingTaskImages(nextTask)
        updateChatMessage(assistantMessage.id, {
          content: hasStreamingImageResult(nextTask)
            ? '正在接收流式图片预览...'
            : describeImageTaskStatus(nextTask.status)
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
      removeTaskImages(pendingTask.taskId)
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
        status: 'ready',
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
      taskId: task.task_id,
      status: 'ready',
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
  if (currentConversationId.value === pendingTask.conversationId) {
    imageBusy.value = true
    imageTaskLabel.value = pendingTask.mode === 'edit' ? '图片编辑任务处理中...' : '生图任务处理中...'
    upsertLoadingTaskImage(pendingTask)
  }
  try {
    const task = await waitForImageTask(pendingTask.taskId, (nextTask) => {
      mergeStreamingTaskImages(nextTask)
      if (pendingTask.source === 'chat' && currentConversationId.value === pendingTask.conversationId && pendingTask.assistantMessageId) {
        updateChatMessage(pendingTask.assistantMessageId, {
          content: hasStreamingImageResult(nextTask)
            ? '正在接收流式图片预览...'
            : describeImageTaskStatus(nextTask.status)
        })
      }
      if (pendingTask.source === 'direct' && currentConversationId.value === pendingTask.conversationId) {
        imageTaskLabel.value = hasStreamingImageResult(nextTask)
          ? '正在接收流式图片预览...'
          : describeImageTaskStatus(nextTask.status)
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
    removeTaskImages(pendingTask.taskId)
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
    upsertLoadingTaskImage(pendingTask)
    imageTaskLabel.value = sourceImages.length > 0
      ? `编辑任务已创建（${task_id.slice(0, 8)}），正在轮询结果...`
      : `任务已创建（${task_id.slice(0, 8)}），正在轮询结果...`

    const task = await waitForImageTask(task_id, (nextTask) => {
      mergeStreamingTaskImages(nextTask)
      imageTaskLabel.value = hasStreamingImageResult(nextTask)
        ? '正在接收流式图片预览...'
        : describeImageTaskStatus(nextTask.status)
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
      removeTaskImages(pendingTask.taskId)
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

watch(() => generatedImages.value.length, () => { canvasImageIndex.value = -1 })

function makeMockSvg(bg: string, label: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="${bg}"/><text x="256" y="256" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="26" fill="rgba(255,255,255,0.6)">${label}</text></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

const mockImages = ENABLE_MOCK ? [
  { id: 'mock-img-1', shareKey: 'mock-img-1', prompt: '一张复古科幻电影海报，绿色霓虹、胶片颗粒感，70年代风格', size: '1024x1024', dataUrl: makeMockSvg('#1a2744', 'Mock Image 1'), createdAt: Date.now() - 300000 },
  { id: 'mock-img-2', shareKey: 'mock-img-2', prompt: '赛博朋克城市夜景，紫色和橙色霓虹灯，层次丰富的建筑群', size: '1536x1024', dataUrl: makeMockSvg('#2d1f3d', 'Mock Image 2'), createdAt: Date.now() - 180000 },
  { id: 'mock-img-3', shareKey: 'mock-img-3', prompt: '水彩风格的太空飞船插画，浪漫柔和色调，宫崎骏画风', size: '1024x1536', dataUrl: makeMockSvg('#1f3d2d', 'Mock Image 3'), createdAt: Date.now() - 60000 },
] : []

const mockMessages = ENABLE_MOCK ? [
  { id: 'mock-u1', role: 'user' as const, content: '帮我生成一张复古科幻电影海报，需要有绿色霓虹灯效果和胶片颗粒感，整体风格参考70年代科幻片。', createdAt: Date.now() - 600000 },
  { id: 'mock-a1', role: 'assistant' as const, content: '好的！我来为你生成这张复古科幻电影海报。我会使用绿色霓虹灯效果配合胶片颗粒纹理，参考70年代科幻电影的视觉风格。', createdAt: Date.now() - 590000 },
  { id: 'mock-a1-img', role: 'assistant' as const, content: '图片已生成完成！海报采用了深色背景配合绿色霓虹，加入了复古胶片颗粒效果，整体氛围非常符合70年代科幻片风格。', createdAt: Date.now() - 580000 },
  { id: 'mock-u2', role: 'user' as const, content: '很棒！能不能再生成一张赛博朋克城市夜景，加入紫色和橙色的霓虹灯，要有层次感的建筑背景。', createdAt: Date.now() - 300000 },
  { id: 'mock-a2', role: 'assistant' as const, content: '当然可以！赛博朋克城市夜景是我的强项。我会在画面中融入紫色和橙色霓虹灯，搭配层次丰富的都市建筑群，营造出典型的赛博朋克氛围。', createdAt: Date.now() - 290000 },
  { id: 'mock-a2-img', role: 'assistant' as const, content: '赛博朋克城市夜景已生成！画面中包含了多层次的建筑剪影和霓虹灯效果，紫橙双色霓虹形成了很好的视觉对比。', createdAt: Date.now() - 280000 },
  { id: 'mock-u3', role: 'user' as const, content: '非常漂亮！最后再来一张水彩风格的太空飞船插画，要有浪漫柔和的色调，类似宫崎骏的画风。', createdAt: Date.now() - 120000 },
  { id: 'mock-a3-img', role: 'assistant' as const, content: '太空飞船水彩插画已完成！采用了柔和的水彩晕染效果，色调偏向浪漫的蓝紫粉渐变，飞船设计融入了宫崎骏式的有机曲线元素。', createdAt: Date.now() - 110000 },
  { id: 'mock-u4', role: 'user' as const, content: '三张图片效果都很棒！我特别喜欢第二张赛博朋克城市夜景，层次感非常丰富。能告诉我你是怎么处理霓虹灯发光效果的吗？', createdAt: Date.now() - 60000 },
  { id: 'mock-a4', role: 'assistant' as const, content: '谢谢！霓虹灯发光效果主要通过以下技巧实现：\n\n1. 核心发光：使用高饱和度、高亮度的纯色作为灯管颜色\n2. 光晕扩散：在核心颜色周围添加逐渐衰减的低不透明度区域，模拟真实光线散射\n3. 反射补光：对周围建筑和地面添加霓虹颜色的微弱反射，增强画面沉浸感\n4. 对比强化：将霓虹所在区域的周围背景压暗，让发光效果更突出\n\n这些技术结合起来，就能创造出层次丰富、真实感强的霓虹灯发光效果。', createdAt: Date.now() - 50000 },
] : []

onMounted(async () => {
  initializeThemeMode()
  applyBranding()
  syncViewportLayout()
  window.addEventListener('resize', syncViewportLayout)

  if (ENABLE_MOCK) {
    isAuthenticated.value = true
    activeView.value = 'create'
    profile.value = { id: 1, email: 'test@example.com', username: 'MockUser', role: 'user', status: 'active', balance: 9.52, concurrency: 5 }
    const mockConv = { id: 'mock-conv-1', title: '霓虹科幻场景', createdAt: new Date(Date.now() - 3600000).toISOString(), updatedAt: new Date().toISOString(), lastMessageAt: new Date().toISOString() }
    conversations.value = [mockConv]
    currentConversationId.value = mockConv.id
    chatMessages.value = mockMessages
    generatedImages.value = mockImages
    await refreshGallery()
    setupGalleryObserver()
    return
  }

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
  window.removeEventListener('resize', syncViewportLayout)
})
</script>

<template>
  <main class="app-shell" :class="{ 'sidebar-collapsed': mainSidebarCollapsed }">
    <aside class="sidebar">
      <div class="sidebar-top">
        <div class="brand">
          <img class="brand-logo" :src="logoUrl" alt="MeteorAPI logo" loading="lazy" />
          <div v-if="!mainSidebarCollapsed" class="brand-text">
            <strong>Image Lab</strong>
            <span>MeteorAPI</span>
          </div>
        </div>
        <button
          class="sidebar-collapse-btn"
          type="button"
          :aria-label="mainSidebarCollapsed ? '展开侧边栏' : '收起侧边栏'"
          :title="mainSidebarCollapsed ? '展开侧边栏' : '收起侧边栏'"
          @click="mainSidebarCollapsed = !mainSidebarCollapsed"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path v-if="mainSidebarCollapsed" d="M9 18l6-6-6-6" />
            <path v-else d="M15 18l-6-6 6-6" />
          </svg>
        </button>
      </div>

      <button
        class="theme-toggle"
        type="button"
        :aria-label="themeMode === 'dark' ? '切换到白天模式' : '切换到黑夜模式'"
        :title="themeMode === 'dark' ? '切换到白天模式' : '切换到黑夜模式'"
        @click="toggleThemeMode"
      >
        <span v-if="!mainSidebarCollapsed">{{ themeMode === 'dark' ? '黑夜' : '白天' }}</span>
        <svg v-if="themeMode === 'dark'" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M17.7 6.3l-1.4 1.4M7.7 16.3l-1.4 1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" />
        </svg>
        <svg v-else viewBox="0 0 24 24" aria-hidden="true">
          <path d="M20 14.5A7.5 7.5 0 0 1 9.5 4a8.3 8.3 0 1 0 10.5 10.5Z" />
        </svg>
      </button>

      <nav class="side-nav" aria-label="Primary">
        <button :class="{ active: activeView === 'gallery' }" type="button" title="画廊" @click="activeView = 'gallery'">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
          </svg>
          <span v-if="!mainSidebarCollapsed">画廊</span>
          <small v-if="!mainSidebarCollapsed">Public gallery</small>
        </button>
        <button :class="{ active: activeView === 'create' }" type="button" title="创造" @click="activeView = 'create'">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>
          </svg>
          <span v-if="!mainSidebarCollapsed">创造</span>
          <small v-if="!mainSidebarCollapsed">Chat & create</small>
        </button>
      </nav>

      <div v-if="!mainSidebarCollapsed" class="sidebar-account">
        <template v-if="isAuthenticated">
          <span>已登录</span>
          <strong>{{ displayName }}</strong>
          <small>{{ balanceLabel }}</small>
          <button class="ghost mini" type="button" @click="handleLogout">
            <svg viewBox="0 0 24 24" aria-hidden="true" style="width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;vertical-align:-1px;margin-right:3px">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>
            </svg>退出
          </button>
        </template>
        <template v-else>
          <span>游客模式</span>
          <strong>公共画廊可浏览</strong>
          <button class="primary mini" type="button" @click="activeView = 'create'">登录创造</button>
        </template>
      </div>
      <div v-else class="sidebar-account-mini">
        <div class="account-dot" :class="{ 'account-dot-active': isAuthenticated }" :title="isAuthenticated ? displayName : '游客模式'"></div>
      </div>
    </aside>

    <section v-if="activeView === 'gallery'" class="page gallery-page">
      <header class="page-header gallery-toolbar">
        <button
          class="ghost gallery-refresh-button"
          type="button"
          :disabled="galleryBusy"
          :aria-label="galleryBusy ? '刷新中' : '刷新画廊'"
          :title="galleryBusy ? '刷新中' : '刷新画廊'"
          @click="refreshGallery"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" :class="{ spinning: galleryBusy }">
            <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v6h-6" />
          </svg>
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

      <div v-else class="creator-layout" :class="{ 'work-sidebar-hidden': !workSidebarOpen }">

        <!-- Main Canvas -->
        <section class="creator-canvas">
          <div class="canvas-toolbar">
            <div class="mode-tabs" role="tablist" aria-label="创造模式">
              <button
                type="button" role="tab"
                :aria-selected="createMode === 'chat'"
                :class="{ active: createMode === 'chat' }"
                title="对话生图"
                @click="createMode = 'chat'"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>
                <span>对话</span>
              </button>
              <button
                type="button" role="tab"
                :aria-selected="createMode === 'direct'"
                :class="{ active: createMode === 'direct' }"
                title="直接生图"
                @click="createMode = 'direct'"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
                </svg>
                <span>直接</span>
              </button>
            </div>

            <div class="canvas-controls">
              <select v-if="createMode === 'chat'" v-model="selectedTextModel" title="文字模型">
                <option v-for="model in textModels" :key="model" :value="model">{{ model }}</option>
              </select>
              <select v-if="createMode === 'direct'" v-model="imageSize" title="图片尺寸">
                <option v-for="size in imageSizes" :key="size" :value="size">{{ size }}</option>
              </select>
              <select v-model.number="selectedApiKeyId" :disabled="openAiApiKeys.length === 0" title="API Key">
                <option v-for="key in openAiApiKeys" :key="key.id" :value="key.id">
                  {{ key.name }} / {{ key.group?.name || 'OpenAI' }}
                </option>
              </select>
              <button
                class="canvas-icon-btn"
                type="button"
                :disabled="loadingApp"
                :title="loadingApp ? '刷新中...' : '刷新'"
                @click="refreshWorkspace"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" :class="{ spinning: loadingApp }">
                  <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v6h-6" />
                </svg>
              </button>
              <button v-if="openAiApiKeys.length === 0" class="canvas-icon-btn" type="button" title="创建 API Key" @click="handleCreateApiKey">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/>
                </svg>
              </button>
            </div>

            <button
              class="canvas-icon-btn"
              type="button"
              :title="workSidebarOpen ? '关闭工作面板' : '打开工作面板'"
              @click="workSidebarOpen = !workSidebarOpen"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/>
              </svg>
            </button>
          </div>

          <!-- Canvas Main Area -->
          <div class="canvas-main">
            <!-- Chat mode: image canvas -->
            <template v-if="createMode === 'chat'">
              <div v-if="displayImage" class="canvas-image-display">
                <div
                  v-if="isImageLoading(displayImage)"
                  class="image-loading-frame canvas-loading-frame"
                  :style="loadingImageStyle(displayImage)"
                  role="status"
                  aria-live="polite"
                >
                  <div class="image-loading-content">
                    <div class="image-loading-spinner" aria-hidden="true"></div>
                    <span>生成中...</span>
                    <small>{{ displayImage.size }}</small>
                  </div>
                </div>
                <img
                  v-else
                  :src="imagePreviewUrl(displayImage, modalPreviewWidth)"
                  :alt="displayImage.prompt"
                  loading="lazy"
                  style="cursor:zoom-in"
                  @error="handleGeneratedImageError($event, displayImage)"
                  @click="openImageModal(displayImage, displayImageIndex)"
                />

                <button
                  v-if="!isImageLoading(displayImage) && generatedImages.length > 1"
                  class="canvas-nav-btn canvas-nav-prev"
                  type="button"
                  aria-label="上一张"
                  title="上一张"
                  @click.stop="canvasNavigate(-1)"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M15 18l-6-6 6-6"/>
                  </svg>
                </button>
                <button
                  v-if="!isImageLoading(displayImage) && generatedImages.length > 1"
                  class="canvas-nav-btn canvas-nav-next"
                  type="button"
                  aria-label="下一张"
                  title="下一张"
                  @click.stop="canvasNavigate(1)"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M9 18l6-6-6-6"/>
                  </svg>
                </button>

                <div v-if="!isImageLoading(displayImage) && generatedImages.length > 1" class="canvas-image-counter">
                  {{ displayImageIndex + 1 }} / {{ generatedImages.length }}
                </div>

                <div v-if="!isImageLoading(displayImage)" class="canvas-image-actions">
                  <button
                    class="icon-button"
                    type="button"
                    aria-label="下载图片"
                    title="下载"
                    @click.stop="downloadImage(imageDownloadUrl(displayImage), displayImage.prompt)"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M12 3v10m0 0 4-4m-4 4-4-4M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" />
                    </svg>
                  </button>
                  <button
                    class="icon-button"
                    type="button"
                    :class="{ shared: isImageShared(displayImage, displayImageIndex) }"
                    :disabled="isImageSharing(displayImage, displayImageIndex) || isImageShared(displayImage, displayImageIndex)"
                    :aria-label="isImageShared(displayImage, displayImageIndex) ? '已转发' : '转发到画廊'"
                    :title="isImageShared(displayImage, displayImageIndex) ? '已转发' : '转发'"
                    @click.stop="handleShareImage(displayImage, displayImageIndex)"
                  >
                    <svg v-if="isImageShared(displayImage, displayImageIndex)" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="m5 12 4 4L19 6" />
                    </svg>
                    <svg v-else viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v13" />
                    </svg>
                  </button>
                </div>
              </div>
              <div v-else class="canvas-empty">
                <svg viewBox="0 0 24 24" aria-hidden="true" style="width:48px;height:48px;opacity:0.25;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round">
                  <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>
                </svg>
                <strong>描述你想创造的画面</strong>
                <span>在右侧「对话」栏输入提示词，模型会自动调用生图工具。</span>
              </div>
            </template>

            <!-- Direct mode: form -->
            <template v-else>
              <form class="direct-canvas-form" @submit.prevent="handleGenerateImage">
                <input
                  ref="imageSourceInput"
                  class="composer-file-input"
                  type="file"
                  accept="image/*"
                  @change="handleManualImageChange"
                />
                <div class="direct-canvas-body">
                  <div class="direct-canvas-inputs">
                    <label>
                      {{ imageSource ? '编辑指令' : '提示词' }}
                      <textarea
                        v-model="imagePrompt"
                        rows="5"
                        :placeholder="imageSource
                          ? '例如：保留主体构图，把背景改成雨夜霓虹街道'
                          : '例如：一张复古科幻电影海报，绿色霓虹、胶片颗粒'"
                      />
                    </label>
                    <div class="direct-canvas-actions">
                      <button
                        class="canvas-icon-btn"
                        type="button"
                        :disabled="imageBusy"
                        :title="imageSource ? '更换原图' : '上传原图（编辑模式）'"
                        @click="openManualImagePicker"
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
                        </svg>
                      </button>
                      <button
                        v-if="imageSource"
                        class="canvas-icon-btn"
                        type="button"
                        :disabled="imageBusy"
                        title="清除原图"
                        @click="clearManualImageSource"
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M6 6l12 12M18 6 6 18" />
                        </svg>
                      </button>
                      <button class="canvas-submit-btn" :disabled="imageBusy || !selectedKeySecret" type="submit">
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M5 12h13M13 6l6 6-6 6" />
                        </svg>
                        {{ imageBusy ? (imageTaskLabel || '处理中...') : (imageSource ? '编辑' : '生成') }}
                      </button>
                    </div>
                  </div>
                  <div class="direct-canvas-previews">
                    <article v-if="imageSource" class="composer-preview">
                      <img :src="imageSource.dataUrl" :alt="imageSource.name" loading="lazy" />
                      <div class="composer-preview-meta">
                        <span>{{ imageSource.name }}</span>
                        <span>原图</span>
                      </div>
                    </article>
                    <div v-if="latestGeneratedImage" class="direct-result-wrap" :class="{ loading: isImageLoading(latestGeneratedImage) }">
                      <div
                        v-if="isImageLoading(latestGeneratedImage)"
                        class="image-loading-frame direct-loading-frame"
                        :style="loadingImageStyle(latestGeneratedImage)"
                        role="status"
                        aria-live="polite"
                      >
                        <div class="image-loading-content">
                          <div class="image-loading-spinner" aria-hidden="true"></div>
                          <span>生成中...</span>
                          <small>{{ latestGeneratedImage.size }}</small>
                        </div>
                      </div>
                      <img
                        v-else
                        :src="imagePreviewUrl(latestGeneratedImage, modalPreviewWidth)"
                        :alt="latestGeneratedImage.prompt"
                        loading="lazy"
                        style="cursor:zoom-in"
                        @click="openImageModal(latestGeneratedImage, 0)"
                      />
                    </div>
                  </div>
                </div>
              </form>
            </template>
          </div>
        </section>

        <!-- Right Work Sidebar -->
        <aside v-if="workSidebarOpen" class="work-sidebar panel">
          <div class="work-tabs">
            <button
              class="work-tab-btn"
              :class="{ active: workTab === 'sessions' }"
              type="button"
              title="会话列表"
              @click="workTab = 'sessions'"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 6h16M4 10h16M4 14h10"/>
              </svg>
            </button>
            <button
              class="work-tab-btn"
              :class="{ active: workTab === 'chat' }"
              type="button"
              title="对话"
              @click="workTab = 'chat'"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
            </button>
            <button
              class="work-tab-btn"
              :class="{ active: workTab === 'images' }"
              type="button"
              title="生成图片"
              @click="workTab = 'images'"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
              </svg>
            </button>
            <button
              class="work-tab-btn work-tab-close"
              type="button"
              title="关闭工作面板"
              @click="workSidebarOpen = false"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M15 18l-6-6 6-6"/>
              </svg>
            </button>
          </div>

          <!-- Sessions Tab -->
          <div v-if="workTab === 'sessions'" class="work-tab-content sessions-content">
            <div class="work-tab-header">
              <span class="eyebrow">Sessions</span>
              <button
                class="work-icon-btn"
                type="button"
                title="新建会话"
                :disabled="conversationBusy || conversationSaving"
                @click="startNewConversation"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 5v14M5 12h14"/>
                </svg>
              </button>
            </div>
            <div class="session-list work-scroll">
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
          </div>

          <!-- Chat Tab -->
          <div v-if="workTab === 'chat'" class="work-tab-content chat-content">
            <div class="messages work-scroll">
              <article v-if="conversationBusy" class="empty">正在加载会话...</article>
              <article v-else-if="chatMessages.length === 0" class="empty hero-empty">
                <strong>描述你想创造的画面。</strong>
                <span>可以输入提示词、粘贴截图，或让模型自动调用生图工具。</span>
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
                    <button
                      class="message-image-preview"
                      type="button"
                      :aria-label="`查看图片 ${index + 1}`"
                      @click="() => {
                        const found = findGeneratedImageByUrl(image.downloadSrc)
                        found
                          ? openImageModal(found.image, found.index)
                          : openStandaloneImageModal({ src: image.downloadSrc, fallbackSrc: image.fallbackSrc, downloadSrc: image.downloadSrc, name: message.content || `${message.role}-image-${index + 1}`, description: '消息中的图片预览。', eyebrow: 'Message' })
                      }"
                    >
                      <img
                        :src="image.src"
                        :alt="message.role === 'user' ? 'Uploaded image' : 'Generated image'"
                        loading="lazy"
                        @error="handleImageError($event, image.fallbackSrc)"
                      />
                    </button>
                    <button
                      class="icon-button"
                      type="button"
                      style="width:30px;height:30px"
                      aria-label="下载图片"
                      title="下载"
                      @click="downloadImage(image.downloadSrc, message.content || `${message.role}-image`, index + 1)"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M12 3v10m0 0 4-4m-4 4-4-4M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" />
                      </svg>
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
                      @click="openStandaloneImageModal({
                        src: image.dataUrl,
                        fallbackSrc: image.dataUrl,
                        downloadSrc: image.dataUrl,
                        name: image.name,
                        description: '这张图片会作为当前对话的输入附件随消息一起发送。',
                        mimeType: image.mimeType,
                        eyebrow: 'Attachment'
                      })"
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
                    >×</button>
                  </article>
                </div>
                <div class="composer-input-wrap">
                  <textarea
                    v-model="chatInput"
                    rows="3"
                    placeholder="输入提示词；明确要求画图时，模型会自动调用生图工具。"
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
                      :title="chatBusy ? '发送中' : '发送'"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M5 12h13M13 6l6 6-6 6" />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            </form>
          </div>

          <!-- Images Tab -->
          <div v-if="workTab === 'images'" class="work-tab-content images-content">
            <div class="work-tab-header">
              <span class="eyebrow">Images</span>
              <span class="pill">{{ imageModel }}</span>
            </div>
            <div class="local-gallery work-scroll">
              <article
                v-for="(image, index) in generatedImages"
                :key="imageShareKey(image, index)"
                class="image-thumb"
                :class="{ active: selectedImageKey === imageShareKey(image, index), loading: isImageLoading(image) }"
                :style="imageAspectStyle(image, '4 / 5')"
                @click="openImageModal(image, index)"
              >
                <div
                  v-if="isImageLoading(image)"
                  class="image-loading-frame thumb-loading-frame"
                  :style="loadingImageStyle(image)"
                  role="status"
                  aria-live="polite"
                >
                  <div class="image-loading-content compact">
                    <div class="image-loading-spinner" aria-hidden="true"></div>
                    <span>生成中...</span>
                  </div>
                </div>
                <img
                  v-else-if="imageSourceUrl(image)"
                  :src="imagePreviewUrl(image, galleryPreviewWidth)"
                  :alt="image.prompt"
                  loading="lazy"
                  @error="handleGeneratedImageError($event, image)"
                />
                <div class="thumb-overlay">
                  <span>{{ image.size }}</span>
                  <div v-if="!isImageLoading(image)" class="image-actions" @click.stop>
                    <button
                      class="icon-button"
                      type="button"
                      aria-label="下载图片"
                      title="下载"
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
                      :title="isImageShared(image, index) ? '已转发' : '转发'"
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
              <p v-if="generatedImages.length === 0" class="empty">当前会话还没有生成图片。</p>
            </div>
          </div>
        </aside>
      </div>
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
      v-if="selectedStandaloneImage"
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
            :src="selectedStandaloneImage.src"
            :alt="selectedStandaloneImage.name"
            loading="lazy"
            @error="handleImageError($event, selectedStandaloneImage.fallbackSrc)"
          />
          <div class="modal-actions">
            <button
              class="icon-button"
              type="button"
              aria-label="下载图片"
              @click="downloadImage(selectedStandaloneImage.downloadSrc, selectedStandaloneImage.name || 'uploaded-image')"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 3v10m0 0 4-4m-4 4-4-4M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" />
              </svg>
            </button>
          </div>
        </div>
        <div class="modal-copy standalone-modal-copy">
          <p class="eyebrow">{{ selectedStandaloneImage.eyebrow || 'Attachment' }}</p>
          <div class="standalone-copy-scroll">
            <p class="standalone-copy-text">{{ selectedStandaloneImage.name }}</p>
            <p v-if="selectedStandaloneImage.description" class="standalone-copy-description">
              {{ selectedStandaloneImage.description }}
            </p>
          </div>
          <small>{{ selectedStandaloneImage.mimeType || 'image/*' }}</small>
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
