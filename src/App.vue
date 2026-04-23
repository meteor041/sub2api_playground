<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  createApiKey,
  generateImage,
  getProfile,
  hasAuthToken,
  listApiKeys,
  listAvailableGroups,
  login,
  logout,
  sendResponsesRequest
} from './api'
import type { ApiKey, ChatImageAttachment, ChatMessage, GeneratedImage, Group, UserProfile } from './types'

const textModels = [
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'gpt-5.3-codex-spark',
  'gpt-5.2'
]

const imageModel = 'gpt-image-2'
const imageSizes = ['1024x1024', '1536x1024', '1024x1536']
const maxImageToolCallsPerTurn = 1
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
const imageToolInstructions = [
  'You are a helpful assistant.',
  'Reply in Chinese unless the user asks for another language.',
  'When the user explicitly asks you to create, draw, generate, render, illustrate, or make an image, call generate_image instead of only describing the prompt.',
  'Only call generate_image at most once in a single turn.',
  'If no image is needed, answer normally.'
].join(' ')

const isAuthenticated = ref(hasAuthToken())
const email = ref('')
const password = ref('')
const loginBusy = ref(false)
const loadingApp = ref(false)
const errorMessage = ref('')
const successMessage = ref('')

const profile = ref<UserProfile | null>(null)
const apiKeys = ref<ApiKey[]>([])
const groups = ref<Group[]>([])
const selectedApiKeyId = ref<number | null>(null)

const selectedTextModel = ref(textModels[0])
const chatInput = ref('')
const chatBusy = ref(false)
const chatMessages = ref<ChatMessage[]>([])
const composerImages = ref<ChatImageAttachment[]>([])
const composerFileInput = ref<HTMLInputElement | null>(null)

const imagePrompt = ref('')
const imageSize = ref(imageSizes[0])
const imageBusy = ref(false)
const generatedImages = ref<GeneratedImage[]>([])

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

function buildImageFilename(seed: string, index = 1): string {
  const safeSeed = sanitizeFilenamePart(seed) || 'playground-image'
  return `${safeSeed}-${index}.png`
}

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
  } catch (error) {
    setError(error instanceof Error ? error.message : '登录失败')
  } finally {
    loginBusy.value = false
  }
}

async function handleLogout(): Promise<void> {
  await logout()
  isAuthenticated.value = false
  profile.value = null
  apiKeys.value = []
  groups.value = []
  selectedApiKeyId.value = null
  chatInput.value = ''
  chatMessages.value = []
  composerImages.value = []
  if (composerFileInput.value) {
    composerFileInput.value.value = ''
  }
  generatedImages.value = []
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
    image_url: images[0]?.remoteUrl || null,
    preview_ready: true,
    note: 'The UI already has the generated image preview and will display it to the user.'
  })
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
      image_url: attachment.dataUrl
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

function messageImages(message: ChatMessage): string[] {
  const images = message.attachments?.map((image) => image.dataUrl) || []
  if (message.imageDataUrl) {
    images.push(message.imageDataUrl)
  }
  return images
}

