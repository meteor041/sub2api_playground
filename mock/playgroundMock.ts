import { createHash, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'

type JsonRecord = Record<string, unknown>
type NextFunction = (error?: unknown) => void

interface MockUserProfile {
  id: number
  email: string
  username: string
  role: 'admin' | 'user'
  status: string
  balance: number
  concurrency: number
}

interface MockGroup {
  id: number
  name: string
  description: string
  platform: string
  status: string
  rate_multiplier: number
  image_price_1k: number
  image_price_2k: number
  image_price_4k: number
}

interface MockApiKey {
  id: number
  user_id: number
  key: string
  name: string
  group_id: number
  status: 'active' | 'inactive' | 'quota_exhausted' | 'expired'
  quota: number
  quota_used: number
  group: MockGroup
}

interface MockConversation {
  id: string
  title: string
  workspaceType: 'create' | 'ppt'
  createdAt: string
  updatedAt: string
  lastMessageAt: string | null
  state: {
    workspaceType?: 'create' | 'ppt'
    chatMessages: JsonRecord[]
    generatedImages: JsonRecord[]
    pptState?: JsonRecord | null
  }
}

interface MockGalleryItem {
  id: string
  prompt: string
  size: string
  image_url: string
  imageUrl: string
  thumbnailUrl: string
  originalUrl: string
  sourceConversationId: string
  sourceImageId: string
  sharedByUserId: number
  sharedByName: string
  createdAt: string
}

interface MockLibraryFacet {
  name: string
  count: number
}

interface MockLibraryItem {
  id: string
  prompt: string
  size: string
  image_url: string
  imageUrl: string
  thumbnailUrl: string
  originalUrl: string
  sourceConversationId: string
  sourceImageId: string
  folder: string
  tags: string[]
  favorite: boolean
  createdAt: string
  updatedAt: string
}

interface MockTaskPayload extends JsonRecord {
  mode: 'generate' | 'edit'
  prompt: string
  size: string
  conversation_id: string | null
  assistant_message_id: string | null
}

interface MockTask {
  id: string
  userId: number
  apiKey: string
  payload: MockTaskPayload
  status: 'queued' | 'processing' | 'completed' | 'failed'
  createdAt: string
  updatedAt: string
  completeAfter: number
  archived: boolean
  error: string | null
  result: {
    images: Array<{
      id: string
      prompt: string
      size: string
      data_url: string | null
      remote_url: string | null
      image_url: string | null
    }>
    raw: JsonRecord
  } | null
}

const mockUser: MockUserProfile = {
  id: 10001,
  email: 'mock@example.com',
  username: 'Mock Tester',
  role: 'admin',
  status: 'active',
  balance: 128.8888,
  concurrency: 8
}

const openAiGroup: MockGroup = {
  id: 9001,
  name: 'MOCK OpenAI',
  description: 'Mock group for local playground testing',
  platform: 'openai',
  status: 'active',
  rate_multiplier: 1,
  image_price_1k: 0.01,
  image_price_2k: 0.02,
  image_price_4k: 0.04
}

let apiKeySequence = 1
let apiKeys: MockApiKey[] = [
  createMockApiKey('MOCK Playground Key')
]

const conversations = new Map<string, MockConversation>()
const tasks = new Map<string, MockTask>()
const galleryItems: MockGalleryItem[] = seedGalleryItems()
const libraryItems: MockLibraryItem[] = seedLibraryItems()
const deletedLibrarySources = new Set<string>()

function createMockApiKey(name: string): MockApiKey {
  const id = apiKeySequence
  apiKeySequence += 1
  return {
    id,
    user_id: mockUser.id,
    key: `sk-mock-${randomUUID().replace(/-/g, '')}`,
    name,
    group_id: openAiGroup.id,
    status: 'active',
    quota: 1000000,
    quota_used: 0,
    group: openAiGroup
  }
}

function playgroundMockPlugin(enabled: boolean, latencyMs: number): Plugin {
  return {
    name: 'image-playground-mock-api',
    apply: 'serve',
    configureServer(server) {
      if (!enabled) {
        return
      }

      server.config.logger.info('[mock] image-playground mock API enabled')
      server.middlewares.use((req, res, next) => {
        void handleMockRequest(req, res, latencyMs)
          .then((handled) => {
            if (!handled) {
              next()
            }
          })
          .catch((error) => {
            if (res.headersSent) {
              next(error)
              return
            }
            const statusCode = getErrorStatus(error)
            sendJson(res, statusCode, {
              code: statusCode,
              message: error instanceof Error ? error.message : 'Mock API error'
            })
          })
      })
    }
  }
}

export function createPlaygroundMockPlugin(options: {
  enabled: boolean
  latencyMs?: number
}): Plugin {
  return playgroundMockPlugin(options.enabled, Math.max(0, options.latencyMs ?? 180))
}

async function handleMockRequest(
  req: IncomingMessage,
  res: ServerResponse,
  latencyMs: number
): Promise<boolean> {
  const url = new URL(req.url || '/', 'http://mock.local')
  const method = (req.method || 'GET').toUpperCase()

  if (!isMockPath(url.pathname)) {
    return false
  }

  if (latencyMs > 0) {
    await sleep(latencyMs)
  }

  if (method === 'GET' && url.pathname === '/health') {
    sendText(res, 200, 'ok\n')
    return true
  }

  if (method === 'POST' && url.pathname === '/api/v1/auth/login') {
    await readJsonBody(req)
    sendJson(res, 200, envelope({
      access_token: 'mock-access-token',
      refresh_token: 'mock-refresh-token',
      expires_in: 24 * 60 * 60,
      user: mockUser
    }))
    return true
  }

  if (method === 'POST' && url.pathname === '/api/v1/auth/logout') {
    await readJsonBody(req)
    sendJson(res, 200, envelope({ ok: true }))
    return true
  }

  if (method === 'GET' && url.pathname === '/api/v1/user/profile') {
    requireMockAuth(req)
    sendJson(res, 200, envelope(mockUser))
    return true
  }

  if (method === 'GET' && url.pathname === '/api/v1/keys') {
    requireMockAuth(req)
    sendJson(res, 200, envelope({
      items: apiKeys,
      total: apiKeys.length,
      page: Number.parseInt(url.searchParams.get('page') || '1', 10) || 1,
      page_size: Number.parseInt(url.searchParams.get('page_size') || '100', 10) || 100
    }))
    return true
  }

  if (method === 'POST' && url.pathname === '/api/v1/keys') {
    requireMockAuth(req)
    const body = await readJsonBody(req)
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'Image Playground'
    const key = createMockApiKey(name)
    apiKeys = [key, ...apiKeys]
    sendJson(res, 201, envelope(key))
    return true
  }

  if (method === 'GET' && url.pathname === '/api/v1/groups/available') {
    requireMockAuth(req)
    sendJson(res, 200, envelope([openAiGroup]))
    return true
  }

  if (method === 'POST' && url.pathname === '/v1/responses') {
    requireMockBearerApiKey(req)
    const body = await readJsonBody(req)
    sendJson(res, 200, buildMockResponse(body))
    return true
  }

  if (method === 'POST' && (url.pathname === '/v1/images/generations' || url.pathname === '/v1/images/edits')) {
    requireMockBearerApiKey(req)
    const body = url.pathname.endsWith('/generations') ? await readJsonBody(req) : {}
    const prompt = typeof body.prompt === 'string' ? body.prompt : 'Mock image generation'
    const size = typeof body.size === 'string' ? body.size : '1024x1024'
    sendJson(res, 200, {
      created: Math.floor(Date.now() / 1000),
      data: [{
        url: createMockImageDataUrl(prompt, size, url.pathname.endsWith('/edits') ? 'MOCK EDIT' : 'MOCK IMAGE')
      }]
    })
    return true
  }

  if (method === 'GET' && url.pathname === '/api/playground/gallery') {
    const limit = clampInt(url.searchParams.get('limit'), 8, 1, 12)
    const offset = clampInt(url.searchParams.get('offset'), 0, 0, galleryItems.length)
    const items = galleryItems.slice(offset, offset + limit)
    const nextOffset = offset + items.length < galleryItems.length ? offset + items.length : null
    sendJson(res, 200, envelope({
      items,
      nextOffset,
      hasMore: nextOffset !== null
    }))
    return true
  }

  if (method === 'POST' && url.pathname === '/api/playground/gallery') {
    requireMockAuth(req)
    const body = await readJsonBody(req)
    sendJson(res, 201, envelope(shareMockGalleryImage(body)))
    return true
  }

  if (method === 'GET' && url.pathname === '/api/playground/library') {
    requireMockAuth(req)
    sendJson(res, 200, envelope(listMockLibraryItems(url)))
    return true
  }

  if (method === 'POST' && url.pathname === '/api/playground/library/batch') {
    requireMockAuth(req)
    const body = await readJsonBody(req)
    sendJson(res, 200, envelope(batchUpdateMockLibraryItems(body)))
    return true
  }

  const libraryItemId = matchPath(url.pathname, '/api/playground/library/')
  if (libraryItemId && method === 'PATCH') {
    requireMockAuth(req)
    const body = await readJsonBody(req)
    sendJson(res, 200, envelope(updateMockLibraryItem(libraryItemId, body)))
    return true
  }

  if (libraryItemId && method === 'DELETE') {
    requireMockAuth(req)
    sendJson(res, 200, envelope(deleteMockLibraryItems([libraryItemId])))
    return true
  }

  if (method === 'GET' && url.pathname === '/api/playground/conversations') {
    requireMockAuth(req)
    sendJson(res, 200, envelope(Array.from(conversations.values()).map(summarizeConversation).sort(sortByUpdatedDesc)))
    return true
  }

  if (method === 'POST' && url.pathname === '/api/playground/ppt/export') {
    requireMockAuth(req)
    throw createMockError(501, 'Mock 模式暂不支持导出 PPTX，请切到真实后端验证。')
  }

  if (method === 'POST' && url.pathname === '/api/playground/conversations') {
    requireMockAuth(req)
    const body = await readJsonBody(req)
    const requestedTitle = typeof body.title === 'string' ? body.title.trim() : ''
    const workspaceType = body.workspace_type === 'ppt' ? 'ppt' : 'create'
    const conversation = createMockConversation(requestedTitle, workspaceType)
    conversations.set(conversation.id, conversation)
    sendJson(res, 201, envelope(summarizeConversation(conversation)))
    return true
  }

  const conversationId = matchPath(url.pathname, '/api/playground/conversations/')
  if (conversationId && method === 'GET') {
    requireMockAuth(req)
    const conversation = getConversationOrThrow(conversationId)
    sendJson(res, 200, envelope({
      conversation: summarizeConversation(conversation),
      state: conversation.state
    }))
    return true
  }

  if (conversationId && method === 'PUT') {
    requireMockAuth(req)
    const body = await readJsonBody(req)
    const conversation = getConversationOrThrow(conversationId)
    conversation.state = {
      workspaceType: body.workspaceType === 'ppt' ? 'ppt' : (body.workspaceType === 'create' ? 'create' : conversation.workspaceType),
      chatMessages: Array.isArray(body.chatMessages) ? body.chatMessages as JsonRecord[] : [],
      generatedImages: Array.isArray(body.generatedImages) ? body.generatedImages as JsonRecord[] : [],
      pptState: body.pptState && typeof body.pptState === 'object' && !Array.isArray(body.pptState)
        ? body.pptState as JsonRecord
        : null
    }
    upsertMockLibraryFromConversation(conversation)
    touchConversation(conversation)
    sendJson(res, 200, envelope({
      savedAt: conversation.updatedAt,
      title: conversation.title
    }))
    return true
  }

  if (method === 'POST' && url.pathname === '/api/playground/tasks') {
    requireMockAuth(req)
    const body = await readJsonBody(req)
    const task = createMockTask(body)
    tasks.set(task.id, task)
    sendJson(res, 202, envelope({
      task_id: task.id,
      status: task.status
    }, 'accepted'))
    return true
  }

  const taskId = matchPath(url.pathname, '/api/playground/tasks/')
  if (taskId && method === 'GET') {
    requireMockAuth(req)
    const task = tasks.get(taskId)
    if (!task) {
      throw httpError(404, 'Task not found')
    }
    refreshTask(task)
    sendJson(res, 200, envelope(buildTaskResponse(task)))
    return true
  }

  throw httpError(404, `No mock route for ${method} ${url.pathname}`)
}

function isMockPath(pathname: string): boolean {
  return pathname === '/health' ||
    pathname.startsWith('/api/v1/') ||
    pathname.startsWith('/v1/') ||
    pathname.startsWith('/api/playground/')
}

function envelope<T>(data: T, message = 'success'): { code: number; message: string; data: T } {
  return {
    code: 0,
    message,
    data
  }
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(body)),
    'Content-Type': 'application/json; charset=utf-8'
  })
  res.end(body)
}

