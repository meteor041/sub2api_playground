<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import logoUrl from '../asset/logo.png'
import {
  batchUpdateLibraryItems,
  createConversation,
  createApiKey,
  createImageTask,
  createPptConversation,
  deleteLibraryItem,
  exportPptPresentation,
  getConversation,
  getImageTask,
  getProfile,
  hasAuthToken,
  listLibraryItems,
  listConversations,
  listApiKeys,
  listAvailableGroups,
  login,
  logout,
  listGalleryItems,
  updateLibraryItem,
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
  LibraryFacet,
  LibraryItem,
  PptPlanResult,
  PptExportRequest,
  PptSlidePlan,
  PptWorkspaceState,
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
const imageSizeOptions = [
  { value: '1024x1024', label: '1:1 方图 · 1024x1024' },
  { value: '1280x1024', label: '5:4 横图 · 1280x1024' },
  { value: '1024x1280', label: '4:5 竖图 · 1024x1280' },
  { value: '1408x1056', label: '4:3 横图 · 1408x1056' },
  { value: '1056x1408', label: '3:4 竖图 · 1056x1408' },
  { value: '1536x1024', label: '3:2 横图 · 1536x1024' },
  { value: '1024x1536', label: '2:3 竖图 · 1024x1536' },
  { value: '1536x864', label: '16:9 横图 · 1536x864' },
  { value: '864x1536', label: '9:16 竖图 · 864x1536' },
  { value: '1792x768', label: '21:9 宽屏 · 1792x768' },
  { value: '768x1792', label: '9:21 长竖屏 · 768x1792' }
]
const imageSizes = imageSizeOptions.map((option) => option.value)
const maxImageToolCallsPerTurn = 1
const ACTIVE_CREATE_CONVERSATION_KEY = 'playground_active_create_conversation_id'
const ACTIVE_PPT_CONVERSATION_KEY = 'playground_active_ppt_conversation_id'
const PENDING_IMAGE_TASKS_KEY = 'playground_pending_image_tasks'
const THEME_MODE_KEY = 'playground_theme_mode'
const PPT_DRAFT_KEY = 'playground_ppt_draft'
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
const activeView = ref<'gallery' | 'library' | 'create' | 'ppt'>('gallery')
const createMode = ref<'chat' | 'direct'>('chat')
const themeMode = ref<'light' | 'dark'>('light')
const toastAutoCloseMs = 5000
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
const libraryBatchSize = 24
const libraryItems = ref<LibraryItem[]>([])
const libraryBusy = ref(false)
const libraryLoadingMore = ref(false)
const libraryHasMore = ref(true)
const libraryNextOffset = ref(0)
const libraryQuery = ref('')
const libraryFolderFilter = ref('')
const libraryTagFilter = ref('')
const libraryFavoriteOnly = ref(false)
const libraryFolders = ref<LibraryFacet[]>([])
const libraryTags = ref<LibraryFacet[]>([])
const libraryFolderMenu = ref<HTMLDetailsElement | null>(null)
const libraryTagMenu = ref<HTMLDetailsElement | null>(null)
const librarySelectedIds = ref<string[]>([])
const libraryBatchFolder = ref('')
const libraryBatchTags = ref('')
const librarySelectionMode = ref(false)
const libraryTotal = ref(0)
const librarySentinel = ref<HTMLElement | null>(null)
let galleryObserver: IntersectionObserver | null = null
let libraryObserver: IntersectionObserver | null = null
let toastTimer: number | null = null
let librarySearchTimer: number | null = null
let conversationLoadRequestId = 0
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
const pptPrompt = ref('')
const pptStyle = ref('')
const pptDesignDetails = ref('')
const pptPageCount = ref(8)
const pptBusy = ref(false)
const pptTaskLabel = ref('')
const pptSelectedModel = ref(textModels[0])
const pptPlan = ref<PptPlanResult | null>(null)
const pptCurrentSlideIndex = ref(0)
const pptSlideEditPrompt = ref('')
const pptFormTitle = ref('')
const pptFormObjective = ref('')
const pptFormKeyPoints = ref('')
const pptFormLayout = ref('')
const pptFormVisualDirection = ref('')
const pptFormSpeakerNotes = ref('')
const pptFormGenerationPrompt = ref('')
const pptSidebarTab = ref<'settings' | 'tasks'>('settings')
const pptConfigPanelOpen = ref(false)
const pptEditorOpen = ref(false)
const pptPresentOpen = ref(false)
const pptImageGenerationConcurrency = 5

const imagePrompt = ref('')
const imageSize = ref(imageSizes[0])
const imageBusy = ref(false)
const imageTaskLabel = ref('')
const generatedImages = ref<GeneratedImage[]>([])
const selectedImageKey = ref('')
const selectedGalleryItem = ref<GalleryItem | null>(null)
const selectedLibraryItem = ref<LibraryItem | null>(null)
const selectedStandaloneImage = ref<StandalonePreviewImage | null>(null)
const imageSource = ref<ChatImageAttachment | null>(null)
const imageSourceInput = ref<HTMLInputElement | null>(null)
const localEditOpen = ref(false)
const localEditPrompt = ref('')
const localEditBrushSize = ref(48)
const localEditMaskHasMarks = ref(false)
const localEditDrawing = ref(false)
const localEditMaskCanvas = ref<HTMLCanvasElement | null>(null)
const localEditImageElement = ref<HTMLImageElement | null>(null)

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

function imagePromptGroupKey(image: GeneratedImage): string {
  return image.prompt.trim().replace(/\s+/g, ' ').toLowerCase()
}

const generatedImageGroups = computed<GeneratedImageGroup[]>(() => {
  const groups = new Map<string, GeneratedImageGroup>()

  generatedImages.value.forEach((image, index) => {
    const key = imagePromptGroupKey(image) || `ungrouped:${imageShareKey(image, index)}`
    const existing = groups.get(key)
    if (existing) {
      existing.images.push({ image, index })
      return
    }
    groups.set(key, {
      key,
      prompt: image.prompt,
      images: [{ image, index }]
    })
  })

  return Array.from(groups.values())
})

const comparableGeneratedImageGroups = computed(() => (
  generatedImageGroups.value.filter((group) => group.images.length > 1)
))

const displayImageCompareGroup = computed(() => {
  if (!displayImage.value || isImageLoading(displayImage.value)) {
    return null
  }
  const key = imagePromptGroupKey(displayImage.value)
  return comparableGeneratedImageGroups.value.find((group) => group.key === key) || null
})

const displayImageComparePosition = computed(() => {
  if (!displayImageCompareGroup.value) {
    return 0
  }
  const currentIndex = displayImageIndex.value
  const position = displayImageCompareGroup.value.images.findIndex((entry) => entry.index === currentIndex)
  return position >= 0 ? position + 1 : 1
})

const canSubmitLocalEdit = computed(() => (
  Boolean(selectedImage.value || selectedLibraryItem.value) &&
  Boolean(selectedKeySecret.value) &&
  localEditPrompt.value.trim().length > 0 &&
  localEditMaskHasMarks.value &&
  !imageBusy.value
))

const currentConversation = computed(() => (
  conversations.value.find((conversation) => conversation.id === currentConversationId.value) || null
))

const createTaskRecords = computed(() => conversations.value.filter((conversation) => conversation.workspaceType === 'create'))
const pptTaskRecords = computed(() => conversations.value.filter((conversation) => conversation.workspaceType === 'ppt'))

const pptSlides = computed(() => pptPlan.value?.slides || [])

const currentPptSlide = computed(() => {
  const slides = pptSlides.value
  if (slides.length === 0) {
    return null
  }
  const index = Math.min(Math.max(pptCurrentSlideIndex.value, 0), slides.length - 1)
  return slides[index] || null
})

const currentPptSlideImage = computed(() => {
  const imageId = currentPptSlide.value?.slideImageId
  if (!imageId) {
    return null
  }
  return generatedImages.value.find((image) => image.id === imageId) || null
})

const currentPptSlideImageIndex = computed(() => {
  const imageId = currentPptSlide.value?.slideImageId
  if (!imageId) {
    return -1
  }
  return generatedImages.value.findIndex((image) => image.id === imageId)
})

function imageForPptSlide(slide: PptSlidePlan): GeneratedImage | null {
  if (!slide.slideImageId) {
    return null
  }
  return generatedImages.value.find((image) => image.id === slide.slideImageId) || null
}

function slideImageOriginalUrl(slide: PptSlidePlan): string {
  const image = imageForPptSlide(slide)
  if (image) {
    return imageDownloadUrl(image)
  }
  return slide.slideImageUrl || ''
}

function slideImagePreviewUrl(slide: PptSlidePlan, width = modalPreviewWidth): string {
  const image = imageForPptSlide(slide)
  if (image) {
    return imagePreviewUrl(image, width)
  }
  const source = slide.slideImageUrl || ''
  return buildCompressedPreviewUrl(source, width) || source
}

function handlePptSlideImageError(event: Event, slide: PptSlidePlan): void {
  handleImageError(event, slideImageOriginalUrl(slide))
}

function previewUrlForPptSlide(slide: PptSlidePlan): string {
  return slideImagePreviewUrl(slide, modalPreviewWidth)
}

const pptHeroTitle = computed(() => (
  (pptPlan.value?.projectTitle || pptPrompt.value || 'AI图像生成SaaS')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 40) || 'AI图像生成SaaS'
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

interface ImageEditMask {
  name: string
  mimeType: string
  dataUrl: string
}

interface ImageTaskSourceImage {
  id?: string
  name: string
  mimeType: string
  dataUrl?: string
  assetToken?: string
  image_url?: string
  remoteUrl?: string
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

interface GeneratedImageGroupEntry {
  image: GeneratedImage
  index: number
}

interface GeneratedImageGroup {
  key: string
  prompt: string
  images: GeneratedImageGroupEntry[]
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

type PptDraftSnapshot = PptWorkspaceState

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

function buildDocumentFilename(seed: string, extension = '.html'): string {
  const safeSeed = sanitizeFilenamePart(seed) || 'playground-document'
  return `${safeSeed}${extension}`
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

function libraryImageUrl(item: LibraryItem): string {
  return item.thumbnailUrl || buildCompressedPreviewUrl(item.image_url || item.originalUrl || '', galleryPreviewWidth) || item.image_url || item.imageUrl || item.originalUrl || ''
}

function libraryModalUrl(item: LibraryItem): string {
  return buildCompressedPreviewUrl(item.image_url || item.originalUrl || '', modalPreviewWidth) || item.originalUrl || libraryImageUrl(item)
}

function libraryFallbackUrl(item: LibraryItem): string {
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

function clearLocalEditMask(): void {
  const canvas = localEditMaskCanvas.value
  const context = canvas?.getContext('2d')
  if (canvas && context) {
    context.clearRect(0, 0, canvas.width, canvas.height)
  }
  localEditMaskHasMarks.value = false
  localEditDrawing.value = false
}

function resetLocalEditState(): void {
  localEditOpen.value = false
  localEditPrompt.value = ''
  clearLocalEditMask()
}

function closeImageModal(): void {
  selectedImageKey.value = ''
  selectedGalleryItem.value = null
  selectedLibraryItem.value = null
  selectedStandaloneImage.value = null
  resetLocalEditState()
}

function openImageModal(image: GeneratedImage, index: number): void {
  if (isImageLoading(image)) {
    return
  }
  selectedImageKey.value = imageShareKey(image, index)
  selectedGalleryItem.value = null
  selectedLibraryItem.value = null
  selectedStandaloneImage.value = null
  resetLocalEditState()
}

function canvasNavigate(direction: -1 | 1): void {
  const count = generatedImages.value.length
  if (count < 2) return
  canvasImageIndex.value = (displayImageIndex.value + direction + count) % count
}

function selectCanvasImage(index: number): void {
  canvasImageIndex.value = index
}

function openGalleryModal(item: GalleryItem): void {
  selectedGalleryItem.value = item
  selectedImageKey.value = ''
  selectedLibraryItem.value = null
  selectedStandaloneImage.value = null
  resetLocalEditState()
}

function openLibraryModal(item: LibraryItem): void {
  selectedLibraryItem.value = item
  selectedImageKey.value = ''
  selectedGalleryItem.value = null
  selectedStandaloneImage.value = null
  resetLocalEditState()
}

function openStandaloneImageModal(image: StandalonePreviewImage): void {
  selectedStandaloneImage.value = image
  selectedImageKey.value = ''
  selectedGalleryItem.value = null
  selectedLibraryItem.value = null
  resetLocalEditState()
}

function handleGalleryImageError(event: Event, item: GalleryItem): void {
  handleImageError(event, galleryFallbackUrl(item))
}

function handleLibraryImageError(event: Event, item: LibraryItem): void {
  handleImageError(event, libraryFallbackUrl(item))
}

function syncLocalEditMaskCanvas(): boolean {
  const canvas = localEditMaskCanvas.value
  const image = localEditImageElement.value
  if (!canvas || !image || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    return false
  }

  if (canvas.width !== image.naturalWidth || canvas.height !== image.naturalHeight) {
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    localEditMaskHasMarks.value = false
  }
  return true
}

function resetLocalEditMaskCanvas(): void {
  if (syncLocalEditMaskCanvas()) {
    clearLocalEditMask()
  }
}

async function openLocalEditPanel(): Promise<void> {
  if (selectedImage.value && isImageLoading(selectedImage.value)) {
    return
  }
  if (!selectedImage.value && !selectedLibraryItem.value) {
    return
  }
  localEditOpen.value = true
  localEditPrompt.value = ''
  await nextTick()
  resetLocalEditMaskCanvas()
}

function handleLocalEditImageLoad(): void {
  if (localEditOpen.value) {
    resetLocalEditMaskCanvas()
  }
}

function localEditCanvasPoint(event: PointerEvent): { x: number; y: number } | null {
  const canvas = localEditMaskCanvas.value
  if (!canvas || !syncLocalEditMaskCanvas()) {
    return null
  }
  const rect = canvas.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) {
    return null
  }
  return {
    x: ((event.clientX - rect.left) / rect.width) * canvas.width,
    y: ((event.clientY - rect.top) / rect.height) * canvas.height
  }
}

function prepareLocalEditMaskContext(context: CanvasRenderingContext2D): void {
  const canvas = localEditMaskCanvas.value
  const rect = canvas?.getBoundingClientRect()
  const scale = canvas && rect && rect.width > 0 ? canvas.width / rect.width : 1
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.lineWidth = localEditBrushSize.value * scale
  context.strokeStyle = '#ff4f2e'
}

function startLocalEditMaskStroke(event: PointerEvent): void {
  if (!localEditOpen.value || imageBusy.value) {
    return
  }
  const canvas = localEditMaskCanvas.value
  const context = canvas?.getContext('2d')
  const point = localEditCanvasPoint(event)
  if (!canvas || !context || !point) {
    return
  }

  event.preventDefault()
  canvas.setPointerCapture(event.pointerId)
  localEditDrawing.value = true
  prepareLocalEditMaskContext(context)
  context.beginPath()
  context.moveTo(point.x, point.y)
  context.lineTo(point.x + 0.01, point.y + 0.01)
  context.stroke()
  localEditMaskHasMarks.value = true
}

function moveLocalEditMaskStroke(event: PointerEvent): void {
  if (!localEditDrawing.value || imageBusy.value) {
    return
  }
  const context = localEditMaskCanvas.value?.getContext('2d')
  const point = localEditCanvasPoint(event)
  if (!context || !point) {
    return
  }

  event.preventDefault()
  prepareLocalEditMaskContext(context)
  context.lineTo(point.x, point.y)
  context.stroke()
  localEditMaskHasMarks.value = true
}

function stopLocalEditMaskStroke(event?: PointerEvent): void {
  if (event && localEditMaskCanvas.value?.hasPointerCapture(event.pointerId)) {
    localEditMaskCanvas.value.releasePointerCapture(event.pointerId)
  }
  localEditDrawing.value = false
}

function createLocalEditMaskDataUrl(): string {
  const canvas = localEditMaskCanvas.value
  if (!canvas || !syncLocalEditMaskCanvas()) {
    throw new Error('遮罩画布尚未准备好。')
  }
  if (!localEditMaskHasMarks.value) {
    throw new Error('请先用画笔标记需要局部修改的区域。')
  }

  const output = document.createElement('canvas')
  output.width = canvas.width
  output.height = canvas.height
  const context = output.getContext('2d')
  if (!context) {
    throw new Error('无法生成遮罩图片。')
  }

  context.fillStyle = '#fff'
  context.fillRect(0, 0, output.width, output.height)
  context.globalCompositeOperation = 'destination-out'
  context.drawImage(canvas, 0, 0)
  return output.toDataURL('image/png')
}

function createLocalEditSourceImage(image: GeneratedImage): ImageTaskSourceImage {
  const source = imageFallbackUrl(image) || imageSourceUrl(image)
  const dataUrl = image.dataUrl?.startsWith('data:') ? image.dataUrl : undefined
  if (!dataUrl && !image.assetToken && !source && !image.image_url && !image.remoteUrl) {
    throw new Error('这张图片没有可用于局部修改的原图。')
  }

  return {
    id: uid('local-edit-source'),
    name: buildImageFilename(image.prompt || 'local-edit-source', 1, inferImageExtension(dataUrl || source || image.image_url || image.remoteUrl || '')),
    mimeType: dataUrl ? mimeTypeFromDataUrl(dataUrl) : 'image/png',
    dataUrl,
    assetToken: image.assetToken,
    image_url: image.image_url || source,
    remoteUrl: image.remoteUrl
  }
}

function createLibraryEditSourceImage(item: LibraryItem): ImageTaskSourceImage {
  const source = item.originalUrl || item.image_url || item.imageUrl || item.thumbnailUrl
  if (!source) {
    throw new Error('这张历史图片没有可用于局部修改的原图。')
  }

  return {
    id: uid('library-edit-source'),
    name: buildImageFilename(item.prompt || 'library-edit-source', 1, inferImageExtension(source)),
    mimeType: 'image/png',
    image_url: item.image_url || item.originalUrl || item.imageUrl,
    remoteUrl: item.originalUrl
  }
}

function reuseImageParameters(prompt: string, size: string): void {
  imagePrompt.value = prompt
  imageSize.value = imageSizes.includes(size) ? size : imageSize.value
  clearManualImageSource()
  createMode.value = 'direct'
  activeView.value = 'create'
  closeImageModal()
  setSuccess('已复用这张图片的提示词和尺寸，可直接再次生成。')
}

function handleReuseSelectedImageParameters(): void {
  if (selectedImage.value && !isImageLoading(selectedImage.value)) {
    reuseImageParameters(selectedImage.value.prompt, selectedImage.value.size)
    return
  }
  if (selectedLibraryItem.value) {
    reuseImageParameters(selectedLibraryItem.value.prompt, selectedLibraryItem.value.size)
  }
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

const libraryColumns = computed(() => {
  const columnCount = Math.max(galleryColumnCount.value, 1)
  const columns = Array.from({ length: columnCount }, () => [] as LibraryItem[])
  const columnHeights = Array.from({ length: columnCount }, () => 0)

  for (const item of libraryItems.value) {
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

const selectedLibraryIdsSet = computed(() => new Set(librarySelectedIds.value))

const selectedLibraryItems = computed(() => {
  const selectedIds = selectedLibraryIdsSet.value
  return libraryItems.value.filter((item) => selectedIds.has(item.id))
})

const hasLibraryFilters = computed(() => (
  libraryQuery.value.trim().length > 0 ||
  libraryFolderFilter.value.length > 0 ||
  libraryTagFilter.value.length > 0 ||
  libraryFavoriteOnly.value
))

const libraryFolderFilterSummary = computed(() => (
  libraryFolderFilter.value
    ? libraryFolderLabel(libraryFolderFilter.value === '__none' ? '' : libraryFolderFilter.value)
    : '全部文件夹'
))

const libraryTagFilterSummary = computed(() => (
  libraryTagFilter.value ? `#${libraryTagFilter.value}` : '全部标签'
))

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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function extractJsonBlock(value: string): string {
  const trimmed = value.trim()
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim()
  }

  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1)
  }
  return trimmed
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

function mimeTypeFromDataUrl(dataUrl: string): string {
  const match = /^data:([^;,]+)/i.exec(dataUrl)
  return match?.[1] || 'image/png'
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

function clearToastTimer(): void {
  if (toastTimer != null) {
    window.clearTimeout(toastTimer)
    toastTimer = null
  }
}

function normalizePptSlide(slide: Partial<PptSlidePlan>, fallbackPageNumber: number): PptSlidePlan {
  const keyPoints = Array.isArray(slide.keyPoints)
    ? slide.keyPoints.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 6)
    : []

  return {
    pageNumber: Number.isFinite(Number(slide.pageNumber)) ? Number(slide.pageNumber) : fallbackPageNumber,
    title: String(slide.title || `第 ${fallbackPageNumber} 页`).trim(),
    objective: String(slide.objective || '').trim(),
    keyPoints,
    layout: String(slide.layout || '').trim(),
    visualDirection: String(slide.visualDirection || '').trim(),
    speakerNotes: String(slide.speakerNotes || '').trim(),
    generationPrompt: String(slide.generationPrompt || '').trim(),
    slideImageId: typeof slide.slideImageId === 'string' ? slide.slideImageId : undefined,
    slideImageUrl: typeof slide.slideImageUrl === 'string' ? slide.slideImageUrl : undefined
  }
}

function normalizePptPlan(plan: Partial<PptPlanResult>): PptPlanResult {
  const slides = Array.isArray(plan.slides)
    ? plan.slides.map((slide, index) => normalizePptSlide(slide, index + 1))
    : []

  return {
    projectTitle: String(plan.projectTitle || '未命名 PPT').trim(),
    summary: String(plan.summary || '').trim(),
    targetAudience: String(plan.targetAudience || '').trim(),
    narrativeFlow: String(plan.narrativeFlow || '').trim(),
    visualSystem: String(plan.visualSystem || '').trim(),
    slides
  }
}

function normalizePptSlides(slides: Partial<PptSlidePlan>[]): PptSlidePlan[] {
  return slides.map((slide, index) => normalizePptSlide({
    ...slide,
    pageNumber: index + 1
  }, index + 1))
}

function currentPptWorkspaceState(): PptWorkspaceState {
  const normalizedPlan = pptPlan.value ? normalizePptPlan(pptPlan.value) : null
  return {
    prompt: pptPrompt.value,
    style: pptStyle.value,
    designDetails: pptDesignDetails.value,
    pageCount: normalizedPlan?.slides.length || Math.min(Math.max(Number(pptPageCount.value) || 0, 1), 30),
    model: pptSelectedModel.value,
    plan: normalizedPlan
  }
}

function applyPptWorkspaceState(state?: Partial<PptWorkspaceState> | null): void {
  const normalizedPlan = state?.plan ? normalizePptPlan(state.plan) : null
  pptPrompt.value = typeof state?.prompt === 'string' ? state.prompt : ''
  pptStyle.value = typeof state?.style === 'string' ? state.style : ''
  pptDesignDetails.value = typeof state?.designDetails === 'string' ? state.designDetails : ''
  pptPageCount.value = normalizedPlan?.slides.length
    ? normalizedPlan.slides.length
    : (Number.isFinite(Number(state?.pageCount))
      ? Math.min(Math.max(Number(state?.pageCount), 1), 30)
      : 8)
  pptSelectedModel.value = typeof state?.model === 'string' && textModels.includes(state.model)
    ? state.model
    : textModels[0]
  pptPlan.value = normalizedPlan
  pptCurrentSlideIndex.value = 0
}

function buildMockPptPlan(prompt: string, style: string, details: string, pageCount: number): PptPlanResult {
  const visualSystem = style || '现代商务风，信息层级清晰，深浅对比明确'
  const summary = details || '每页只讲一个重点，标题直接，适合口头演示'
  const titles = [
    '封面与主题定位',
    '问题背景与行业痛点',
    '核心方案概览',
    '产品能力拆解',
    '关键场景演示',
    '竞争优势与差异化',
    '商业模式与增长路径',
    '实施计划与资源需求',
    '阶段成果与风险控制',
    '总结与行动号召'
  ]

  return {
    projectTitle: `${prompt.slice(0, 18) || '演示文稿'}方案`,
    summary,
    targetAudience: '决策者、客户或内部评审团队',
    narrativeFlow: '先讲背景和问题，再讲解决方案与能力，最后落到价值、执行和结论。',
    visualSystem,
    slides: Array.from({ length: pageCount }, (_, index) => ({
      pageNumber: index + 1,
      title: titles[index] || `第 ${index + 1} 页内容`,
      objective: `围绕“${prompt.slice(0, 24) || '当前主题'}”推进第 ${index + 1} 个关键信息点。`,
      keyPoints: [
        '突出一个核心结论',
        '用 3 到 4 个信息块承载主要内容',
        '标题、数据和视觉焦点明确区分'
      ],
      layout: index === 0
        ? '大标题 + 副标题 + 视觉主图的封面布局'
        : '左侧标题与要点，右侧图表/示意图/数据卡片的双栏布局',
      visualDirection: visualSystem,
      speakerNotes: `这一页重点解释${titles[index] || `第 ${index + 1} 页`}，控制在 30 到 60 秒内讲清楚。`,
      generationPrompt: [
        `制作 PPT 第 ${index + 1} 页：${titles[index] || `第 ${index + 1} 页内容`}`,
        `目标：${prompt}`,
        `页面目的：突出这一页的单一重点，并与整套风格保持一致。`,
        `版式：${index === 0 ? '封面式排版' : '双栏信息排版'}。`,
        `风格：${visualSystem}。`,
        `细节要求：${summary}。`,
        '请给出适合正式演示的标题层级、配色、图表或插画建议，并保证可直接落地制作。'
      ].join(' ')
    }))
  }
}

function buildMockPptSlide(pageNumber: number, instruction: string, titleSeed: string): PptSlidePlan {
  const detail = instruction.trim() || '延续整套风格并强化这一页的信息表达'
  return normalizePptSlide({
    pageNumber,
    title: titleSeed || `第 ${pageNumber} 页内容`,
    objective: `围绕当前主题补充第 ${pageNumber} 页的关键信息。`,
    keyPoints: [
      '保留统一视觉语言',
      '只突出一个主结论',
      '加入适当的数据或示意图支撑'
    ],
    layout: '标题区 + 重点内容区 + 辅助视觉区的三段式布局',
    visualDirection: pptPlan.value?.visualSystem || pptStyle.value || '现代商务风',
    speakerNotes: '这一页用于承接上下文，强调单页重点，控制讲述节奏。',
    generationPrompt: `制作 PPT 第 ${pageNumber} 页，主题是：${titleSeed || `第 ${pageNumber} 页内容`}。补充要求：${detail}。保持与整套 PPT 一致的视觉系统和叙事方式。`
  }, pageNumber)
}

async function persistPptConversationState(): Promise<void> {
  if (!currentConversationId.value) {
    return
  }
  await saveConversationSnapshot(currentConversationId.value, chatMessages.value, generatedImages.value)
}

function persistPptDraft(): void {
  const snapshot: PptDraftSnapshot = currentPptWorkspaceState()
  localStorage.setItem(PPT_DRAFT_KEY, JSON.stringify(snapshot))
}

function restorePptDraft(): void {
  try {
    const parsed = JSON.parse(localStorage.getItem(PPT_DRAFT_KEY) || 'null') as PptDraftSnapshot | null
    if (!parsed || typeof parsed !== 'object') {
      return
    }
    applyPptWorkspaceState(parsed)
  } catch {
    // Ignore malformed local state.
  }
}

function navigatePptSlide(direction: -1 | 1): void {
  if (pptSlides.value.length < 2) {
    return
  }
  pptCurrentSlideIndex.value = (pptCurrentSlideIndex.value + direction + pptSlides.value.length) % pptSlides.value.length
}

function selectPptSlide(index: number): void {
  if (index < 0 || index >= pptSlides.value.length) {
    return
  }
  pptCurrentSlideIndex.value = index
}

function syncPptSlideForm(slide: PptSlidePlan | null): void {
  pptFormTitle.value = slide?.title || ''
  pptFormObjective.value = slide?.objective || ''
  pptFormKeyPoints.value = slide?.keyPoints.join('\n') || ''
  pptFormLayout.value = slide?.layout || ''
  pptFormVisualDirection.value = slide?.visualDirection || ''
  pptFormSpeakerNotes.value = slide?.speakerNotes || ''
  pptFormGenerationPrompt.value = slide?.generationPrompt || ''
}

function editablePptKeyPoints(): string[] {
  const items = pptFormKeyPoints.value
    .split(/\n+/)
    .map((item) => item.trim())
    .filter(Boolean)
  return items.length > 0 ? items : ['']
}

function setPptKeyPoints(items: string[]): void {
  pptFormKeyPoints.value = items
    .map((item) => item.trim())
    .filter(Boolean)
    .join('\n')
}

function updatePptKeyPoint(index: number, value: string): void {
  const items = editablePptKeyPoints()
  items[index] = value
  setPptKeyPoints(items)
  schedulePptSlideAutoSave()
}

function handlePptKeyPointInput(index: number, event: Event): void {
  const target = event.target as HTMLTextAreaElement | null
  updatePptKeyPoint(index, target?.value || '')
}

function addPptKeyPoint(): void {
  setPptKeyPoints([...editablePptKeyPoints(), ''])
}

function removePptKeyPoint(index: number): void {
  const items = editablePptKeyPoints()
  items.splice(index, 1)
  setPptKeyPoints(items)
  schedulePptSlideAutoSave()
}

function openPptSlideEditor(index: number): void {
  selectPptSlide(index)
  syncPptSlideForm(pptSlides.value[index] || null)
  pptEditorOpen.value = true
}

function closePptSlideEditor(): void {
  clearPptAutoSaveTimer()
  pptEditorOpen.value = false
}

function openPptPresentation(): void {
  if (!pptPlan.value || pptSlides.value.length === 0) {
    return
  }
  pptPresentOpen.value = true
}

function closePptPresentation(): void {
  pptPresentOpen.value = false
}

function clearPptAutoSaveTimer(): void {
  if (pptAutoSaveTimer != null) {
    window.clearTimeout(pptAutoSaveTimer)
    pptAutoSaveTimer = null
  }
}

function canPersistCurrentPptSlideDraft(): boolean {
  return Boolean(
    pptPlan.value &&
    currentPptSlide.value &&
    pptFormTitle.value.trim() &&
    pptFormObjective.value.trim() &&
    pptFormLayout.value.trim() &&
    pptFormVisualDirection.value.trim() &&
    pptFormSpeakerNotes.value.trim() &&
    pptFormGenerationPrompt.value.trim() &&
    editablePptKeyPoints().some((item) => item.trim())
  )
}

function schedulePptSlideAutoSave(): void {
  clearPptAutoSaveTimer()
  if (!pptEditorOpen.value || pptBusy.value || !canPersistCurrentPptSlideDraft()) {
    return
  }
  pptAutoSaveTimer = window.setTimeout(() => {
    pptAutoSaveTimer = null
    void handleSaveCurrentPptSlide({ silent: true })
  }, 700)
}

async function copyText(value: string, successText: string): Promise<void> {
  if (!value.trim()) {
    setError('当前没有可复制的内容。')
    return
  }

  try {
    await navigator.clipboard.writeText(value)
    setSuccess(successText)
  } catch {
    setError('复制失败，请检查浏览器权限。')
  }
}

function closeToast(): void {
  clearToastTimer()
  errorMessage.value = ''
  successMessage.value = ''
}

function scheduleToastAutoClose(): void {
  clearToastTimer()
  toastTimer = window.setTimeout(() => {
    errorMessage.value = ''
    successMessage.value = ''
    toastTimer = null
  }, toastAutoCloseMs)
}

function setError(message: string): void {
  errorMessage.value = message
  successMessage.value = ''
  scheduleToastAutoClose()
}

function setSuccess(message: string): void {
  successMessage.value = message
  errorMessage.value = ''
  scheduleToastAutoClose()
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

function workspaceConversationStorageKey(workspaceType: 'create' | 'ppt'): string {
  return workspaceType === 'ppt' ? ACTIVE_PPT_CONVERSATION_KEY : ACTIVE_CREATE_CONVERSATION_KEY
}

function readActiveConversationId(workspaceType: 'create' | 'ppt'): string {
  return localStorage.getItem(workspaceConversationStorageKey(workspaceType)) || ''
}

function clearActiveConversationIds(): void {
  localStorage.removeItem(ACTIVE_CREATE_CONVERSATION_KEY)
  localStorage.removeItem(ACTIVE_PPT_CONVERSATION_KEY)
}

function persistActiveConversationId(conversationId: string, workspaceType: 'create' | 'ppt'): void {
  currentConversationId.value = conversationId
  const storageKey = workspaceConversationStorageKey(workspaceType)
  if (conversationId) {
    localStorage.setItem(storageKey, conversationId)
  } else {
    localStorage.removeItem(storageKey)
  }
}

function clearLoadedConversationState(): void {
  chatMessages.value = []
  generatedImages.value = []
  applyPptWorkspaceState(null)
  selectedImageKey.value = ''
  sharedImageKeys.value = []
}

function resetConversationState(): void {
  conversations.value = []
  currentConversationId.value = ''
  clearActiveConversationIds()
  chatMessages.value = []
  generatedImages.value = []
  applyPptWorkspaceState(null)
  selectedImageKey.value = ''
  sharedImageKeys.value = []
  localStorage.removeItem(PENDING_IMAGE_TASKS_KEY)
}

function resetLibraryState(): void {
  libraryItems.value = []
  libraryFolders.value = []
  libraryTags.value = []
  librarySelectedIds.value = []
  librarySelectionMode.value = false
  libraryBatchFolder.value = ''
  libraryBatchTags.value = ''
  libraryNextOffset.value = 0
  libraryHasMore.value = true
  libraryTotal.value = 0
  selectedLibraryItem.value = null
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
    if (pendingTask.conversationId !== conversationId) {
      continue
    }
    const prefix = taskImageIdPrefix(pendingTask.taskId)
    const hasResolvedTaskImage = generatedImages.value.some((image) => (
      image.id.startsWith(prefix) &&
      !isImageLoading(image) &&
      Boolean(image.dataUrl || image.image_url || image.remoteUrl || image.assetToken)
    ))
    if (!hasResolvedTaskImage) {
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
  nextGeneratedImages: GeneratedImage[],
  nextPptState: PptWorkspaceState | null = currentConversationId.value === conversationId
    ? currentPptWorkspaceState()
    : null,
  workspaceType: 'create' | 'ppt' = conversationId === currentConversationId.value
    ? (currentConversation.value?.workspaceType || (activeView.value === 'ppt' ? 'ppt' : 'create'))
    : 'create'
): Promise<void> {
  const persistedImages = normalizeGeneratedImages(stripLoadingImages(nextGeneratedImages))
  const result = await saveConversationState(conversationId, {
    workspaceType,
    chatMessages: nextChatMessages,
    generatedImages: persistedImages,
    pptState: nextPptState
  })
  conversations.value = sortConversations(conversations.value.map((conversation) => (
    conversation.id === conversationId
      ? {
        ...conversation,
        title: result.title,
        workspaceType,
        updatedAt: result.savedAt,
        lastMessageAt: result.savedAt
      }
      : conversation
  )))
  if (currentConversationId.value === conversationId) {
    chatMessages.value = nextChatMessages
    generatedImages.value = normalizeGeneratedImages(nextGeneratedImages)
    applyPptWorkspaceState(nextPptState)
    selectedImageKey.value = ''
    sharedImageKeys.value = []
  }
}

async function refreshConversationIndex(): Promise<void> {
  conversations.value = sortConversations(await listConversations())
}

async function loadConversationById(conversationId: string): Promise<void> {
  const requestId = ++conversationLoadRequestId
  conversationBusy.value = true
  try {
    const payload = await getConversation(conversationId)
    if (requestId !== conversationLoadRequestId) {
      return
    }
    const workspaceType = payload.conversation.workspaceType === 'ppt' ? 'ppt' : 'create'
    conversations.value = sortConversations(conversations.value.map((conversation) => (
      conversation.id === payload.conversation.id
        ? {
          ...conversation,
          ...payload.conversation,
          workspaceType
        }
        : conversation
    )))
    persistActiveConversationId(payload.conversation.id, workspaceType)
    chatMessages.value = payload.state.chatMessages || []
    generatedImages.value = normalizeGeneratedImages(payload.state.generatedImages || [])
    applyPptWorkspaceState(payload.state.pptState || null)
    selectedImageKey.value = ''
    sharedImageKeys.value = []
    restorePendingLoadingImages(payload.conversation.id)
  } finally {
    if (requestId === conversationLoadRequestId) {
      conversationBusy.value = false
    }
  }
}

async function startNewConversation(): Promise<void> {
  conversationBusy.value = true
  try {
    const created = await createConversation()
    conversations.value = sortConversations([created, ...conversations.value.filter((item) => item.id !== created.id)])
    persistActiveConversationId(created.id, 'create')
    chatMessages.value = []
    generatedImages.value = []
    applyPptWorkspaceState(null)
    selectedImageKey.value = ''
    sharedImageKeys.value = []
  } finally {
    conversationBusy.value = false
  }
}

async function startNewPptTask(): Promise<void> {
  conversationBusy.value = true
  try {
    const created = await createPptConversation('新 PPT 任务')
    conversations.value = sortConversations([created, ...conversations.value.filter((item) => item.id !== created.id)])
    persistActiveConversationId(created.id, 'ppt')
    chatMessages.value = []
    generatedImages.value = []
    applyPptWorkspaceState(null)
    pptSlideEditPrompt.value = ''
    pptEditorOpen.value = false
    pptConfigPanelOpen.value = true
    selectedImageKey.value = ''
    sharedImageKeys.value = []
    activeView.value = 'ppt'
    setSuccess('已创建新的 PPT 任务。')
  } catch (error) {
    setError(error instanceof Error ? error.message : '创建 PPT 任务失败')
  } finally {
    conversationBusy.value = false
  }
}

async function handlePptTaskSelect(conversationId: string): Promise<void> {
  if (!conversationId) {
    return
  }
  persistActiveConversationId(conversationId, 'ppt')
  activeView.value = 'ppt'
  pptEditorOpen.value = false
  await handleConversationSelect()
}

async function ensureConversationLoaded(workspaceType: 'create' | 'ppt' = 'create'): Promise<void> {
  await refreshConversationIndex()

  const records = workspaceType === 'ppt' ? pptTaskRecords.value : createTaskRecords.value
  const savedConversationId = readActiveConversationId(workspaceType)
  const preferredConversation = records.find((item) => item.id === savedConversationId) ||
    records[0] ||
    null

  if (!preferredConversation) {
    if (workspaceType === 'ppt') {
      await startNewPptTask()
    } else {
      await startNewConversation()
    }
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

async function handleCreateConversationSelect(conversationId: string): Promise<void> {
  if (!conversationId) {
    return
  }
  persistActiveConversationId(conversationId, 'create')
  activeView.value = 'create'
  await handleConversationSelect()
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
    await ensureConversationLoaded(activeView.value === 'ppt' ? 'ppt' : 'create')
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
  resetLibraryState()
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
    if (activeView.value === 'gallery') {
      await nextTick()
      setupGalleryObserver()
    }
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

function isGallerySentinelNearViewport(): boolean {
  if (activeView.value !== 'gallery' || !gallerySentinel.value) {
    return false
  }
  const rect = gallerySentinel.value.getBoundingClientRect()
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight
  return rect.top <= viewportHeight + 180 && rect.bottom >= -180
}

async function loadVisibleGalleryPages(): Promise<void> {
  await nextTick()
  let loadCount = 0
  while (
    galleryHasMore.value &&
    !galleryBusy.value &&
    !galleryLoadingMore.value &&
    isGallerySentinelNearViewport() &&
    loadCount < 6
  ) {
    loadCount += 1
    await loadMoreGallery()
    await nextTick()
  }
}

function setupGalleryObserver(): void {
  galleryObserver?.disconnect()
  if (!gallerySentinel.value) {
    return
  }
  galleryObserver = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) {
      void loadVisibleGalleryPages()
    }
  }, {
    rootMargin: '40px 0px'
  })
  galleryObserver.observe(gallerySentinel.value)
  void loadVisibleGalleryPages()
}

function libraryFolderParam(value: string): string | undefined {
  if (!value) {
    return undefined
  }
  return value
}

function libraryFolderLabel(value: string): string {
  return value || '未归档'
}

function parseLibraryTagsInput(value: string): string[] {
  const tags: string[] = []
  const seen = new Set<string>()
  for (const rawTag of value.split(/[,\n，]+/)) {
    const tag = rawTag.trim().replace(/^#+/, '').replace(/\s+/g, ' ').slice(0, 32)
    const key = tag.toLowerCase()
    if (!tag || seen.has(key)) {
      continue
    }
    seen.add(key)
    tags.push(tag)
    if (tags.length >= 20) {
      break
    }
  }
  return tags
}

function clearLibraryFilters(): void {
  libraryQuery.value = ''
  libraryFolderFilter.value = ''
  libraryTagFilter.value = ''
  libraryFavoriteOnly.value = false
}

function setLibraryFolderFilter(value: string): void {
  libraryFolderFilter.value = value
  libraryFolderMenu.value?.removeAttribute('open')
}

function setLibraryTagFilter(value: string): void {
  libraryTagFilter.value = value
  libraryTagMenu.value?.removeAttribute('open')
}

async function refreshLibrary(): Promise<void> {
  if (!isAuthenticated.value) {
    resetLibraryState()
    return
  }
  libraryBusy.value = true
  libraryNextOffset.value = 0
  libraryHasMore.value = true
  try {
    const page = await listLibraryItems({
      offset: 0,
      limit: libraryBatchSize,
      query: libraryQuery.value,
      folder: libraryFolderParam(libraryFolderFilter.value),
      tag: libraryTagFilter.value,
      favorite: libraryFavoriteOnly.value
    })
    libraryItems.value = page.items
    libraryFolders.value = page.folders
    libraryTags.value = page.tags
    libraryTotal.value = page.total
    libraryNextOffset.value = page.nextOffset || libraryItems.value.length
    libraryHasMore.value = page.hasMore
    librarySelectedIds.value = librarySelectedIds.value.filter((id) => page.items.some((item) => item.id === id))
  } catch (error) {
    setError(error instanceof Error ? error.message : '加载个人作品库失败')
  } finally {
    libraryBusy.value = false
    if (activeView.value === 'library') {
      await nextTick()
      setupLibraryObserver()
    }
  }
}

async function loadMoreLibrary(): Promise<void> {
  if (!isAuthenticated.value || libraryBusy.value || libraryLoadingMore.value || !libraryHasMore.value) {
    return
  }
  libraryLoadingMore.value = true
  try {
    const page = await listLibraryItems({
      offset: libraryNextOffset.value,
      limit: libraryBatchSize,
      query: libraryQuery.value,
      folder: libraryFolderParam(libraryFolderFilter.value),
      tag: libraryTagFilter.value,
      favorite: libraryFavoriteOnly.value
    })
    const existingIds = new Set(libraryItems.value.map((item) => item.id))
    libraryItems.value = [
      ...libraryItems.value,
      ...page.items.filter((item) => !existingIds.has(item.id))
    ]
    libraryFolders.value = page.folders
    libraryTags.value = page.tags
    libraryTotal.value = page.total
    libraryNextOffset.value = page.nextOffset || libraryItems.value.length
    libraryHasMore.value = page.hasMore
  } catch (error) {
    setError(error instanceof Error ? error.message : '加载更多作品失败')
  } finally {
    libraryLoadingMore.value = false
  }
}

function isLibrarySentinelNearViewport(): boolean {
  if (activeView.value !== 'library' || !librarySentinel.value) {
    return false
  }
  const rect = librarySentinel.value.getBoundingClientRect()
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight
  return rect.top <= viewportHeight + 180 && rect.bottom >= -180
}

async function loadVisibleLibraryPages(): Promise<void> {
  await nextTick()
  let loadCount = 0
  while (
    libraryHasMore.value &&
    !libraryBusy.value &&
    !libraryLoadingMore.value &&
    isLibrarySentinelNearViewport() &&
    loadCount < 6
  ) {
    loadCount += 1
    await loadMoreLibrary()
    await nextTick()
  }
}

function setupLibraryObserver(): void {
  libraryObserver?.disconnect()
  if (!librarySentinel.value) {
    return
  }
  libraryObserver = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) {
      void loadVisibleLibraryPages()
    }
  }, {
    rootMargin: '40px 0px'
  })
  libraryObserver.observe(librarySentinel.value)
  void loadVisibleLibraryPages()
}

function scheduleLibraryRefresh(): void {
  if (librarySearchTimer) {
    window.clearTimeout(librarySearchTimer)
  }
  librarySearchTimer = window.setTimeout(() => {
    librarySearchTimer = null
    void refreshLibrary()
  }, 260)
}

function toggleLibrarySelection(item: LibraryItem): void {
  const selected = selectedLibraryIdsSet.value
  librarySelectedIds.value = selected.has(item.id)
    ? librarySelectedIds.value.filter((id) => id !== item.id)
    : [...librarySelectedIds.value, item.id]
}

function setLibrarySelectionMode(enabled: boolean): void {
  librarySelectionMode.value = enabled
  if (!enabled) {
    librarySelectedIds.value = []
  }
}

async function toggleLibraryFavorite(item: LibraryItem): Promise<void> {
  try {
    const updated = await updateLibraryItem(item.id, { favorite: !item.favorite })
    libraryItems.value = libraryItems.value.map((current) => current.id === updated.id ? updated : current)
    if (selectedLibraryItem.value?.id === updated.id) {
      selectedLibraryItem.value = updated
    }
  } catch (error) {
    setError(error instanceof Error ? error.message : '更新收藏失败')
  }
}

async function handleDeleteLibraryItem(item: LibraryItem): Promise<void> {
  if (!window.confirm('确定从个人作品库删除这张图片吗？不会删除会话记录。')) {
    return
  }
  try {
    await deleteLibraryItem(item.id)
    libraryItems.value = libraryItems.value.filter((current) => current.id !== item.id)
    librarySelectedIds.value = librarySelectedIds.value.filter((id) => id !== item.id)
    if (selectedLibraryItem.value?.id === item.id) {
      closeImageModal()
    }
    setSuccess('已从个人作品库删除。')
    void refreshLibrary()
  } catch (error) {
    setError(error instanceof Error ? error.message : '删除作品失败')
  }
}

async function handleLibraryBatchAction(action: 'favorite' | 'unfavorite' | 'delete' | 'move' | 'add_tags' | 'remove_tags' | 'set_tags'): Promise<void> {
  const ids = [...librarySelectedIds.value]
  if (ids.length === 0) {
    setError('请先选择作品。')
    return
  }
  if (action === 'delete' && !window.confirm(`确定从个人作品库删除 ${ids.length} 张图片吗？不会删除会话记录。`)) {
    return
  }
  const tags = parseLibraryTagsInput(libraryBatchTags.value)
  if ((action === 'add_tags' || action === 'remove_tags' || action === 'set_tags') && tags.length === 0) {
    setError('请输入要处理的标签。')
    return
  }

  try {
    await batchUpdateLibraryItems({
      ids,
      action,
      folder: action === 'move' ? libraryBatchFolder.value : undefined,
      tags: action === 'add_tags' || action === 'remove_tags' || action === 'set_tags' ? tags : undefined
    })
    setSuccess('批量操作已完成。')
    libraryBatchTags.value = action === 'add_tags' || action === 'remove_tags' || action === 'set_tags' ? '' : libraryBatchTags.value
    librarySelectedIds.value = []
    await refreshLibrary()
  } catch (error) {
    setError(error instanceof Error ? error.message : '批量操作失败')
  }
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
  sourceImages: ImageTaskSourceImage[] = [],
  conversationId = currentConversationId.value,
  source: 'chat' | 'direct' = 'direct',
  assistantMessageId?: string,
  mask?: ImageEditMask
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
      ...(mask
        ? {
          mask: {
            name: mask.name,
            mime_type: mask.mimeType,
            data_url: mask.dataUrl
          }
        }
        : {}),
      images: sourceImages.map((image) => ({
        name: image.name,
        mime_type: image.mimeType,
        ...(image.dataUrl ? { data_url: image.dataUrl } : {}),
        ...(image.assetToken ? { asset_token: image.assetToken } : {}),
        ...(image.image_url ? { image_url: image.image_url } : {}),
        ...(image.remoteUrl ? { remote_url: image.remoteUrl } : {})
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

function downloadTextFile(content: string, filename: string, mimeType = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  triggerDownload(url, filename)
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  triggerDownload(url, filename)
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
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
          normalizeGeneratedImages(payload.state.generatedImages || []),
          payload.state.pptState || null,
          payload.state.workspaceType === 'ppt' ? 'ppt' : 'create'
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
      status: task.status === 'completed' ? 'ready' : 'loading',
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
  await saveConversationSnapshot(
    pendingTask.conversationId,
    nextMessages,
    nextImages,
    payload.state.pptState || null,
    payload.state.workspaceType === 'ppt' ? 'ppt' : 'create'
  )
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
  await saveConversationSnapshot(
    conversationId,
    nextMessages,
    normalizeGeneratedImages(payload.state.generatedImages || []),
    payload.state.pptState || null,
    payload.state.workspaceType === 'ppt' ? 'ppt' : 'create'
  )
}

async function completePendingImageTask(
  pendingTask: PendingImageTask,
  task: ImageTaskStatus
): Promise<boolean> {
  removePendingImageTask(pendingTask.taskId)

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

async function handleLocalEditSubmit(): Promise<void> {
  if (selectedImage.value && isImageLoading(selectedImage.value)) {
    return
  }
  if (!selectedImage.value && !selectedLibraryItem.value) {
    return
  }
  if (!currentConversationId.value) {
    await startNewConversation()
  }
  if (!currentConversationId.value) {
    setError('请先选择或创建一个会话。')
    return
  }

  const apiKey = selectedKeySecret.value
  const prompt = localEditPrompt.value.trim()
  if (!apiKey) {
    setError('请先选择或创建一个 OpenAI 分组 API Key。')
    return
  }
  if (!prompt) {
    setError('请输入局部修改提示词。')
    return
  }

  const originConversationId = currentConversationId.value
  const sourceImage = selectedImage.value
  const sourceLibraryImage = selectedLibraryItem.value
  const size = sourceImage?.size || sourceLibraryImage?.size || imageSize.value
  imageBusy.value = true
  imageTaskLabel.value = '正在创建局部修改任务...'
  let pendingTask: PendingImageTask | null = null

  try {
    const maskDataUrl = createLocalEditMaskDataUrl()
    const sourceAttachment = sourceImage
      ? createLocalEditSourceImage(sourceImage)
      : createLibraryEditSourceImage(sourceLibraryImage as LibraryItem)
    const mask: ImageEditMask = {
      name: 'mask.png',
      mimeType: 'image/png',
      dataUrl: maskDataUrl
    }
    const { task_id } = await createImageTask(
      apiKey,
      buildImageTaskPayload(prompt, size, [sourceAttachment], originConversationId, 'direct', undefined, mask)
    )

    pendingTask = {
      taskId: task_id,
      conversationId: originConversationId,
      mode: 'edit',
      prompt,
      size,
      source: 'direct'
    }
    addPendingImageTask(pendingTask)
    upsertLoadingTaskImage(pendingTask)
    closeImageModal()
    imageTaskLabel.value = `局部修改任务已创建（${task_id.slice(0, 8)}），正在轮询结果...`

    const task = await waitForImageTask(task_id, (nextTask) => {
      mergeStreamingTaskImages(nextTask)
      imageTaskLabel.value = hasStreamingImageResult(nextTask)
        ? '正在接收流式图片预览...'
        : describeImageTaskStatus(nextTask.status)
    })
    if (task.status === 'failed') {
      throw new Error(task.error || '局部修改失败')
    }

    await completePendingImageTask(pendingTask, task)
    setSuccess(currentConversationId.value === originConversationId
      ? '局部修改完成，结果已保存到当前会话。'
      : '后台局部修改已完成，结果已保存到原会话。')
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
    setError(error instanceof Error ? error.message : '局部修改失败')
  } finally {
    imageBusy.value = false
    imageTaskLabel.value = ''
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

async function handleGeneratePptPlan(): Promise<void> {
  if (!currentConversationId.value) {
    await startNewConversation()
  }

  const apiKey = selectedKeySecret.value
  const prompt = pptPrompt.value.trim()
  const style = pptStyle.value.trim()
  const details = pptDesignDetails.value.trim()
  const pageCount = Math.min(Math.max(Number(pptPageCount.value) || 0, 1), 30)
  const originConversationId = currentConversationId.value

  if (!apiKey) {
    setError('请先选择或创建一个 OpenAI 分组 API Key。')
    return
  }
  if (!prompt) {
    setError('请输入 PPT 内容或大纲提示词。')
    return
  }

  pptBusy.value = true
  errorMessage.value = ''
  successMessage.value = ''

  const instructions = [
    '你是一名资深演示设计总监和信息架构师。',
    '请根据用户输入，先统一整套 PPT 的叙事、风格、信息密度和视觉系统，再拆分分页。',
    '输出必须是严格 JSON，不要输出 Markdown、解释、前后缀。',
    'slides 必须与 pageCount 完全一致。',
    '每一页都要给出具体、可执行的 generationPrompt，说明这一页该如何制作，且所有页保持统一风格。',
    'generationPrompt 必须包含：页面目标、推荐版式、内容结构、视觉风格、配色/字体/图表或插画建议。',
    'keyPoints 控制在 3 到 6 条，每条一句短语。',
    'speakerNotes 用中文，帮助用户理解该页讲什么。',
    '如果用户信息不足，请做合理补全，但不要偏离主题。',
    '全部字段使用中文，projectTitle 简洁明确。'
  ].join(' ')

  const schemaExample = {
    projectTitle: 'string',
    summary: 'string',
    targetAudience: 'string',
    narrativeFlow: 'string',
    visualSystem: 'string',
    slides: [{
      pageNumber: 1,
      title: 'string',
      objective: 'string',
      keyPoints: ['string'],
      layout: 'string',
      visualDirection: 'string',
      speakerNotes: 'string',
      generationPrompt: 'string'
    }]
  }

  try {
    if (ENABLE_MOCK) {
      pptPlan.value = buildMockPptPlan(prompt, style, details, pageCount)
      pptCurrentSlideIndex.value = 0
      pptEditorOpen.value = false
      pptConfigPanelOpen.value = false
      persistPptDraft()
      if (originConversationId) {
        await saveConversationSnapshot(originConversationId, chatMessages.value, generatedImages.value)
      }
      setSuccess('Mock 模式下已生成本地 PPT 分页方案。')
      return
    }

    const response = await sendResponsesRequest(apiKey, {
      model: pptSelectedModel.value,
      instructions,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: [
                `pageCount: ${pageCount}`,
                `contentOrOutline: ${prompt}`,
                `style: ${style || '未指定，请根据内容推断一个专业且统一的风格'}`,
                `designDetails: ${details || '信息层级清晰，重点突出，适合正式演示'}`,
                `请仅返回 JSON，字段结构参考：${JSON.stringify(schemaExample)}`
              ].join('\n')
            }
          ]
        }
      ]
    })
    ensureResponseSucceeded(response)
    const rawText = extractResponseText(response)
    const jsonText = extractJsonBlock(rawText)
    const parsed = JSON.parse(jsonText) as Partial<PptPlanResult>
    const normalized = normalizePptPlan(parsed)

    if (normalized.slides.length !== pageCount) {
      throw new Error(`模型返回了 ${normalized.slides.length} 页，和设定的 ${pageCount} 页不一致。`)
    }

    pptPlan.value = normalized
    pptCurrentSlideIndex.value = 0
    pptEditorOpen.value = false
    pptConfigPanelOpen.value = false
    persistPptDraft()
    if (originConversationId) {
      await saveConversationSnapshot(originConversationId, chatMessages.value, generatedImages.value)
    }
    setSuccess('PPT 分页方案已生成。')
    await refreshBalanceOnly()
  } catch (error) {
    setError(error instanceof Error ? error.message : 'PPT 分页生成失败')
  } finally {
    pptBusy.value = false
  }
}

async function requestSinglePptSlide(operation: 'rewrite' | 'insert'): Promise<PptSlidePlan> {
  const apiKey = selectedKeySecret.value
  const currentSlide = currentPptSlide.value
  const plan = pptPlan.value
  if (!apiKey) {
    throw new Error('请先选择或创建一个 OpenAI 分组 API Key。')
  }
  if (!plan || !currentSlide) {
    throw new Error('当前没有可编辑的 PPT 页面。')
  }

  if (ENABLE_MOCK) {
    return buildMockPptSlide(
      operation === 'insert' ? currentPptSlide.value.pageNumber + 1 : currentPptSlide.value.pageNumber,
      pptSlideEditPrompt.value,
      operation === 'insert' ? '新增补充页' : `${currentSlide.title}（重写）`
    )
  }

  const instructions = [
    '你是一名资深演示设计总监和信息架构师。',
    '你的任务是只返回一页 PPT 的严格 JSON。',
    '不要返回 markdown，不要解释，不要返回数组或额外字段。',
    '返回字段必须是：pageNumber,title,objective,keyPoints,layout,visualDirection,speakerNotes,generationPrompt。',
    '必须延续整套 PPT 的风格、叙事顺序和信息密度。',
    operation === 'rewrite'
      ? '这是对当前页的重写，不要偏离该页在整套文稿中的角色。'
      : '这是插入在当前页后的新页，需要自然承接前后页内容。'
  ].join(' ')

  const response = await sendResponsesRequest(apiKey, {
    model: pptSelectedModel.value,
    instructions,
    input: [{
      role: 'user',
      content: [{
        type: 'input_text',
        text: [
          `projectTitle: ${plan.projectTitle}`,
          `summary: ${plan.summary}`,
          `targetAudience: ${plan.targetAudience}`,
          `narrativeFlow: ${plan.narrativeFlow}`,
          `visualSystem: ${plan.visualSystem}`,
          `globalPrompt: ${pptPrompt.value}`,
          `globalStyle: ${pptStyle.value || plan.visualSystem}`,
          `globalDesignDetails: ${pptDesignDetails.value || plan.summary}`,
          `operation: ${operation}`,
          `currentSlideIndex: ${pptCurrentSlideIndex.value + 1}`,
          `currentSlide: ${JSON.stringify(currentSlide)}`,
          `allSlideTitles: ${plan.slides.map((slide, index) => `${index + 1}.${slide.title}`).join(' | ')}`,
          `userInstruction: ${pptSlideEditPrompt.value.trim() || (operation === 'rewrite' ? '优化这一页的信息表达和版式。' : '补充一页自然承接上下文的新内容。')}`,
          '请只返回单个 JSON 对象。'
        ].join('\n')
      }]
    }]
  })

  ensureResponseSucceeded(response)
  const parsed = JSON.parse(extractJsonBlock(extractResponseText(response))) as Partial<PptSlidePlan>
  return normalizePptSlide(parsed, currentSlide.pageNumber)
}

async function handleRewriteCurrentPptSlide(): Promise<void> {
  if (!pptPlan.value || !currentPptSlide.value) {
    setError('当前没有可重写的页面。')
    return
  }

  pptBusy.value = true
  try {
    const rewrittenSlide = await requestSinglePptSlide('rewrite')
    const slides = [...pptPlan.value.slides]
    slides.splice(pptCurrentSlideIndex.value, 1, rewrittenSlide)
    pptPlan.value = {
      ...pptPlan.value,
      slides: normalizePptSlides(slides)
    }
    pptSlideEditPrompt.value = ''
    await persistPptConversationState()
    await refreshBalanceOnly()
    setSuccess('当前页已重写。')
  } catch (error) {
    setError(error instanceof Error ? error.message : '重写当前页失败')
  } finally {
    pptBusy.value = false
  }
}

async function handleInsertPptSlideAfter(): Promise<void> {
  if (!pptPlan.value || !currentPptSlide.value) {
    setError('当前没有可插页的位置。')
    return
  }
  if (pptPlan.value.slides.length >= 30) {
    setError('最多只支持 30 页。')
    return
  }

  pptBusy.value = true
  try {
    const insertedSlide = await requestSinglePptSlide('insert')
    const slides = [...pptPlan.value.slides]
    slides.splice(pptCurrentSlideIndex.value + 1, 0, insertedSlide)
    const normalizedSlides = normalizePptSlides(slides)
    pptPlan.value = {
      ...pptPlan.value,
      slides: normalizedSlides
    }
    pptPageCount.value = normalizedSlides.length
    pptCurrentSlideIndex.value = Math.min(pptCurrentSlideIndex.value + 1, normalizedSlides.length - 1)
    pptSlideEditPrompt.value = ''
    await persistPptConversationState()
    await refreshBalanceOnly()
    setSuccess('已在当前页后插入新页。')
  } catch (error) {
    setError(error instanceof Error ? error.message : '插入新页失败')
  } finally {
    pptBusy.value = false
  }
}

async function handleDeleteCurrentPptSlide(): Promise<void> {
  if (!pptPlan.value || !currentPptSlide.value) {
    setError('当前没有可删除的页面。')
    return
  }
  if (pptPlan.value.slides.length <= 1) {
    setError('至少保留 1 页，不能删除最后一页。')
    return
  }

  const slides = [...pptPlan.value.slides]
  slides.splice(pptCurrentSlideIndex.value, 1)
  const normalizedSlides = normalizePptSlides(slides)
  pptPlan.value = {
    ...pptPlan.value,
    slides: normalizedSlides
  }
  pptPageCount.value = normalizedSlides.length
  pptCurrentSlideIndex.value = Math.max(0, Math.min(pptCurrentSlideIndex.value, normalizedSlides.length - 1))
  await persistPptConversationState()
  setSuccess('当前页已删除。')
}

async function handleDeletePptSlideAt(index: number): Promise<void> {
  if (!pptPlan.value) {
    return
  }
  selectPptSlide(index)
  await handleDeleteCurrentPptSlide()
}

async function handleMovePptSlideAt(index: number, direction: -1 | 1): Promise<void> {
  if (!pptPlan.value) {
    return
  }
  selectPptSlide(index)
  await handleMoveCurrentPptSlide(direction)
}

async function handleDuplicatePptSlideAt(index: number): Promise<void> {
  if (!pptPlan.value) {
    setError('当前没有可复制的页面。')
    return
  }
  if (pptPlan.value.slides.length >= 30) {
    setError('最多只支持 30 页。')
    return
  }
  const slide = pptPlan.value.slides[index]
  if (!slide) {
    return
  }
  const duplicatedSlides = [...pptPlan.value.slides]
  duplicatedSlides.splice(index + 1, 0, {
    ...slide,
    slideImageId: slide.slideImageId
  })
  const normalizedSlides = normalizePptSlides(duplicatedSlides)
  pptPlan.value = {
    ...pptPlan.value,
    slides: normalizedSlides
  }
  pptPageCount.value = normalizedSlides.length
  pptCurrentSlideIndex.value = Math.min(index + 1, normalizedSlides.length - 1)
  await persistPptConversationState()
  setSuccess('当前页已复制。')
}

async function handleSaveCurrentPptSlide(options: { silent?: boolean } = {}): Promise<void> {
  if (!pptPlan.value || !currentPptSlide.value) {
    if (!options.silent) {
      setError('当前没有可保存的页面。')
    }
    return
  }

  const title = pptFormTitle.value.trim()
  const objective = pptFormObjective.value.trim()
  const layout = pptFormLayout.value.trim()
  const visualDirection = pptFormVisualDirection.value.trim()
  const speakerNotes = pptFormSpeakerNotes.value.trim()
  const generationPrompt = pptFormGenerationPrompt.value.trim()
  const keyPoints = pptFormKeyPoints.value
    .split(/\n+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 6)

  if (!title || !objective || keyPoints.length === 0 || !layout || !visualDirection || !speakerNotes || !generationPrompt) {
    if (!options.silent) {
      setError('请先补全当前页的标题、目标、要点、版式、视觉方向、讲述建议和制作 Prompt。')
    }
    return
  }

  const slides = [...pptPlan.value.slides]
  const current = slides[pptCurrentSlideIndex.value]
  if (!current) {
    if (!options.silent) {
      setError('当前页已丢失，请刷新后重试。')
    }
    return
  }

  slides.splice(pptCurrentSlideIndex.value, 1, normalizePptSlide({
    ...current,
    title,
    objective,
    keyPoints,
    layout,
    visualDirection,
    speakerNotes,
    generationPrompt
  }, current.pageNumber))

  pptPlan.value = {
    ...pptPlan.value,
    slides: normalizePptSlides(slides)
  }
  await persistPptConversationState()
  if (!options.silent) {
    setSuccess('当前页内容已保存。')
  }
}

async function generatePptSlideImageAtIndex(slideIndex: number): Promise<GeneratedImage> {
  const apiKey = selectedKeySecret.value
  const slide = pptPlan.value?.slides[slideIndex]
  const prompt = slide?.generationPrompt.trim() || ''
  if (!apiKey) {
    throw new Error('请先选择或创建一个 OpenAI 分组 API Key。')
  }
  if (!slide) {
    throw new Error('目标分页不存在。')
  }
  if (!prompt) {
    throw new Error('当前页缺少可用于生成图片的提示词。')
  }

  const originConversationId = currentConversationId.value
  if (!originConversationId) {
    throw new Error('请先创建会话。')
  }

  const { task_id } = await createImageTask(
    apiKey,
    buildImageTaskPayload(prompt, '1536x864', [], originConversationId, 'direct')
  )
  const task = await waitForImageTask(task_id)
  if (task.status === 'failed') {
    throw new Error(task.error || 'PPT 页面图片生成失败')
  }

  const images = extractGeneratedImagesFromTask(task)
  const nextImage = images[0]
  if (!nextImage) {
    throw new Error('图片生成成功，但没有返回可展示的结果。')
  }

  const nextGeneratedImages = normalizeGeneratedImages([
    nextImage,
    ...generatedImages.value.filter((image) => image.id !== nextImage.id)
  ])
  const slides = [...(pptPlan.value?.slides || [])]
  const currentSlide = slides[slideIndex]
  if (!currentSlide) {
    throw new Error('当前页已丢失，请刷新后重试。')
  }

  slides.splice(slideIndex, 1, {
    ...currentSlide,
    slideImageId: nextImage.id,
    slideImageUrl: imageDownloadUrl(nextImage) || nextImage.image_url || nextImage.remoteUrl || undefined
  })
  pptPlan.value = pptPlan.value ? {
    ...pptPlan.value,
    slides: normalizePptSlides(slides)
  } : null
  generatedImages.value = nextGeneratedImages
  await persistPptConversationState()
  return nextImage
}

async function handleGenerateCurrentPptSlideImage(): Promise<void> {
  if (!currentPptSlide.value) {
    setError('当前没有可生成图片的页面。')
    return
  }
  if (!currentConversationId.value || currentConversation.value?.workspaceType !== 'ppt') {
    await ensureConversationLoaded('ppt')
  }
  if (!currentConversationId.value || currentConversation.value?.workspaceType !== 'ppt') {
    setError('当前没有可用的 PPT 任务，请先新建或选择一个 PPT 任务。')
    return
  }

  pptBusy.value = true
  pptTaskLabel.value = `正在生成第 ${pptCurrentSlideIndex.value + 1} 页图片...`
  try {
    await generatePptSlideImageAtIndex(pptCurrentSlideIndex.value)
    await refreshBalanceOnly()
    setSuccess('当前页图片已生成。')
  } catch (error) {
    setError(error instanceof Error ? error.message : '当前页图片生成失败')
  } finally {
    pptBusy.value = false
    pptTaskLabel.value = ''
  }
}

async function handleGenerateAllPptSlideImages(): Promise<void> {
  if (!pptPlan.value || pptPlan.value.slides.length === 0) {
    setError('当前没有可生成图片的分页。')
    return
  }
  if (!currentConversationId.value || currentConversation.value?.workspaceType !== 'ppt') {
    await ensureConversationLoaded('ppt')
  }
  if (!currentConversationId.value || currentConversation.value?.workspaceType !== 'ppt') {
    setError('当前没有可用的 PPT 任务，请先新建或选择一个 PPT 任务。')
    return
  }

  const originalIndex = pptCurrentSlideIndex.value
  pptBusy.value = true
  try {
    const total = pptPlan.value.slides.length
    const concurrency = Math.min(pptImageGenerationConcurrency, total)
    let nextIndex = 0
    let completed = 0

    const worker = async (): Promise<void> => {
      while (nextIndex < total) {
        const slideIndex = nextIndex
        nextIndex += 1
        pptCurrentSlideIndex.value = slideIndex
        pptTaskLabel.value = `正在生成第 ${Math.min(completed + 1, total)} / ${total} 页图片...`
        await generatePptSlideImageAtIndex(slideIndex)
        completed += 1
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()))
    await refreshBalanceOnly()
    setSuccess('整套 PPT 图片已生成。')
  } catch (error) {
    setError(error instanceof Error ? error.message : '整套 PPT 图片生成失败')
  } finally {
    pptCurrentSlideIndex.value = Math.min(originalIndex, Math.max((pptPlan.value?.slides.length || 1) - 1, 0))
    pptBusy.value = false
    pptTaskLabel.value = ''
  }
}

function buildPptExportHtml(): string {
  const plan = pptPlan.value
  if (!plan) {
    throw new Error('当前没有可导出的 PPT 方案。')
  }

  const slidesMarkup = plan.slides.map((slide) => {
    const image = slide.slideImageId
      ? generatedImages.value.find((item) => item.id === slide.slideImageId)
      : null
    const imageSrc = escapeHtml(image ? imageDownloadUrl(image) : (slide.slideImageUrl || ''))
    const points = slide.keyPoints.map((point) => `<li>${escapeHtml(point)}</li>`).join('')

    return `
      <section class="slide">
        <div class="slide-header">
          <span class="slide-index">第 ${slide.pageNumber} 页</span>
          <h2>${escapeHtml(slide.title)}</h2>
          <p class="slide-objective">${escapeHtml(slide.objective)}</p>
        </div>
        <div class="slide-grid">
          <article class="card">
            <h3>版式</h3>
            <p>${escapeHtml(slide.layout)}</p>
          </article>
          <article class="card">
            <h3>视觉方向</h3>
            <p>${escapeHtml(slide.visualDirection)}</p>
          </article>
        </div>
        <article class="card">
          <h3>核心内容</h3>
          <ul>${points}</ul>
        </article>
        <article class="card">
          <h3>讲述建议</h3>
          <p>${escapeHtml(slide.speakerNotes)}</p>
        </article>
        <article class="card">
          <h3>制作 Prompt</h3>
          <p>${escapeHtml(slide.generationPrompt)}</p>
        </article>
        ${imageSrc ? `
          <article class="card slide-image-card">
            <h3>本页配图</h3>
            <img src="${imageSrc}" alt="${escapeHtml(slide.title)}" />
          </article>
        ` : ''}
      </section>
    `
  }).join('\n')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(plan.projectTitle || 'PPT 导出')}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #eef2f7;
      --ink: #1f2937;
      --muted: #6b7280;
      --line: #d8dee8;
      --card: #ffffff;
      --accent: #ff4f2e;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Aptos", "Segoe UI", sans-serif;
      color: var(--ink);
      background: linear-gradient(180deg, #f8fafc 0%, var(--bg) 100%);
    }
    .deck {
      width: min(1200px, calc(100% - 32px));
      margin: 0 auto;
      padding: 32px 0 56px;
    }
    .deck-header {
      display: grid;
      gap: 14px;
      margin-bottom: 28px;
    }
    .deck-header h1 {
      margin: 0;
      font-size: clamp(2rem, 4vw, 3.4rem);
      line-height: 1.04;
    }
    .deck-meta {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 14px;
    }
    .card {
      border: 1px solid var(--line);
      border-radius: 22px;
      padding: 18px 20px;
      background: var(--card);
      box-shadow: 0 18px 44px rgba(15, 23, 42, 0.08);
    }
    .card h3 {
      margin: 0 0 10px;
      font-size: 0.92rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--accent);
    }
    .card p, .card li {
      color: var(--muted);
      line-height: 1.7;
      white-space: pre-wrap;
    }
    .slide {
      display: grid;
      gap: 16px;
      padding: 26px 0;
      border-top: 1px solid var(--line);
    }
    .slide:first-of-type { border-top: 0; }
    .slide-header {
      display: grid;
      gap: 10px;
    }
    .slide-index {
      color: var(--accent);
      font-size: 0.78rem;
      font-weight: 800;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }
    .slide-header h2 {
      margin: 0;
      font-size: clamp(1.6rem, 3vw, 2.6rem);
      line-height: 1.06;
    }
    .slide-objective {
      margin: 0;
      color: var(--muted);
    }
    .slide-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
    }
    .slide-image-card img {
      width: 100%;
      border-radius: 16px;
      object-fit: cover;
      aspect-ratio: 16 / 9;
      background: #e5e7eb;
    }
    @media (max-width: 820px) {
      .deck { width: min(100%, calc(100% - 20px)); padding: 20px 0 40px; }
      .slide-grid, .deck-meta { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main class="deck">
    <header class="deck-header">
      <span class="slide-index">PPT Export</span>
      <h1>${escapeHtml(plan.projectTitle)}</h1>
      <div class="deck-meta">
        <article class="card"><h3>整套摘要</h3><p>${escapeHtml(plan.summary)}</p></article>
        <article class="card"><h3>受众</h3><p>${escapeHtml(plan.targetAudience)}</p></article>
        <article class="card"><h3>叙事路径</h3><p>${escapeHtml(plan.narrativeFlow)}</p></article>
        <article class="card"><h3>统一视觉系统</h3><p>${escapeHtml(plan.visualSystem)}</p></article>
      </div>
    </header>
    ${slidesMarkup}
  </main>
</body>
</html>`
}

function handleExportPptHtml(): void {
  try {
    const plan = pptPlan.value
    if (!plan) {
      throw new Error('当前没有可导出的 PPT 方案。')
    }
    downloadTextFile(buildPptExportHtml(), buildDocumentFilename(plan.projectTitle || 'ppt-export', '.html'), 'text/html;charset=utf-8')
    setSuccess('PPT HTML 已导出。')
  } catch (error) {
    setError(error instanceof Error ? error.message : '导出 HTML 失败')
  }
}

function buildPptExportRequest(): PptExportRequest {
  const plan = pptPlan.value
  if (!plan) {
    throw new Error('当前没有可导出的 PPT 方案。')
  }

  const slideImages = plan.slides.flatMap((slide) => {
    if (!slide.slideImageId) {
      return []
    }
    const image = generatedImages.value.find((item) => item.id === slide.slideImageId)
    const source = toAbsoluteAssetUrl(image ? imageDownloadUrl(image) : (slide.slideImageUrl || ''))
    if (!source) {
      return []
    }
    return [{
      slideImageId: slide.slideImageId,
      source
    }]
  })

  return {
    plan,
    slideImages
  }
}

async function handleExportPptPresentation(): Promise<void> {
  try {
    const plan = pptPlan.value
    if (!plan) {
      throw new Error('当前没有可导出的 PPT 方案。')
    }
    const blob = await exportPptPresentation(buildPptExportRequest())
    downloadBlob(blob, buildDocumentFilename(plan.projectTitle || 'ppt-export', '.pptx'))
    setSuccess('PPTX 已导出。')
  } catch (error) {
    setError(error instanceof Error ? error.message : '导出 PPTX 失败')
  }
}

async function handleMoveCurrentPptSlide(direction: -1 | 1): Promise<void> {
  if (!pptPlan.value || !currentPptSlide.value) {
    setError('当前没有可移动的页面。')
    return
  }

  const currentIndex = pptCurrentSlideIndex.value
  const targetIndex = currentIndex + direction
  if (targetIndex < 0 || targetIndex >= pptPlan.value.slides.length) {
    return
  }

  const slides = [...pptPlan.value.slides]
  const [movedSlide] = slides.splice(currentIndex, 1)
  slides.splice(targetIndex, 0, movedSlide)
  const normalizedSlides = normalizePptSlides(slides)
  pptPlan.value = {
    ...pptPlan.value,
    slides: normalizedSlides
  }
  pptCurrentSlideIndex.value = targetIndex
  await persistPptConversationState()
  setSuccess(direction < 0 ? '当前页已上移。' : '当前页已下移。')
}

watch(() => generatedImages.value.length, () => { canvasImageIndex.value = -1 })
watch(() => pptSlides.value.length, (length) => {
  if (length <= 0) {
    pptCurrentSlideIndex.value = 0
    syncPptSlideForm(null)
    return
  }
  pptCurrentSlideIndex.value = Math.min(pptCurrentSlideIndex.value, length - 1)
})
watch(currentPptSlide, (slide) => {
  syncPptSlideForm(slide)
}, { immediate: true })
watch([pptPrompt, pptStyle, pptDesignDetails, pptPageCount, pptSelectedModel, pptPlan], () => {
  persistPptDraft()
}, { deep: true })

watch(activeView, async (view) => {
  if (view !== 'gallery') {
    galleryObserver?.disconnect()
    galleryObserver = null
  }
  if (view !== 'library') {
    libraryObserver?.disconnect()
    libraryObserver = null
  }
  if (view === 'library') {
    if (isAuthenticated.value) {
      await refreshLibrary()
    } else {
      resetLibraryState()
    }
    await nextTick()
    setupLibraryObserver()
    return
  }
  if (view !== 'gallery') {
    if (isAuthenticated.value && (view === 'create' || view === 'ppt')) {
      const workspaceType = view === 'ppt' ? 'ppt' : 'create'
      const currentWorkspaceType = currentConversation.value?.workspaceType
      if (!currentConversationId.value || currentWorkspaceType !== workspaceType) {
        conversationLoadRequestId += 1
        conversationBusy.value = true
        currentConversationId.value = ''
        clearLoadedConversationState()
        await ensureConversationLoaded(workspaceType)
      }
    }
    return
  }
  await nextTick()
  setupGalleryObserver()
})

watch([libraryQuery, libraryFolderFilter, libraryTagFilter, libraryFavoriteOnly], () => {
  if (activeView.value === 'library' && isAuthenticated.value) {
    scheduleLibraryRefresh()
  }
})

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
  restorePptDraft()
  window.addEventListener('resize', syncViewportLayout)

  if (ENABLE_MOCK) {
    const loginResult = await login('mock@example.com', 'mock')
    isAuthenticated.value = true
    activeView.value = 'create'
    await refreshWorkspace()
    profile.value = loginResult.user || profile.value || { id: 1, email: 'test@example.com', username: 'MockUser', role: 'user', status: 'active', balance: 9.52, concurrency: 5 }
    const mockConv = {
      id: 'mock-conv-1',
      title: '霓虹科幻场景',
      workspaceType: 'create' as const,
      createdAt: new Date(Date.now() - 3600000).toISOString(),
      updatedAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString()
    }
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
    await ensureConversationLoaded(activeView.value === 'ppt' ? 'ppt' : 'create')
    resumePendingImageTasks()
  }
})

onBeforeUnmount(() => {
  clearToastTimer()
  clearPptAutoSaveTimer()
  if (librarySearchTimer) {
    window.clearTimeout(librarySearchTimer)
  }
  galleryObserver?.disconnect()
  libraryObserver?.disconnect()
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
          <div v-if="!mainSidebarCollapsed" class="side-nav-copy">
            <span>画廊</span>
            <small>Public gallery</small>
          </div>
        </button>
        <button :class="{ active: activeView === 'library' }" type="button" title="作品库" @click="activeView = 'library'">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 19.5V6a2 2 0 0 1 2-2h5l2 2h5a2 2 0 0 1 2 2v11.5M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
          </svg>
          <div v-if="!mainSidebarCollapsed" class="side-nav-copy">
            <span>作品库</span>
            <small>Personal library</small>
          </div>
        </button>
        <button :class="{ active: activeView === 'create' }" type="button" title="创造" @click="activeView = 'create'">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>
          </svg>
          <div v-if="!mainSidebarCollapsed" class="side-nav-copy">
            <span>创造</span>
            <small>Chat & create</small>
          </div>
        </button>
        <button :class="{ active: activeView === 'ppt' }" type="button" title="PPT" @click="activeView = 'ppt'">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="4" y="3" width="16" height="18" rx="2"/>
            <path d="M8 8h8M8 12h8M8 16h5"/>
          </svg>
          <div v-if="!mainSidebarCollapsed" class="side-nav-copy">
            <span>PPT</span>
            <small>Slide planner</small>
          </div>
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

    <section v-else-if="activeView === 'library'" class="page library-page">
      <template v-if="!isAuthenticated">
        <section class="login-card panel">
          <div>
            <p class="eyebrow">Library</p>
            <h1>登录后管理个人作品库</h1>
            <p>作品库会保存你生成过的图片，并支持搜索、标签、文件夹、收藏、删除和批量管理。</p>
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
              {{ loginBusy ? '登录中...' : '进入作品库' }}
            </button>
          </form>
        </section>
      </template>

      <template v-else>
        <header class="library-header">
          <div class="library-search">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m21 21-4.35-4.35M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Z" />
            </svg>
            <input v-model="libraryQuery" type="search" placeholder="搜索提示词、尺寸、标签或文件夹" />
          </div>
          <div class="library-actions">
            <button
              class="ghost library-icon-button"
              type="button"
              :class="{ active: libraryFavoriteOnly }"
              title="只看收藏"
              aria-label="只看收藏"
              @click="libraryFavoriteOnly = !libraryFavoriteOnly"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m12 17.3-6.18 3.25 1.18-6.88L2 8.8l6.9-1L12 1.55l3.1 6.25 6.9 1-5 4.87 1.18 6.88L12 17.3Z" />
              </svg>
            </button>
            <button
              class="ghost library-icon-button"
              type="button"
              :disabled="libraryBusy"
              :title="libraryBusy ? '刷新中' : '刷新作品库'"
              aria-label="刷新作品库"
              @click="refreshLibrary"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" :class="{ spinning: libraryBusy }">
                <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v6h-6" />
              </svg>
            </button>
            <button
              class="secondary library-batch-toggle"
              type="button"
              :class="{ active: librarySelectionMode }"
              @click="setLibrarySelectionMode(!librarySelectionMode)"
            >
              {{ librarySelectionMode ? '完成' : '批量' }}
            </button>
          </div>
        </header>

        <div class="library-filter-row">
          <details ref="libraryFolderMenu" class="library-filter-menu">
            <summary :title="libraryFolderFilterSummary">
              <span>{{ libraryFolderFilterSummary }}</span>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </summary>
            <div class="library-filter-menu-list" role="listbox" aria-label="文件夹筛选">
              <button
                class="library-filter-option"
                :class="{ active: libraryFolderFilter === '' }"
                type="button"
                @click="setLibraryFolderFilter('')"
              >
                <span>全部文件夹</span>
              </button>
              <button
                v-for="folder in libraryFolders"
                :key="`folder-${folder.name || 'none'}`"
                class="library-filter-option"
                :class="{ active: libraryFolderFilter === (folder.name || '__none') }"
                type="button"
                @click="setLibraryFolderFilter(folder.name || '__none')"
              >
                <span>{{ libraryFolderLabel(folder.name) }}</span>
                <small>{{ folder.count }}</small>
              </button>
            </div>
          </details>
          <details ref="libraryTagMenu" class="library-filter-menu">
            <summary :title="libraryTagFilterSummary">
              <span>{{ libraryTagFilterSummary }}</span>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </summary>
            <div class="library-filter-menu-list" role="listbox" aria-label="标签筛选">
              <button
                class="library-filter-option"
                :class="{ active: libraryTagFilter === '' }"
                type="button"
                @click="setLibraryTagFilter('')"
              >
                <span>全部标签</span>
              </button>
              <button
                v-for="tag in libraryTags"
                :key="`tag-${tag.name}`"
                class="library-filter-option"
                :class="{ active: libraryTagFilter === tag.name }"
                type="button"
                @click="setLibraryTagFilter(tag.name)"
              >
                <span>#{{ tag.name }}</span>
                <small>{{ tag.count }}</small>
              </button>
            </div>
          </details>
          <button v-if="hasLibraryFilters" class="ghost mini" type="button" @click="clearLibraryFilters">清除筛选</button>
          <span class="library-count">{{ libraryTotal }} 张作品</span>
        </div>

        <section v-if="librarySelectionMode" class="library-batch-bar">
          <strong>{{ selectedLibraryItems.length }} 已选</strong>
          <button class="secondary mini" type="button" @click="handleLibraryBatchAction('favorite')">收藏</button>
          <button class="secondary mini" type="button" @click="handleLibraryBatchAction('unfavorite')">取消收藏</button>
          <label>
            <span>文件夹</span>
            <input v-model="libraryBatchFolder" type="text" placeholder="例如：角色设计" />
          </label>
          <button class="secondary mini" type="button" @click="handleLibraryBatchAction('move')">移动</button>
          <label>
            <span>标签</span>
            <input v-model="libraryBatchTags" type="text" placeholder="海报, 商业, 草图" />
          </label>
          <button class="secondary mini" type="button" @click="handleLibraryBatchAction('add_tags')">加标签</button>
          <button class="secondary mini" type="button" @click="handleLibraryBatchAction('set_tags')">设标签</button>
          <button class="secondary mini" type="button" @click="handleLibraryBatchAction('remove_tags')">移除标签</button>
          <button class="danger mini" type="button" @click="handleLibraryBatchAction('delete')">删除</button>
        </section>

        <div class="gallery-masonry library-masonry" :style="{ '--gallery-columns': String(galleryColumnCount) }">
          <article v-if="libraryBusy" class="gallery-empty">
            正在读取个人作品库...
          </article>
          <article v-else-if="libraryItems.length === 0" class="gallery-empty">
            当前筛选下没有作品。生成图片后，作品会自动保存到这里。
          </article>
          <template v-else>
            <div
              v-for="(column, columnIndex) in libraryColumns"
              :key="`library-column-${columnIndex}`"
              class="masonry-column"
            >
              <article
                v-for="item in column"
                :key="item.id"
                class="library-tile"
                :class="{ selected: selectedLibraryIdsSet.has(item.id) }"
              >
                <button
                  class="masonry-tile library-image-button"
                  type="button"
                  :style="{ aspectRatio: imageAspectRatio(item.size) || '1 / 1' }"
                  @click="librarySelectionMode ? toggleLibrarySelection(item) : openLibraryModal(item)"
                >
                  <img
                    :src="libraryImageUrl(item)"
                    :alt="item.prompt"
                    loading="lazy"
                    decoding="async"
                    @error="handleLibraryImageError($event, item)"
                  />
                  <span v-if="librarySelectionMode" class="library-select-mark">
                    <svg v-if="selectedLibraryIdsSet.has(item.id)" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="m5 12 4 4L19 6" />
                    </svg>
                  </span>
                </button>
                <div class="library-tile-meta">
                  <button
                    class="library-fav-button"
                    type="button"
                    :class="{ active: item.favorite }"
                    :aria-label="item.favorite ? '取消收藏' : '收藏'"
                    @click="toggleLibraryFavorite(item)"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="m12 17.3-6.18 3.25 1.18-6.88L2 8.8l6.9-1L12 1.55l3.1 6.25 6.9 1-5 4.87 1.18 6.88L12 17.3Z" />
                    </svg>
                  </button>
                  <div>
                    <strong>{{ libraryFolderLabel(item.folder) }}</strong>
                    <p>{{ item.prompt }}</p>
                    <div v-if="item.tags.length > 0" class="library-tags">
                      <span v-for="tag in item.tags.slice(0, 3)" :key="`${item.id}-${tag}`">#{{ tag }}</span>
                    </div>
                  </div>
                  <button class="library-delete-button" type="button" aria-label="删除作品" @click="handleDeleteLibraryItem(item)">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M3 6h18M8 6V4h8v2M7 6l1 14h8l1-14" />
                    </svg>
                  </button>
                </div>
              </article>
            </div>
          </template>
        </div>
        <div ref="librarySentinel" class="gallery-sentinel" aria-hidden="true">
          <span v-if="libraryLoadingMore">正在加载更多...</span>
          <span v-else-if="!libraryHasMore && libraryItems.length > 0">已经到底了</span>
        </div>
      </template>
    </section>

    <section v-else-if="activeView === 'ppt'" class="page ppt-page">
      <template v-if="!isAuthenticated">
        <section class="login-card panel">
          <div>
            <p class="eyebrow">PPT</p>
            <h1>登录后开始规划 PPT</h1>
            <p>选择模型和 API Key，输入内容、风格和设计要求，系统会拆解出统一风格的逐页制作方案。</p>
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
              {{ loginBusy ? '登录中...' : '进入 PPT 页面' }}
            </button>
          </form>
        </section>
      </template>

      <div v-else class="ppt-workspace">
        <section class="ppt-stage panel">
          <header class="ppt-hero">
            <div class="ppt-hero-copy">
              <h1>{{ pptHeroTitle }}</h1>
            </div>
            <div class="ppt-hero-actions">
              <button class="primary" type="button" :disabled="pptBusy || !selectedKeySecret" @click="handleGeneratePptPlan">
                <span>✨</span>
                {{ pptBusy ? '生成中...' : '生成' }}
              </button>
              <button class="ghost mini" type="button" :disabled="!pptPlan" @click="openPptPresentation">
                ▶ 演示
              </button>
              <button
                class="ghost mini icon-button"
                type="button"
                :disabled="!pptPlan"
                aria-label="导出 PPTX"
                title="导出 PPTX"
                @click="handleExportPptPresentation"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 3v10m0 0 4-4m-4 4-4-4M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" />
                </svg>
              </button>
            </div>
          </header>

          <div class="ppt-stage-main">
            <div v-if="pptBusy" class="ppt-skeleton-row">
              <article v-for="index in 4" :key="`ppt-skeleton-${index}`" class="ppt-skeleton-card">
                <span class="ppt-skeleton-badge"></span>
                <strong></strong>
                <p></p>
                <div class="ppt-skeleton-lines">
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
              </article>
            </div>

            <div v-else-if="pptSlides.length > 0" class="ppt-overview-grid">
              <article
                v-for="(slide, index) in pptSlides"
                :key="slide.pageNumber"
                class="ppt-overview-card"
                :class="{ active: index === pptCurrentSlideIndex }"
                @click="openPptSlideEditor(index)"
              >
                <span class="ppt-overview-card-page">{{ String(index + 1).padStart(2, '0') }}</span>
                <div class="ppt-overview-card-media">
                  <img
                    v-if="imageForPptSlide(slide) || slide.slideImageUrl"
                    :src="previewUrlForPptSlide(slide)"
                    :alt="slide.title"
                    @error="handlePptSlideImageError($event, slide)"
                  />
                  <div v-else class="ppt-overview-card-placeholder">
                    <span>{{ index % 3 === 0 ? '📊' : index % 3 === 1 ? '💡' : '📈' }}</span>
                  </div>
                </div>
                <div class="ppt-overview-card-body">
                  <strong>{{ slide.title }}</strong>
                  <p>{{ slide.objective }}</p>
                </div>
                <div class="ppt-deck-card-actions">
                  <button class="ghost mini" type="button" :disabled="pptBusy || pptSlides.length <= 1" @click.stop="handleDeletePptSlideAt(index)">
                    删除
                  </button>
                  <button class="ghost mini" type="button" :disabled="pptBusy || index <= 0" @click.stop="handleMovePptSlideAt(index, -1)">
                    上移
                  </button>
                  <button class="ghost mini" type="button" :disabled="pptBusy || pptSlides.length >= 30" @click.stop="handleDuplicatePptSlideAt(index)">
                    复制
                  </button>
                </div>
              </article>
            </div>

            <div v-else class="ppt-empty-state ppt-empty-stage">
              <strong>输入你的想法，生成一套 PPT 大纲</strong>
              <div class="ppt-empty-composer">
                <textarea
                  v-model="pptPrompt"
                  rows="4"
                  placeholder="例如：为 AI 图像生成 SaaS 做一套融资路演大纲，包含市场、产品、增长和商业模式。"
                />
                <div class="ppt-empty-actions">
                  <button class="primary" type="button" :disabled="pptBusy || !selectedKeySecret" @click="handleGeneratePptPlan">
                    <span>✨</span>
                    {{ pptBusy ? '生成中...' : '生成' }}
                  </button>
                  <button class="ghost mini" type="button" @click="pptConfigPanelOpen = true">
                    设置
                  </button>
                </div>
              </div>
            </div>
          </div>

          <footer class="ppt-stage-utility">
            <span class="ppt-stage-status">{{ pptTaskLabel || (pptSlides.length > 0 ? `当前共 ${pptSlides.length} 页` : '准备开始新的 PPT 任务') }}</span>
            <button class="ghost mini ppt-settings-link" type="button" @click="pptConfigPanelOpen = true">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M10.3 4.3a1 1 0 0 1 1.4 0l.9.9a1 1 0 0 0 1.02.24l1.23-.37a1 1 0 0 1 1.23.67l.38 1.23a1 1 0 0 0 .74.7l1.25.3a1 1 0 0 1 .74 1.13l-.16 1.28a1 1 0 0 0 .33.99l.97.86a1 1 0 0 1 0 1.48l-.97.86a1 1 0 0 0-.33.99l.16 1.28a1 1 0 0 1-.74 1.13l-1.25.3a1 1 0 0 0-.74.7l-.38 1.23a1 1 0 0 1-1.23.67l-1.23-.37a1 1 0 0 0-1.02.24l-.9.9a1 1 0 0 1-1.4 0l-.9-.9a1 1 0 0 0-1.02-.24l-1.23.37a1 1 0 0 1-1.23-.67l-.38-1.23a1 1 0 0 0-.74-.7l-1.25-.3a1 1 0 0 1-.74-1.13l.16-1.28a1 1 0 0 0-.33-.99l-.97-.86a1 1 0 0 1 0-1.48l.97-.86a1 1 0 0 0 .33-.99l-.16-1.28a1 1 0 0 1 .74-1.13l1.25-.3a1 1 0 0 0 .74-.7l.38-1.23a1 1 0 0 1 1.23-.67l1.23.37a1 1 0 0 0 1.02-.24zM12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z" />
              </svg>
              设置
            </button>
          </footer>
        </section>

        <div v-if="pptEditorOpen && currentPptSlide" class="ppt-editor-modal-backdrop" @click="closePptSlideEditor"></div>
        <section v-if="pptEditorOpen && currentPptSlide" class="ppt-editor-modal panel" aria-label="PPT 页面编辑详情">
          <div class="ppt-editor-topbar">
            <button class="ghost mini" type="button" @click="closePptSlideEditor">
              返回概览
            </button>
            <div class="ppt-editor-topbar-actions">
              <button class="ghost mini" type="button" :disabled="pptBusy" @click="handleRewriteCurrentPptSlide">
                重写
              </button>
              <button class="ghost mini" type="button" :disabled="pptBusy" @click="handleGenerateCurrentPptSlideImage">
                配图
              </button>
            </div>
          </div>
          <div class="ppt-focus-layout">
            <aside class="ppt-focus-strip">
              <button
                v-for="(slide, index) in pptSlides"
                :key="`focus-${slide.pageNumber}`"
                class="ppt-focus-thumb"
                :class="{ active: index === pptCurrentSlideIndex }"
                type="button"
                @click="selectPptSlide(index)"
              >
                <span>{{ String(index + 1).padStart(2, '0') }}</span>
                <strong>{{ slide.title }}</strong>
              </button>
            </aside>
            <article class="ppt-focus-canvas">
              <div class="ppt-focus-stage">
                <article class="ppt-focus-slide">
                  <div class="ppt-focus-slide-shell">
                    <header class="ppt-focus-slide-header">
                      <span class="ppt-slide-index">第 {{ pptCurrentSlideIndex + 1 }} / {{ pptSlides.length }} 页</span>
                      <input
                        v-model="pptFormTitle"
                        class="ppt-canvas-title"
                        type="text"
                        placeholder="输入这一页的标题"
                        @input="schedulePptSlideAutoSave"
                      />
                      <textarea
                        v-model="pptFormObjective"
                        class="ppt-canvas-objective"
                        rows="2"
                        placeholder="这一页要讲清什么"
                        @input="schedulePptSlideAutoSave"
                      />
                    </header>
                    <div class="ppt-focus-slide-body">
                      <section class="ppt-focus-slide-points">
                        <div class="ppt-focus-block-head">
                          <span class="ppt-slide-label">核心内容</span>
                          <button class="ghost mini" type="button" @click="addPptKeyPoint">
                            添加要点
                          </button>
                        </div>
                        <ul>
                          <li v-for="(point, pointIndex) in editablePptKeyPoints()" :key="`${currentPptSlide.pageNumber}-${pointIndex}`" class="ppt-canvas-point-item">
                            <textarea
                              :value="point"
                              rows="2"
                              class="ppt-canvas-point-input"
                              placeholder="输入要点"
                              @input="handlePptKeyPointInput(pointIndex, $event)"
                            />
                            <button
                              v-if="editablePptKeyPoints().length > 1"
                              class="ghost mini icon-button"
                              type="button"
                              aria-label="删除要点"
                              @click="removePptKeyPoint(pointIndex)"
                            >
                              <svg viewBox="0 0 24 24" aria-hidden="true">
                                <path d="M6 6 18 18M18 6 6 18" />
                              </svg>
                            </button>
                          </li>
                        </ul>
                      </section>
                      <aside class="ppt-focus-slide-aside">
                        <div v-if="currentPptSlideImage || currentPptSlide.slideImageUrl" class="ppt-focus-slide-visual">
                          <img
                            :src="slideImagePreviewUrl(currentPptSlide)"
                            :alt="currentPptSlide.title"
                            loading="lazy"
                            @error="handlePptSlideImageError($event, currentPptSlide)"
                            @click="currentPptSlideImage ? openImageModal(currentPptSlideImage, currentPptSlideImageIndex) : undefined"
                          />
                        </div>
                        <div v-else class="ppt-focus-slide-visual placeholder">
                          <span>{{ pptCurrentSlideIndex % 3 === 0 ? '📊' : pptCurrentSlideIndex % 3 === 1 ? '💡' : '📈' }}</span>
                        </div>
                        <section class="ppt-focus-slide-meta">
                          <div>
                            <span class="ppt-slide-label">版式</span>
                            <textarea
                              v-model="pptFormLayout"
                              rows="4"
                              class="ppt-canvas-meta-input"
                              placeholder="描述版式与信息布局"
                              @input="schedulePptSlideAutoSave"
                            />
                          </div>
                          <div>
                            <span class="ppt-slide-label">视觉方向</span>
                            <textarea
                              v-model="pptFormVisualDirection"
                              rows="4"
                              class="ppt-canvas-meta-input"
                              placeholder="描述色彩、质感、图形方向"
                              @input="schedulePptSlideAutoSave"
                            />
                          </div>
                        </section>
                      </aside>
                    </div>
                    <footer class="ppt-focus-slide-foot">
                      <span class="ppt-slide-label">讲述备注</span>
                      <textarea
                        v-model="pptFormSpeakerNotes"
                        rows="2"
                        class="ppt-canvas-notes"
                        placeholder="演示时怎么讲这一页"
                        @input="schedulePptSlideAutoSave"
                      />
                    </footer>
                  </div>
                </article>
              </div>
            </article>
            <aside class="ppt-focus-editor">
              <section class="ppt-slide-form-card">
                <div class="ppt-slide-form-header">
                  <span class="ppt-slide-label">AI 工具</span>
                  <button class="secondary mini" type="button" :disabled="pptBusy" @click="handleSaveCurrentPptSlide">
                    保存
                  </button>
                </div>
                <div class="ppt-ai-tool-actions">
                  <button class="ghost mini" type="button" :disabled="pptBusy" @click="handleRewriteCurrentPptSlide">
                    重写当前页
                  </button>
                  <button class="ghost mini" type="button" :disabled="pptBusy" @click="handleGenerateCurrentPptSlideImage">
                    生成配图
                  </button>
                </div>
              </section>
              <section class="ppt-slide-image-panel">
                <span class="ppt-slide-label">本页配图</span>
                <div v-if="currentPptSlideImage || currentPptSlide.slideImageUrl" class="ppt-slide-image-wrap">
                  <img
                    :src="slideImagePreviewUrl(currentPptSlide)"
                    :alt="currentPptSlide.title"
                    loading="lazy"
                    @error="handlePptSlideImageError($event, currentPptSlide)"
                    @click="currentPptSlideImage ? openImageModal(currentPptSlideImage, currentPptSlideImageIndex) : undefined"
                  />
                </div>
                <div v-else class="ppt-slide-image-empty">
                  <span>当前页还没有生成配图。</span>
                </div>
              </section>
              <section class="ppt-slide-prompt">
                <span class="ppt-slide-label">给 AI 的指令</span>
                <textarea
                  v-model="pptSlideEditPrompt"
                  rows="5"
                  placeholder="例如：这一页改成更强的数据对比结构；或在当前页后插入一页客户案例。"
                />
              </section>
              <section class="ppt-slide-prompt">
                <span class="ppt-slide-label">当前页制作 Prompt</span>
                <textarea
                  v-model="pptFormGenerationPrompt"
                  rows="8"
                  placeholder="该页的详细制作提示词"
                  @input="schedulePptSlideAutoSave"
                />
              </section>
            </aside>
          </div>
        </section>

        <div v-if="pptPresentOpen && currentPptSlide" class="ppt-editor-modal-backdrop" @click="closePptPresentation"></div>
        <section v-if="pptPresentOpen && currentPptSlide" class="ppt-present-modal panel" aria-label="PPT 演示模式">
          <div class="ppt-editor-topbar">
            <button class="ghost mini" type="button" @click="closePptPresentation">
              退出演示
            </button>
            <div class="ppt-editor-topbar-actions">
              <button class="ghost mini" type="button" :disabled="pptSlides.length < 2" @click="navigatePptSlide(-1)">
                上一页
              </button>
              <button class="ghost mini" type="button" :disabled="pptSlides.length < 2" @click="navigatePptSlide(1)">
                下一页
              </button>
            </div>
          </div>
          <article class="ppt-present-sheet">
            <div class="ppt-focus-slide-shell present">
              <header class="ppt-focus-slide-header">
                <span class="ppt-slide-index">第 {{ pptCurrentSlideIndex + 1 }} / {{ pptSlides.length }} 页</span>
                <strong>{{ currentPptSlide.title }}</strong>
                <p>{{ currentPptSlide.objective }}</p>
              </header>
              <div class="ppt-focus-slide-body">
                <section class="ppt-focus-slide-points">
                  <span class="ppt-slide-label">核心内容</span>
                  <ul>
                    <li v-for="(point, pointIndex) in currentPptSlide.keyPoints" :key="`present-${currentPptSlide.pageNumber}-${pointIndex}`">{{ point }}</li>
                  </ul>
                </section>
                <aside class="ppt-focus-slide-aside">
                  <div v-if="currentPptSlideImage || currentPptSlide.slideImageUrl" class="ppt-focus-slide-visual">
                    <img
                      :src="slideImagePreviewUrl(currentPptSlide)"
                      :alt="currentPptSlide.title"
                      loading="lazy"
                      @error="handlePptSlideImageError($event, currentPptSlide)"
                    />
                  </div>
                  <div v-else class="ppt-focus-slide-visual placeholder">
                    <span>{{ pptCurrentSlideIndex % 3 === 0 ? '📊' : pptCurrentSlideIndex % 3 === 1 ? '💡' : '📈' }}</span>
                  </div>
                </aside>
              </div>
            </div>
          </article>
        </section>

        <div v-if="pptConfigPanelOpen" class="ppt-drawer-backdrop" @click="pptConfigPanelOpen = false"></div>

        <aside class="ppt-config-drawer panel" :class="{ open: pptConfigPanelOpen }">
          <div class="ppt-sidebar-header">
            <div>
              <p class="eyebrow">Workspace</p>
              <h2>{{ pptSidebarTab === 'settings' ? '设置' : '任务记录' }}</h2>
            </div>
            <div class="ppt-drawer-header-actions">
              <div class="ppt-sidebar-tabs" role="tablist" aria-label="PPT 侧栏">
                <button
                  class="ppt-sidebar-tab"
                  :class="{ active: pptSidebarTab === 'settings' }"
                  type="button"
                  role="tab"
                  :aria-selected="pptSidebarTab === 'settings'"
                  @click="pptSidebarTab = 'settings'"
                >
                  参数
                </button>
                <button
                  class="ppt-sidebar-tab"
                  :class="{ active: pptSidebarTab === 'tasks' }"
                  type="button"
                  role="tab"
                  :aria-selected="pptSidebarTab === 'tasks'"
                  @click="pptSidebarTab = 'tasks'"
                >
                  任务
                </button>
              </div>
              <button class="ghost mini icon-button" type="button" aria-label="关闭设置" @click="pptConfigPanelOpen = false">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            </div>
          </div>

          <div v-if="pptSidebarTab === 'settings'" class="ppt-sidebar-body">
            <div class="ppt-form">
              <section class="ppt-form-group">
                <span class="ppt-slide-label">生成设置</span>
                <label>
                  模型
                  <select v-model="pptSelectedModel">
                    <option v-for="model in textModels" :key="model" :value="model">{{ model }}</option>
                  </select>
                </label>
                <label>
                  页数
                  <input v-model.number="pptPageCount" type="number" min="1" max="30" />
                </label>
              </section>

              <section class="ppt-form-group">
                <span class="ppt-slide-label">内容输入</span>
                <label>
                  内容或大纲
                  <textarea
                    v-model="pptPrompt"
                    rows="8"
                    placeholder="例如：为 SaaS 产品 AI 客服解决方案做一套 10 页融资路演 PPT，包含市场痛点、方案、产品演示、商业模式、竞争壁垒和融资计划。"
                  />
                </label>
                <label>
                  风格
                  <textarea
                    v-model="pptStyle"
                    rows="4"
                    placeholder="例如：极简科技感、蓝灰商务风、强对比排版、大面积留白。"
                  />
                </label>
                <label>
                  细节设计要求
                  <textarea
                    v-model="pptDesignDetails"
                    rows="5"
                    placeholder="例如：每页只保留一个重点，图表优先，标题短促有力度，适合给投资人现场讲解。"
                  />
                </label>
              </section>

              <details class="ppt-advanced-settings">
                <summary>高级设置</summary>
                <div class="ppt-advanced-settings-body">
                  <label>
                    API Key
                    <select v-model.number="selectedApiKeyId" :disabled="openAiApiKeys.length === 0">
                      <option v-for="key in openAiApiKeys" :key="key.id" :value="key.id">
                        {{ key.name }} / {{ key.group?.name || 'OpenAI' }}
                      </option>
                    </select>
                  </label>
                </div>
              </details>

              <div v-if="pptPlan && currentPptSlide" class="ppt-slide-editor">
                <span class="ppt-slide-label">当前页快捷操作</span>
                <div class="ppt-editor-actions">
                  <button class="secondary mini" type="button" :disabled="pptBusy" @click="handleRewriteCurrentPptSlide">
                    重写当前页
                  </button>
                  <button class="secondary mini" type="button" :disabled="pptBusy" @click="handleGenerateCurrentPptSlideImage">
                    生成本页图片
                  </button>
                  <button class="secondary mini" type="button" :disabled="pptBusy || pptSlides.length >= 30" @click="handleInsertPptSlideAfter">
                    插入新页
                  </button>
                  <button class="secondary mini" type="button" :disabled="pptBusy || !pptPlan || pptSlides.length === 0" @click="handleGenerateAllPptSlideImages">
                    生成整套图片
                  </button>
                  <button class="secondary mini" type="button" :disabled="!pptPlan" @click="handleExportPptHtml">
                    导出 HTML
                  </button>
                </div>
              </div>

              <div v-if="pptPlan" class="ppt-plan-summary">
                <section>
                  <span class="ppt-slide-label">整套摘要</span>
                  <p>{{ pptPlan.summary }}</p>
                </section>
                <section>
                  <span class="ppt-slide-label">受众</span>
                  <p>{{ pptPlan.targetAudience }}</p>
                </section>
                <section>
                  <span class="ppt-slide-label">叙事路径</span>
                  <p>{{ pptPlan.narrativeFlow }}</p>
                </section>
              </div>
            </div>
          </div>

          <div v-if="pptSidebarTab === 'tasks'" class="ppt-sidebar-body">
            <div class="ppt-task-records">
              <div class="ppt-task-records-header">
                <span class="ppt-slide-label">任务记录</span>
                <button class="secondary mini" type="button" :disabled="conversationBusy" @click="startNewPptTask">
                  新建任务
                </button>
              </div>
              <div class="ppt-task-records-list">
                <button
                  v-for="conversation in pptTaskRecords"
                  :key="conversation.id"
                  class="ppt-task-record"
                  :class="{ active: conversation.id === currentConversationId }"
                  type="button"
                  :disabled="conversationBusy"
                  @click="handlePptTaskSelect(conversation.id); pptConfigPanelOpen = false"
                >
                  <strong>{{ conversation.title }}</strong>
                  <span>{{ conversation.updatedAt }}</span>
                </button>
                <p v-if="pptTaskRecords.length === 0" class="empty">还没有任务记录。</p>
              </div>
            </div>
          </div>
        </aside>
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
              <details v-if="createMode === 'chat' && displayImageCompareGroup" class="compare-inline-menu">
                <summary>
                  <strong>版本 {{ displayImageComparePosition }}</strong>
                  <span>{{ displayImageCompareGroup.images.length }}</span>
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </summary>
                <div class="compare-inline-strip" role="listbox" aria-label="多版本切换">
                  <button
                    v-for="(entry, compareIndex) in displayImageCompareGroup.images"
                    :key="imageShareKey(entry.image, entry.index)"
                    class="compare-chip"
                    :class="{ active: entry.index === displayImageIndex }"
                    type="button"
                    @click="selectCanvasImage(entry.index)"
                  >
                    版本 {{ compareIndex + 1 }}
                  </button>
                </div>
              </details>
              <select v-if="createMode === 'direct'" v-model="imageSize" title="图片尺寸">
                <option v-for="option in imageSizeOptions" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
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
                v-for="conversation in createTaskRecords"
                :key="conversation.id"
                class="session-item"
                :class="{ active: conversation.id === currentConversationId }"
                type="button"
                :disabled="conversationBusy"
                @click="handleCreateConversationSelect(conversation.id)"
              >
                <strong>{{ conversation.title }}</strong>
                <span>{{ conversation.lastMessageAt || conversation.updatedAt }}</span>
              </button>
              <p v-if="createTaskRecords.length === 0" class="empty">暂无会话。</p>
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
      v-if="selectedImage || selectedGalleryItem || selectedLibraryItem"
      class="image-modal"
      role="dialog"
      aria-modal="true"
      aria-label="图片详情"
      @click.self="closeImageModal"
    >
      <article class="image-modal-card">
        <button class="modal-close" type="button" aria-label="关闭图片详情" @click="closeImageModal">×</button>
        <div class="modal-image-column">
          <div class="modal-image-wrap" :class="{ 'local-edit-active': localEditOpen && (selectedImage || selectedLibraryItem) }">
            <div v-if="(selectedImage || selectedLibraryItem) && localEditOpen" class="local-edit-stage">
              <img
                ref="localEditImageElement"
                :src="selectedImage ? imageDownloadUrl(selectedImage) : (selectedLibraryItem?.originalUrl || selectedLibraryItem?.image_url || selectedLibraryItem?.imageUrl || '')"
                :alt="selectedImage?.prompt || selectedLibraryItem?.prompt || ''"
                loading="lazy"
                @load="handleLocalEditImageLoad"
                @error="selectedImage
                  ? handleGeneratedImageError($event, selectedImage)
                  : (selectedLibraryItem ? handleLibraryImageError($event, selectedLibraryItem) : undefined)"
              />
              <canvas
                ref="localEditMaskCanvas"
                class="local-edit-mask-canvas"
                aria-label="遮罩画笔"
                @pointerdown="startLocalEditMaskStroke"
                @pointermove="moveLocalEditMaskStroke"
                @pointerup="stopLocalEditMaskStroke"
                @pointercancel="stopLocalEditMaskStroke"
              ></canvas>
            </div>
            <img
              v-else
              :src="selectedImage
                ? imagePreviewUrl(selectedImage, modalPreviewWidth)
                : (selectedLibraryItem ? libraryModalUrl(selectedLibraryItem) : (selectedGalleryItem ? galleryModalUrl(selectedGalleryItem) : ''))"
              :alt="selectedImage?.prompt || selectedLibraryItem?.prompt || selectedGalleryItem?.prompt"
              loading="lazy"
              @error="selectedImage
                ? handleGeneratedImageError($event, selectedImage)
                : (selectedLibraryItem ? handleLibraryImageError($event, selectedLibraryItem) : (selectedGalleryItem ? handleGalleryImageError($event, selectedGalleryItem) : undefined))"
            />
            <div class="modal-actions">
              <button
                v-if="selectedImage || selectedLibraryItem"
                class="icon-button"
                type="button"
                aria-label="复用参数再次生成"
                title="复用参数再次生成"
                @click="handleReuseSelectedImageParameters"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M21 12a9 9 0 1 1-2.64-6.36M21 4v6h-6" />
                </svg>
              </button>
              <button
                class="icon-button"
                type="button"
                aria-label="下载图片"
                @click="downloadImage(
                  selectedImage ? imageDownloadUrl(selectedImage) : (selectedLibraryItem?.originalUrl || selectedGalleryItem?.originalUrl || ''),
                  selectedImage?.prompt || selectedLibraryItem?.prompt || selectedGalleryItem?.prompt || 'gallery-image'
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
              <button
                v-if="selectedImage || selectedLibraryItem"
                class="icon-button"
                type="button"
                :class="{ active: localEditOpen }"
                :disabled="imageBusy"
                :aria-label="localEditOpen ? '关闭局部修改' : '局部修改'"
                :title="localEditOpen ? '关闭局部修改' : '局部修改'"
                @click="localEditOpen ? resetLocalEditState() : openLocalEditPanel()"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                </svg>
              </button>
              <button
                v-if="selectedLibraryItem"
                class="icon-button"
                type="button"
                :class="{ active: selectedLibraryItem.favorite }"
                :aria-label="selectedLibraryItem.favorite ? '取消收藏' : '收藏'"
                @click="toggleLibraryFavorite(selectedLibraryItem)"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m12 17.3-6.18 3.25 1.18-6.88L2 8.8l6.9-1L12 1.55l3.1 6.25 6.9 1-5 4.87 1.18 6.88L12 17.3Z" />
                </svg>
              </button>
              <button
                v-if="selectedLibraryItem"
                class="icon-button"
                type="button"
                aria-label="删除作品"
                @click="handleDeleteLibraryItem(selectedLibraryItem)"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M3 6h18M8 6V4h8v2M7 6l1 14h8l1-14" />
                </svg>
              </button>
            </div>
          </div>
          <form v-if="(selectedImage || selectedLibraryItem) && localEditOpen" class="local-edit-form" @submit.prevent="handleLocalEditSubmit">
            <div class="local-edit-toolbar">
              <label class="local-edit-brush-control">
                <span>画笔</span>
                <input
                  v-model.number="localEditBrushSize"
                  type="range"
                  min="12"
                  max="160"
                  step="4"
                  :disabled="imageBusy"
                />
                <output>{{ localEditBrushSize }}px</output>
              </label>
              <button
                class="local-edit-clear-btn"
                type="button"
                :disabled="imageBusy || !localEditMaskHasMarks"
                @click="clearLocalEditMask"
              >
                清除
              </button>
            </div>
            <div class="local-edit-prompt-row">
              <textarea
                v-model="localEditPrompt"
                rows="2"
                placeholder="描述只修改遮罩区域，例如：把天空换成戏剧性的日落"
                :disabled="imageBusy"
              ></textarea>
              <button class="canvas-submit-btn local-edit-submit-btn" :disabled="!canSubmitLocalEdit" type="submit">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M5 12h13M13 6l6 6-6 6" />
                </svg>
                {{ imageBusy ? '处理中...' : '提交修改' }}
              </button>
            </div>
          </form>
        </div>
        <div class="modal-copy">
          <p class="eyebrow">{{ selectedLibraryItem ? 'Library' : 'Prompt' }}</p>
          <h2>{{ selectedImage?.size || selectedLibraryItem?.size || selectedGalleryItem?.size }}</h2>
          <div class="modal-prompt-scroll">
            <p>{{ selectedImage?.prompt || selectedLibraryItem?.prompt || selectedGalleryItem?.prompt }}</p>
            <div v-if="selectedLibraryItem" class="library-modal-meta">
              <span>{{ libraryFolderLabel(selectedLibraryItem.folder) }}</span>
              <span v-for="tag in selectedLibraryItem.tags" :key="`modal-${selectedLibraryItem.id}-${tag}`">#{{ tag }}</span>
            </div>
          </div>
          <small>
            {{ selectedImage
              ? new Date(selectedImage.createdAt).toLocaleString()
              : (selectedLibraryItem
                ? `${selectedLibraryItem.favorite ? '已收藏 · ' : ''}${new Date(selectedLibraryItem.createdAt || '').toLocaleString()}`
                : `${selectedGalleryItem?.sharedByName || '匿名用户'} · ${new Date(selectedGalleryItem?.createdAt || '').toLocaleString()}`) }}
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
      <button class="toast-close" type="button" aria-label="关闭错误提示" @click="closeToast">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
    </div>
    <div v-if="successMessage" class="toast success" role="status">
      <span>{{ successMessage }}</span>
      <button class="toast-close" type="button" aria-label="关闭成功提示" @click="closeToast">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
    </div>
  </main>
</template>