async function downloadImage(source: string, filenameSeed: string, index = 1): Promise<void> {
  const filename = buildImageFilename(filenameSeed, index)
  try {
    if (source.startsWith('data:')) {
      triggerDownload(source, filename)
      return
    }

    const response = await fetch(source)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    const blob = await response.blob()
    const objectUrl = URL.createObjectURL(blob)
    try {
      triggerDownload(objectUrl, filename)
    } finally {
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
    }
  } catch {
    window.open(source, '_blank', 'noopener,noreferrer')
    setError('无法直接下载该图片，已为你打开原图链接。')
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

async function handleSendChat(): Promise<void> {
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

  try {
    const initialResponse = await sendResponsesRequest(apiKey, {
      model: selectedTextModel.value,
      instructions: imageToolInstructions,
      input: conversationInput,
      tools: [imageGenerationTool],
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
      return
    }

    const functionCall = functionCalls[0]
    if (functionCall.name !== 'generate_image') {
      throw new Error(`模型尝试调用未受支持的工具：${functionCall.name}`)
    }

    const toolArgs = parseGenerateImageToolArgs(functionCall)
    updateChatMessage(assistantMessage.id, {
      content: `模型已决定调用生图工具，正在生成 ${toolArgs.size} 图片...`
    })

    imageBusy.value = true
    let images: GeneratedImage[] = []
    try {
      const imageResponse = await generateImage(apiKey, {
        model: imageModel,
        prompt: toolArgs.prompt,
        size: toolArgs.size,
        n: toolArgs.n,
        response_format: 'b64_json'
      })
      images = extractGeneratedImages(imageResponse, toolArgs.prompt, toolArgs.size)
    } finally {
      imageBusy.value = false
    }

    if (images.length === 0) {
      throw new Error('图片生成成功，但响应中没有可展示的图片。')
    }

    generatedImages.value = [...images, ...generatedImages.value]

    let finalMessage = `已根据提示词生成图片：${toolArgs.prompt}`
    try {
      const finalResponse = await sendResponsesRequest(apiKey, {
        model: selectedTextModel.value,
        instructions: imageToolInstructions,
        input: [
          ...conversationInput,
          buildFunctionCallInput(functionCall),
          {
            type: 'function_call_output',
            call_id: functionCall.call_id,
            output: buildFunctionCallOutput(images, toolArgs.prompt, toolArgs.size)
          }
        ]
      })
      ensureResponseSucceeded(finalResponse)
      finalMessage = extractResponseText(finalResponse) || finalMessage
    } catch (error) {
      setError(error instanceof Error ? `图片已生成，但模型总结失败：${error.message}` : '图片已生成，但模型总结失败')
    }

    updateChatMessage(assistantMessage.id, {
      content: finalMessage,
      imageDataUrl: images[0].dataUrl || images[0].remoteUrl
    })
    if (!errorMessage.value) {
      setSuccess('模型已自动调用生图工具并完成生成。')
    }
    await refreshBalanceOnly()
  } catch (error) {
    chatMessages.value = chatMessages.value.filter((message) => message.id !== assistantMessage.id)
    setError(error instanceof Error ? error.message : '对话请求失败')
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
        prompt,
        size,
        dataUrl: b64 ? `data:image/png;base64,${b64}` : undefined,
        remoteUrl: remoteUrl || undefined,
        createdAt: Date.now()
      } satisfies GeneratedImage
    })
    .filter((item: GeneratedImage) => item.dataUrl || item.remoteUrl)
}

async function handleGenerateImage(): Promise<void> {
  const apiKey = selectedKeySecret.value
  const prompt = imagePrompt.value.trim()
  if (!apiKey) {
    setError('请先选择或创建一个 OpenAI 分组 API Key。')
    return
  }
  if (!prompt) {
    setError('请输入图片提示词。')
    return
  }

  imageBusy.value = true
  try {
    const data = await generateImage(apiKey, {
      model: imageModel,
      prompt,
      size: imageSize.value,
      n: 1,
      response_format: 'b64_json'
    })
    const images = extractGeneratedImages(data, prompt, imageSize.value)
    if (images.length === 0) {
      throw new Error('图片生成成功，但响应中没有可展示的图片。')
    }
    generatedImages.value = [...images, ...generatedImages.value]
    chatMessages.value.push({
      id: uid('assistant-image'),
      role: 'assistant',
      content: `已根据提示词生成图片：${prompt}`,
      createdAt: Date.now(),
      imageDataUrl: images[0].dataUrl || images[0].remoteUrl
    })
    imagePrompt.value = ''
    setSuccess('图片生成完成，余额已刷新。')
    await refreshBalanceOnly()
  } catch (error) {
    setError(error instanceof Error ? error.message : '图片生成失败')
  } finally {
    imageBusy.value = false
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
  if (isAuthenticated.value) {
    await refreshWorkspace()
  }
})
</script>

<template>
  <main class="shell">
    <section class="hero">
      <div>
        <p class="eyebrow">Sub2API Parallel Lab</p>
        <h1>对话和生图 Playground</h1>
        <p class="hero-copy">
          独立端口运行，复用 sub2api 的用户、余额、API Key、调度和扣费链路。
        </p>
      </div>
      <div class="status-card">
        <span>当前余额</span>
        <strong>{{ balanceLabel }}</strong>
        <small v-if="profile">{{ profile.email }}</small>
        <small v-else>未登录</small>
      </div>
    </section>

    <section v-if="!isAuthenticated" class="login-card panel">
      <div>
        <p class="eyebrow">Step 1</p>
        <h2>登录 sub2api 账号</h2>
        <p>使用现有账号登录后，Playground 会读取余额和可用 OpenAI 分组 API Key。</p>
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
          {{ loginBusy ? '登录中...' : '进入 Playground' }}
        </button>
      </form>
    </section>

    <template v-else>
      <section class="toolbar panel">
        <div>
          <p class="eyebrow">Step 2</p>
          <h2>选择 OpenAI API Key</h2>
          <p>文字对话和图片生成都会通过这个 Key 进入现有网关并扣费。</p>
        </div>
        <div class="toolbar-actions">
          <select v-model.number="selectedApiKeyId" :disabled="openAiApiKeys.length === 0">
            <option v-for="key in openAiApiKeys" :key="key.id" :value="key.id">
              {{ key.name }} / {{ key.group?.name || 'OpenAI' }}
            </option>
          </select>
          <button class="secondary" type="button" :disabled="loadingApp" @click="refreshWorkspace">
            {{ loadingApp ? '刷新中...' : '刷新' }}
          </button>
          <button v-if="openAiApiKeys.length === 0" type="button" @click="handleCreateApiKey">
            创建 Playground Key
          </button>
          <button class="ghost" type="button" @click="handleLogout">退出</button>
        </div>
      </section>

      <section class="workspace">
        <div class="chat panel">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Step 3</p>
              <h2>文字模型对话</h2>
            </div>
            <select v-model="selectedTextModel">
              <option v-for="model in textModels" :key="model" :value="model">{{ model }}</option>
            </select>
          </div>

          <div class="messages">
            <article v-if="chatMessages.length === 0" class="empty">
              先试一句：“帮我构思一张电影海报的提示词”。
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
                  :key="image"
                  class="message-image-card"
                >
                  <img
                    :src="image"
                    :alt="message.role === 'user' ? 'Uploaded image' : 'Generated image'"
                  />
                  <button
                    class="ghost mini"
                    type="button"
                    @click="downloadImage(image, message.content || `${message.role}-image`, index + 1)"
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
              <div v-if="composerImages.length > 0" class="composer-previews">
                <article v-for="image in composerImages" :key="image.id" class="composer-preview">
                  <img :src="image.dataUrl" :alt="image.name" />
                  <div class="composer-preview-meta">
                    <span>{{ image.name }}</span>
                    <button class="ghost mini" type="button" @click="removeComposerImage(image.id)">
                      移除
                    </button>
                  </div>
                </article>
              </div>
              <textarea
                v-model="chatInput"
                rows="4"
                placeholder="输入文字对话内容；支持粘贴图片或点击“添加图片”。当你明确要求画图时，文字模型会自动调用生图工具。"
                @paste="handleComposerPaste"
              />
              <div class="composer-tools">
                <button class="secondary" type="button" :disabled="chatBusy" @click="openComposerFilePicker">
                  添加图片
                </button>
                <span class="composer-hint">支持复制截图后直接粘贴，或选择本地图片一起发送。</span>
              </div>
            </div>
            <button :disabled="chatBusy || !selectedKeySecret" type="submit">
              {{ chatBusy ? '发送中...' : '发送对话' }}
            </button>
          </form>
        </div>

        <aside class="image panel">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Step 4</p>
              <h2>手动生图</h2>
            </div>
            <span class="pill">{{ imageModel }}</span>
          </div>

          <form class="image-form" @submit.prevent="handleGenerateImage">
            <label>
              图片尺寸
              <select v-model="imageSize">
                <option v-for="size in imageSizes" :key="size" :value="size">{{ size }}</option>
              </select>
            </label>
            <label>
              提示词
              <textarea
                v-model="imagePrompt"
                rows="7"
                placeholder="例如：一张复古科幻电影海报，绿色霓虹、胶片颗粒、强烈构图"
              />
            </label>
            <button :disabled="imageBusy || !selectedKeySecret" type="submit">
              {{ imageBusy ? '生成中...' : '生成图片' }}
            </button>
          </form>

          <div class="gallery">
            <article v-for="image in generatedImages" :key="image.id" class="image-card">
              <img v-if="image.dataUrl || image.remoteUrl" :src="image.dataUrl || image.remoteUrl" :alt="image.prompt" />
              <p>{{ image.prompt }}</p>
              <div class="image-card-footer">
                <span>{{ image.size }}</span>
                <button
                  class="ghost mini"
                  type="button"
                  @click="downloadImage(image.dataUrl || image.remoteUrl || '', image.prompt)"
                >
                  下载图片
                </button>
              </div>
            </article>
          </div>
        </aside>
      </section>
    </template>

    <p v-if="errorMessage" class="toast error">{{ errorMessage }}</p>
    <p v-if="successMessage" class="toast success">{{ successMessage }}</p>
  </main>
</template>