function sendText(res: ServerResponse, statusCode: number, body: string): void {
  res.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(body)),
    'Content-Type': 'text/plain; charset=utf-8'
  })
  res.end(body)
}

function readJsonBody(req: IncomingMessage): Promise<JsonRecord> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0

    req.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buffer.length
      if (total > 50 * 1024 * 1024) {
        reject(httpError(413, 'Mock request body too large'))
        req.destroy()
        return
      }
      chunks.push(buffer)
    })

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(raw)
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonRecord : {})
      } catch {
        reject(httpError(400, 'Invalid JSON body'))
      }
    })

    req.on('error', reject)
  })
}

function getAuthorization(req: IncomingMessage): string {
  const value = req.headers.authorization
  return typeof value === 'string' ? value.trim() : ''
}

function requireMockAuth(req: IncomingMessage): void {
  if (!getAuthorization(req).toLowerCase().startsWith('bearer ')) {
    throw httpError(401, 'Authorization header is required in mock mode')
  }
}

function requireMockBearerApiKey(req: IncomingMessage): void {
  const auth = getAuthorization(req)
  if (!auth.toLowerCase().startsWith('bearer sk-mock-')) {
    throw httpError(401, 'Use the mock API key returned by /api/v1/keys')
  }
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number }
  error.statusCode = statusCode
  return error
}

