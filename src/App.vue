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
  sendResponsesStream
} from './api'
import type { ApiKey, ChatMessage, GeneratedImage, Group, UserProfile } from './types'

const textModels = [
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'gpt-5.3-codex-spark',
  'gpt-5.2'
]

const imageModel = 'gpt-image-2'
const imageSizes = ['1024x1024', '1536x1024', '1024x1536']

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

function uid(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
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
  chatMessages.value = []
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

function buildConversationInput(): Array<{ role: string; content: string }> {
  return chatMessages.value
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-12)
    .map((message) => ({
      role: message.role,
      content: message.content
    }))
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

function appendChatMessageContent(id: string, delta: string): void {
  const index = chatMessages.value.findIndex((message) => message.id === id)
  if (index < 0) {
    return
  }
  const current = chatMessages.value[index]
  chatMessages.value.splice(index, 1, {
    ...current,
    content: `${current.content}${delta}`
  })
}

async function handleSendChat(): Promise<void> {
  const apiKey = selectedKeySecret.value
  const content = chatInput.value.trim()
  if (!apiKey) {
    setError('请先选择或创建一个 OpenAI 分组 API Key。')
    return
  }
  if (!content) {
    setError('请输入对话内容。')
    return
  }

  chatInput.value = ''
  chatBusy.value = true
  chatMessages.value.push({
    id: uid('user'),
    role: 'user',
    content,
    createdAt: Date.now()
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
    let receivedText = false
    const data = await sendResponsesStream(apiKey, {
      model: selectedTextModel.value,
      input: conversationInput
    }, (delta) => {
      if (!receivedText) {
        updateChatMessage(assistantMessage.id, { content: '' })
        receivedText = true
      }
      appendChatMessageContent(assistantMessage.id, delta)
    })
    if (!receivedText) {
      updateChatMessage(assistantMessage.id, {
        content: extractResponseText(data) || '（模型没有返回文本）'
      })
    }
    await refreshBalanceOnly()
  } catch (error) {
    chatMessages.value = chatMessages.value.filter((message) => message.id !== assistantMessage.id)
    setError(error instanceof Error ? error.message : '对话请求失败')
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
              <p>{{ message.content }}</p>
              <img v-if="message.imageDataUrl" :src="message.imageDataUrl" alt="Generated image" />
            </article>
          </div>

          <form class="composer" @submit.prevent="handleSendChat">
            <textarea
              v-model="chatInput"
              rows="4"
              placeholder="输入文字对话内容。自动工具调用会在后续阶段接入。"
            />
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
              <span>{{ image.size }}</span>
            </article>
          </div>
        </aside>
      </section>
    </template>

    <p v-if="errorMessage" class="toast error">{{ errorMessage }}</p>
    <p v-if="successMessage" class="toast success">{{ successMessage }}</p>
  </main>
</template>