function getErrorStatus(error: unknown): number {
  if (error && typeof error === 'object' && Number.isInteger((error as { statusCode?: number }).statusCode)) {
    return (error as { statusCode: number }).statusCode
  }
  return 500
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value || '', 10)
  if (!Number.isFinite(parsed)) {
    return fallback
  }
  return Math.min(Math.max(parsed, min), max)
}

function matchPath(pathname: string, prefix: string): string {
  if (!pathname.startsWith(prefix)) {
    return ''
  }
  return decodeURIComponent(pathname.slice(prefix.length))
}

function nowIso(): string {
  return new Date().toISOString()
}

function createMockConversation(requestedTitle = '', workspaceType: 'create' | 'ppt' = 'create'): MockConversation {
  const createdAt = nowIso()
  return {
    id: randomUUID(),
    title: requestedTitle || '新会话',
    workspaceType,
    createdAt,
    updatedAt: createdAt,
    lastMessageAt: null,
    state: {
      workspaceType,
      chatMessages: [],
      generatedImages: [],
      pptState: null
    }
  }
}

function getConversationOrThrow(conversationId: string): MockConversation {
  const conversation = conversations.get(conversationId)
  if (!conversation) {
    throw httpError(404, 'Conversation not found')
  }
  return conversation
}

function summarizeConversation(conversation: MockConversation): JsonRecord {
  return {
    id: conversation.id,
    title: conversation.title,
    workspaceType: conversation.workspaceType,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    lastMessageAt: conversation.lastMessageAt
  }
}

function sortByUpdatedDesc(left: JsonRecord, right: JsonRecord): number {
  return Date.parse(String(right.updatedAt || right.createdAt || '')) -
    Date.parse(String(left.updatedAt || left.createdAt || ''))
}

function touchConversation(conversation: MockConversation): void {
  const updatedAt = nowIso()
  conversation.updatedAt = updatedAt
  conversation.lastMessageAt = conversation.state.chatMessages.length > 0 ? updatedAt : null
  conversation.workspaceType = conversation.state.workspaceType === 'ppt' ? 'ppt' : 'create'
  conversation.title = deriveConversationTitle(conversation.state)
}

function deriveConversationTitle(state: { chatMessages?: JsonRecord[]; pptState?: JsonRecord | null }): string {
  const messages = Array.isArray(state.chatMessages) ? state.chatMessages : []
  const firstUserMessage = messages.find((message) => message.role === 'user')
  const title = extractMessageText(firstUserMessage).trim()
  if (title) {
    return title.length > 28 ? `${title.slice(0, 28)}...` : title
  }

  const pptState = state.pptState && typeof state.pptState === 'object' ? state.pptState : null
  const projectTitle = typeof pptState?.plan?.projectTitle === 'string' ? pptState.plan.projectTitle.trim() : ''
  if (projectTitle) {
    return projectTitle.length > 28 ? `${projectTitle.slice(0, 28)}...` : projectTitle
  }
  const prompt = typeof pptState?.prompt === 'string' ? pptState.prompt.trim() : ''
  if (prompt) {
    return prompt.length > 28 ? `${prompt.slice(0, 28)}...` : prompt
  }

  return '新会话'
}

function extractMessageText(message: unknown): string {
  if (!message || typeof message !== 'object') {
    return ''
  }
  const content = (message as JsonRecord).content
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') {
        return ''
      }
      const record = part as JsonRecord
      return typeof record.text === 'string' ? record.text : ''
    })
    .filter(Boolean)
    .join(' ')
}

function buildMockResponse(body: JsonRecord): JsonRecord {
  const input = extractLatestUserInput(body.input)
  const shouldCallImage = input.hasImage || shouldTriggerImageTool(input.text)
  mockUser.balance = Math.max(0, mockUser.balance - 0.0012)

  if (shouldCallImage) {
    const prompt = input.text || (input.hasImage ? 'Edit the uploaded image with a cinematic mock style.' : 'Create a mock image.')
    return {
      id: `resp_${randomUUID()}`,
      object: 'response',
      status: 'completed',
      output: [{
        type: 'function_call',
        id: `fc_${randomUUID()}`,
        call_id: `call_${randomUUID()}`,
        name: input.hasImage ? 'edit_image' : 'generate_image',
        arguments: JSON.stringify({
          prompt,
          size: '1024x1024',
          n: 1
        })
      }]
    }
  }

  const reply = input.text
    ? `MOCK 回复：已收到“${input.text.slice(0, 80)}”。当前环境不会调用真实模型或扣费。`
    : 'MOCK 回复：请输入内容，或上传图片后描述要编辑的效果。'

  return {
    id: `resp_${randomUUID()}`,
    object: 'response',
    status: 'completed',
    output_text: reply,
    output: [{
      type: 'message',
      role: 'assistant',
      content: [{
        type: 'output_text',
        text: reply
      }]
    }]
  }
}

function extractLatestUserInput(input: unknown): { text: string; hasImage: boolean } {
  if (!Array.isArray(input)) {
    return { text: '', hasImage: false }
  }

  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index]
    if (!item || typeof item !== 'object' || (item as JsonRecord).role !== 'user') {
      continue
    }
    const content = (item as JsonRecord).content
    if (typeof content === 'string') {
      return { text: content.trim(), hasImage: false }
    }
    if (!Array.isArray(content)) {
      return { text: '', hasImage: false }
    }
    const textParts: string[] = []
    let hasImage = false
    for (const part of content) {
      if (!part || typeof part !== 'object') {
        continue
      }
      const record = part as JsonRecord
      if (typeof record.text === 'string') {
        textParts.push(record.text)
      }
      if (record.type === 'input_image' || typeof record.image_url === 'string') {
        hasImage = true
      }
    }
    return {
      text: textParts.join('\n').trim(),
      hasImage
    }
  }

  return { text: '', hasImage: false }
}

function shouldTriggerImageTool(text: string): boolean {
  return /(画|绘制|图|图片|照片|头像|海报|插画|生成|生图|渲染|draw|image|picture|photo|poster|illustration|render|generate|create)/i.test(text)
}

function createMockTask(body: JsonRecord): MockTask {
  const apiKey = typeof body.api_key === 'string' ? body.api_key.trim() : ''
  if (!apiKey) {
    throw httpError(400, 'api_key is required')
  }
  const rawPayload = body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
    ? body.payload as JsonRecord
    : null
  if (!rawPayload) {
    throw httpError(400, 'payload is required')
  }
  const prompt = typeof rawPayload.prompt === 'string' ? rawPayload.prompt.trim() : ''
  const size = typeof rawPayload.size === 'string' ? rawPayload.size.trim() : ''
  if (!prompt) {
    throw httpError(400, 'payload.prompt is required')
  }
  if (!size) {
    throw httpError(400, 'payload.size is required')
  }

  const payload: MockTaskPayload = {
    ...rawPayload,
    mode: rawPayload.mode === 'edit' ? 'edit' : 'generate',
    prompt,
    size,
    conversation_id: typeof rawPayload.conversation_id === 'string' ? rawPayload.conversation_id : null,
    assistant_message_id: typeof rawPayload.assistant_message_id === 'string' ? rawPayload.assistant_message_id : null
  }
  const createdAt = nowIso()
  return {
    id: randomUUID(),
    userId: mockUser.id,
    apiKey,
    payload,
    status: 'queued',
    createdAt,
    updatedAt: createdAt,
    completeAfter: Date.now() + 900,
    archived: false,
    error: null,
    result: null
  }
}

function refreshTask(task: MockTask): void {
  if (task.status === 'completed' || task.status === 'failed') {
    return
  }

  const now = Date.now()
  if (now < task.completeAfter - 450) {
    task.status = 'queued'
  } else if (now < task.completeAfter) {
    task.status = 'processing'
  } else {
    task.status = 'completed'
    task.result = buildTaskResult(task)
    mockUser.balance = Math.max(0, mockUser.balance - 0.02)
    archiveTaskToConversation(task)
  }
  task.updatedAt = nowIso()
}

function buildTaskResult(task: MockTask): NonNullable<MockTask['result']> {
  const dataUrl = createMockImageDataUrl(
    task.payload.prompt,
    task.payload.size,
    task.payload.mode === 'edit' ? 'MOCK EDIT' : 'MOCK IMAGE'
  )
  return {
    images: [{
      id: 'image-1',
      prompt: task.payload.prompt,
      size: task.payload.size,
      data_url: dataUrl,
      remote_url: null,
      image_url: null
    }],
    raw: {
      mock: true,
      mode: task.payload.mode
    }
  }
}

function archiveTaskToConversation(task: MockTask): void {
  if (task.archived || !task.payload.conversation_id || !task.result) {
    return
  }

  const conversation = conversations.get(task.payload.conversation_id)
  if (!conversation) {
    task.archived = true
    return
  }

  const images = task.result.images.map((image, index) => ({
    id: `${task.id}-${image.id || index + 1}`,
    shareKey: `${task.id}-${image.id || index + 1}`,
    prompt: image.prompt,
    size: image.size,
    dataUrl: image.data_url || undefined,
    remoteUrl: image.remote_url || undefined,
    image_url: image.image_url || undefined,
    createdAt: Date.now()
  }))
  conversation.state.generatedImages = [
    ...images,
    ...conversation.state.generatedImages
  ]

  const firstImage = images[0]
  const assistantMessageId = task.payload.assistant_message_id || `assistant-image-${task.id}`
  const assistantMessage = {
    id: assistantMessageId,
    role: 'assistant',
    content: task.payload.mode === 'edit'
      ? `已按要求编辑图片：${task.payload.prompt}`
      : `已根据提示词生成图片：${task.payload.prompt}`,
    createdAt: Date.now(),
    imageDataUrl: firstImage?.dataUrl
  }
  const existingIndex = conversation.state.chatMessages.findIndex((message) => message.id === assistantMessageId)
  if (existingIndex >= 0) {
    conversation.state.chatMessages.splice(existingIndex, 1, {
      ...conversation.state.chatMessages[existingIndex],
      ...assistantMessage
    })
  } else {
    conversation.state.chatMessages.push(assistantMessage)
  }

  task.archived = true
  upsertMockLibraryFromConversation(conversation)
  touchConversation(conversation)
}

function buildTaskResponse(task: MockTask): JsonRecord {
  return {
    task_id: task.id,
    status: task.status,
    conversation_id: task.payload.conversation_id,
    mode: task.payload.mode,
    prompt: task.payload.prompt,
    size: task.payload.size,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    error: task.error,
    result: task.result
  }
}

function shareMockGalleryImage(body: JsonRecord): JsonRecord {
  const conversationId = typeof body.conversation_id === 'string' ? body.conversation_id : ''
  const imageId = typeof body.image_id === 'string' ? body.image_id : ''
  if (!conversationId || !imageId) {
    throw httpError(400, 'conversation_id and image_id are required')
  }

  const conversation = getConversationOrThrow(conversationId)
  const image = conversation.state.generatedImages.find((item) => item.id === imageId)
  if (!image) {
    throw httpError(404, 'Generated image not found in this conversation')
  }

  const source = pickString(image.image_url) || pickString(image.dataUrl) || pickString(image.remoteUrl)
  if (!source) {
    throw httpError(409, 'Image is not available for sharing')
  }

  const existing = galleryItems.find((item) => item.sourceConversationId === conversationId && item.sourceImageId === imageId)
  if (existing) {
    return {
      item: existing,
      alreadyExists: true
    }
  }

  const item: MockGalleryItem = {
    id: randomUUID(),
    prompt: pickString(image.prompt) || 'Mock shared image',
    size: pickString(image.size) || '1024x1024',
    image_url: source,
    imageUrl: source,
    thumbnailUrl: source,
    originalUrl: source,
    sourceConversationId: conversationId,
    sourceImageId: imageId,
    sharedByUserId: mockUser.id,
    sharedByName: mockUser.username,
    createdAt: nowIso()
  }
  galleryItems.unshift(item)
  return {
    item,
    alreadyExists: false
  }
}

function normalizeMockFolder(value: unknown): string {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 64)
}

function normalizeMockTags(value: unknown): string[] {
  const rawTags = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(/[,\n，]+/) : [])
  const tags: string[] = []
  const seen = new Set<string>()
  for (const rawTag of rawTags) {
    const tag = String(rawTag || '').trim().replace(/^#+/, '').replace(/\s+/g, ' ').slice(0, 32)
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

function librarySourceKey(conversationId: string, imageId: string): string {
  return `${conversationId}:${imageId}`
}

function upsertMockLibraryFromConversation(conversation: MockConversation): void {
  for (const image of conversation.state.generatedImages) {
    const sourceImageId = pickString(image.id)
    const source = pickString(image.image_url) || pickString(image.dataUrl) || pickString(image.remoteUrl)
    if (!sourceImageId || !source || deletedLibrarySources.has(librarySourceKey(conversation.id, sourceImageId))) {
      continue
    }

    const existing = libraryItems.find((item) => (
      item.sourceConversationId === conversation.id &&
      item.sourceImageId === sourceImageId
    ))
    if (existing) {
      existing.prompt = pickString(image.prompt) || existing.prompt
      existing.size = pickString(image.size) || existing.size
      existing.image_url = source
      existing.imageUrl = source
      existing.thumbnailUrl = source
      existing.originalUrl = source
      continue
    }

    const createdAt = Number.isFinite(Number(image.createdAt))
      ? new Date(Number(image.createdAt)).toISOString()
      : nowIso()
    libraryItems.unshift({
      id: randomUUID(),
      prompt: pickString(image.prompt) || 'Mock library image',
      size: pickString(image.size) || '1024x1024',
      image_url: source,
      imageUrl: source,
      thumbnailUrl: source,
      originalUrl: source,
      sourceConversationId: conversation.id,
      sourceImageId,
      folder: '',
      tags: [],
      favorite: false,
      createdAt,
      updatedAt: createdAt
    })
  }
}

function buildMockFacets(items: MockLibraryItem[], key: 'folder' | 'tags'): MockLibraryFacet[] {
  const counts = new Map<string, number>()
  for (const item of items) {
    const values = key === 'folder' ? [item.folder] : item.tags
    for (const value of values) {
      counts.set(value, (counts.get(value) || 0) + 1)
    }
  }
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
}

function listMockLibraryItems(url: URL): JsonRecord {
  const limit = clampInt(url.searchParams.get('limit'), 24, 1, 60)
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, libraryItems.length)
  const query = (url.searchParams.get('q') || '').trim().toLowerCase()
  const folderParam = url.searchParams.has('folder') ? String(url.searchParams.get('folder') || '') : ''
  const hasFolderFilter = url.searchParams.has('folder')
  const folder = folderParam === '__none' ? '' : normalizeMockFolder(folderParam)
  const tag = normalizeMockTags([url.searchParams.get('tag') || ''])[0] || ''
  const favoriteOnly = url.searchParams.get('favorite') === '1'
  const filtered = libraryItems.filter((item) => {
    const haystack = [
      item.prompt,
      item.size,
      item.folder,
      item.sourceImageId,
      ...item.tags
    ].join(' ').toLowerCase()
    return (!query || haystack.includes(query)) &&
      (!hasFolderFilter || item.folder === folder) &&
      (!tag || item.tags.some((itemTag) => itemTag.toLowerCase() === tag.toLowerCase())) &&
      (!favoriteOnly || item.favorite)
  }).sort((left, right) => (
    Number(right.favorite) - Number(left.favorite) ||
    Date.parse(right.createdAt) - Date.parse(left.createdAt)
  ))
  const items = filtered.slice(offset, offset + limit)
  const nextOffset = offset + items.length < filtered.length ? offset + items.length : null
  return {
    items,
    nextOffset,
    hasMore: nextOffset !== null,
    folders: buildMockFacets(libraryItems, 'folder'),
    tags: buildMockFacets(libraryItems, 'tags'),
    total: filtered.length
  }
}

function updateMockLibraryItem(itemId: string, body: JsonRecord): MockLibraryItem {
  const item = libraryItems.find((candidate) => candidate.id === itemId)
  if (!item) {
    throw httpError(404, 'Library item not found')
  }
  if (Object.prototype.hasOwnProperty.call(body, 'folder')) {
    item.folder = normalizeMockFolder(body.folder)
  }
  if (Object.prototype.hasOwnProperty.call(body, 'tags')) {
    item.tags = normalizeMockTags(body.tags)
  }
  if (Object.prototype.hasOwnProperty.call(body, 'favorite')) {
    item.favorite = Boolean(body.favorite)
  }
  item.updatedAt = nowIso()
  return item
}

function deleteMockLibraryItems(ids: string[]): JsonRecord {
  let updated = 0
  for (const id of ids) {
    const index = libraryItems.findIndex((item) => item.id === id)
    if (index < 0) {
      continue
    }
    const [item] = libraryItems.splice(index, 1)
    deletedLibrarySources.add(librarySourceKey(item.sourceConversationId, item.sourceImageId))
    updated += 1
  }
  return { updated }
}

function batchUpdateMockLibraryItems(body: JsonRecord): JsonRecord {
  const ids = Array.isArray(body.ids) ? body.ids.map((id) => String(id)) : []
  const action = typeof body.action === 'string' ? body.action : ''
  const targets = libraryItems.filter((item) => ids.includes(item.id))
  if (action === 'delete') {
    return deleteMockLibraryItems(ids)
  }
  if (action === 'favorite' || action === 'unfavorite') {
    for (const item of targets) {
      item.favorite = action === 'favorite'
      item.updatedAt = nowIso()
    }
    return { updated: targets.length }
  }
  if (action === 'move') {
    const folder = normalizeMockFolder(body.folder)
    for (const item of targets) {
      item.folder = folder
      item.updatedAt = nowIso()
    }
    return { updated: targets.length }
  }
  if (action === 'add_tags' || action === 'remove_tags' || action === 'set_tags') {
    const tags = normalizeMockTags(body.tags)
    for (const item of targets) {
      if (action === 'set_tags') {
        item.tags = tags
      } else if (action === 'add_tags') {
        item.tags = normalizeMockTags([...item.tags, ...tags])
      } else {
        const removeSet = new Set(tags.map((tag) => tag.toLowerCase()))
        item.tags = item.tags.filter((tag) => !removeSet.has(tag.toLowerCase()))
      }
      item.updatedAt = nowIso()
    }
    return { updated: targets.length }
  }
  throw httpError(400, 'Unsupported library batch action')
}

function pickString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function seedGalleryItems(): MockGalleryItem[] {
  const seeds = [
    {
      prompt: 'MOCK 赛博城市雨夜，霓虹招牌和湿润街道反光',
      size: '1024x1536'
    },
    {
      prompt: 'MOCK 复古科幻海报，绿色胶片颗粒和巨大行星',
      size: '1024x1024'
    },
    {
      prompt: 'MOCK 极简产品摄影，一台透明外壳的未来相机',
      size: '1536x1024'
    }
  ]

  return seeds.map((seed, index) => {
    const source = createMockImageDataUrl(seed.prompt, seed.size, 'MOCK GALLERY')
    return {
      id: `mock-gallery-${index + 1}`,
      prompt: seed.prompt,
      size: seed.size,
      image_url: source,
      imageUrl: source,
      thumbnailUrl: source,
      originalUrl: source,
      sourceConversationId: 'mock-gallery',
      sourceImageId: `mock-gallery-image-${index + 1}`,
      sharedByUserId: mockUser.id,
      sharedByName: mockUser.username,
      createdAt: new Date(Date.now() - index * 60 * 60 * 1000).toISOString()
    }
  })
}

function seedLibraryItems(): MockLibraryItem[] {
  const seeds = [
    {
      prompt: 'MOCK 私人角色设定，银白短发的未来侦探',
      size: '1024x1536',
      folder: '角色设计',
      tags: ['角色', '科幻'],
      favorite: true
    },
    {
      prompt: 'MOCK 产品主视觉，透明外壳耳机和冷白背景',
      size: '1536x1024',
      folder: '商业视觉',
      tags: ['产品', '海报'],
      favorite: false
    },
    {
      prompt: 'MOCK 建筑概念图，山谷中的玻璃美术馆',
      size: '1408x1056',
      folder: '',
      tags: ['建筑', '概念'],
      favorite: false
    }
  ]

  return seeds.map((seed, index) => {
    const source = createMockImageDataUrl(seed.prompt, seed.size, 'MOCK LIBRARY')
    const createdAt = new Date(Date.now() - index * 45 * 60 * 1000).toISOString()
    return {
      id: randomUUID(),
      prompt: seed.prompt,
      size: seed.size,
      image_url: source,
      imageUrl: source,
      thumbnailUrl: source,
      originalUrl: source,
      sourceConversationId: 'mock-library',
      sourceImageId: `mock-library-image-${index + 1}`,
      folder: seed.folder,
      tags: seed.tags,
      favorite: seed.favorite,
      createdAt,
      updatedAt: createdAt
    }
  })
}

function createMockImageDataUrl(prompt: string, size: string, label: string): string {
  const dimensions = parseImageSize(size)
  const hue = hashHue(prompt)
  const lines = wrapLabel(prompt || 'Mock generated image', 22, 4)
  const textLines = lines.map((line, index) =>
    `<text x="70" y="${dimensions.height - 210 + index * 42}" font-family="Verdana, sans-serif" font-size="30" fill="rgba(255,255,255,0.92)">${escapeXml(line)}</text>`
  ).join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${dimensions.width}" height="${dimensions.height}" viewBox="0 0 ${dimensions.width} ${dimensions.height}">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="hsl(${hue}, 72%, 48%)"/>
      <stop offset="48%" stop-color="hsl(${(hue + 64) % 360}, 78%, 36%)"/>
      <stop offset="100%" stop-color="hsl(${(hue + 146) % 360}, 76%, 20%)"/>
    </linearGradient>
    <radialGradient id="glow" cx="28%" cy="18%" r="70%">
      <stop offset="0%" stop-color="rgba(255,255,255,0.42)"/>
      <stop offset="100%" stop-color="rgba(255,255,255,0)"/>
    </radialGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>
  <rect width="100%" height="100%" fill="url(#glow)"/>
  <circle cx="${dimensions.width * 0.78}" cy="${dimensions.height * 0.24}" r="${Math.min(dimensions.width, dimensions.height) * 0.18}" fill="rgba(255,255,255,0.16)"/>
  <path d="M0 ${dimensions.height * 0.72} C ${dimensions.width * 0.28} ${dimensions.height * 0.55}, ${dimensions.width * 0.5} ${dimensions.height * 0.92}, ${dimensions.width} ${dimensions.height * 0.66} L ${dimensions.width} ${dimensions.height} L 0 ${dimensions.height} Z" fill="rgba(0,0,0,0.28)"/>
  <text x="70" y="105" font-family="Verdana, sans-serif" font-size="36" font-weight="700" fill="rgba(255,255,255,0.95)" letter-spacing="4">${escapeXml(label)}</text>
  <text x="70" y="155" font-family="Verdana, sans-serif" font-size="24" fill="rgba(255,255,255,0.76)">${escapeXml(size)}</text>
  ${textLines}
</svg>`

  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}

function parseImageSize(size: string): { width: number; height: number } {
  const match = /^(\d+)\s*x\s*(\d+)$/i.exec(size)
  if (!match) {
    return { width: 1024, height: 1024 }
  }
  const width = Number.parseInt(match[1], 10)
  const height = Number.parseInt(match[2], 10)
  return {
    width: Number.isFinite(width) && width > 0 ? width : 1024,
    height: Number.isFinite(height) && height > 0 ? height : 1024
  }
}

function hashHue(value: string): number {
  const hash = createHash('sha256').update(value || 'mock').digest('hex')
  return Number.parseInt(hash.slice(0, 6), 16) % 360
}

function wrapLabel(value: string, width: number, maxLines: number): string[] {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return ['Mock image']
  }
  const lines: string[] = []
  for (let index = 0; index < normalized.length && lines.length < maxLines; index += width) {
    lines.push(normalized.slice(index, index + width))
  }
  if (normalized.length > width * maxLines && lines.length > 0) {
    lines[lines.length - 1] = `${lines[lines.length - 1].slice(0, Math.max(0, width - 3))}...`
  }
  return lines
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
