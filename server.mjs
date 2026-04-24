import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const port = Number.parseInt(process.env.PORT || '8081', 10)
const upstream = (process.env.SUB2API_UPSTREAM || 'http://127.0.0.1:8080').replace(/\/$/, '')
const staticRoot = path.join(__dirname, 'dist')
const dataRoot = path.resolve(process.env.PLAYGROUND_DATA_DIR || path.join(__dirname, 'data', 'playground'))
const conversationsRoot = path.join(dataRoot, 'conversations')
const assetsRoot = path.join(dataRoot, 'assets')

const taskRetentionMs = 60 * 60 * 1000
const taskHardTTLms = 6 * 60 * 60 * 1000
const tasks = new Map()
const authUserCache = new Map()
const authUserCacheTtlMs = 60 * 1000

const db = process.env.DATABASE_URL
  ? new Pool({
    connectionString: process.env.DATABASE_URL
  })
  : null

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

const extByMime = {
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'text/plain': '.txt'
}

function nowIso() {
  return new Date().toISOString()
}

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, {
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8'
  })
  res.end(body)
}

function appError(statusCode, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function getErrorStatus(error) {
  return Number.isInteger(error?.statusCode) ? error.statusCode : 500
}

async function ensureRuntime() {
  await mkdir(conversationsRoot, { recursive: true })
  await mkdir(assetsRoot, { recursive: true })

  if (!db) {
    console.warn('DATABASE_URL is not set; conversation persistence is disabled.')
    return
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS playground_conversations (
      id UUID PRIMARY KEY,
      user_id BIGINT NOT NULL,
      title TEXT NOT NULL DEFAULT '新会话',
      snapshot_path TEXT NOT NULL,
      last_message_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_playground_conversations_user_updated
    ON playground_conversations (user_id, updated_at DESC)
  `)

  await db.query(`
    CREATE TABLE IF NOT EXISTS playground_assets (
      id UUID PRIMARY KEY,
      user_id BIGINT NOT NULL,
      kind TEXT NOT NULL,
      file_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes BIGINT NOT NULL,
      sha256 TEXT NOT NULL,
      public_token UUID NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_playground_assets_user_hash
    ON playground_assets (user_id, sha256)
  `)

  await db.query(`
    CREATE TABLE IF NOT EXISTS playground_gallery_items (
      id UUID PRIMARY KEY,
      asset_token UUID,
      remote_url TEXT,
      prompt TEXT NOT NULL,
      size TEXT NOT NULL,
      source_conversation_id UUID NOT NULL,
      source_image_id TEXT NOT NULL,
      shared_by_user_id BIGINT NOT NULL,
      shared_by_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT playground_gallery_items_image_source CHECK (asset_token IS NOT NULL OR remote_url IS NOT NULL)
    )
  `)

  await db.query(`
    DROP INDEX IF EXISTS idx_playground_gallery_source
  `)

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_playground_gallery_asset
    ON playground_gallery_items (shared_by_user_id, asset_token)
    WHERE asset_token IS NOT NULL
  `)

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_playground_gallery_remote
    ON playground_gallery_items (shared_by_user_id, remote_url)
    WHERE remote_url IS NOT NULL
  `)

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_playground_gallery_created
    ON playground_gallery_items (created_at DESC)
  `)
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0

    req.on('data', (chunk) => {
      total += chunk.length
      if (total > 50 * 1024 * 1024) {
        reject(appError(413, 'Request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim()
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        reject(appError(400, 'Invalid JSON body'))
      }
    })

    req.on('error', reject)
  })
}

function getAuthorization(req) {
  const value = req.headers.authorization
  return typeof value === 'string' ? value.trim() : ''
}

async function getAuthenticatedUser(req) {
  const authorization = getAuthorization(req)
  if (!authorization) {
    throw appError(401, 'Authorization header is required')
  }

  const cached = authUserCache.get(authorization)
  if (cached && Date.now() - cached.cachedAt < authUserCacheTtlMs) {
    return cached.user
  }

  const response = await fetch(`${upstream}/api/v1/user/profile`, {
    headers: {
      Authorization: authorization
    }
  })

  const text = await response.text()
  let data = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }

  if (!response.ok) {
    throw appError(401, parseUpstreamError(data, `Authentication failed: HTTP ${response.status}`))
  }

  const user = data?.data && typeof data.data === 'object' ? data.data : data
  if (!user || typeof user.id !== 'number') {
    throw appError(500, 'Failed to resolve authenticated user')
  }

  authUserCache.set(authorization, {
    user,
    cachedAt: Date.now()
  })

  return user
}

function requireDb() {
  if (!db) {
    throw appError(503, 'DATABASE_URL is not configured')
  }
  return db
}

function parseUpstreamError(data, fallback) {
  if (typeof data === 'string' && data.trim()) {
    return data
  }
  if (!data || typeof data !== 'object') {
    return fallback
  }
  if (typeof data.message === 'string' && data.message.trim()) {
    return data.message
  }
  if (data.error && typeof data.error === 'object' && typeof data.error.message === 'string') {
    return data.error.message
  }
  return fallback
}

function normalizeImageResult(data, fallbackPrompt, fallbackSize) {
  const items = Array.isArray(data?.data) ? data.data : []
  const images = items
    .map((item, index) => {
      const b64 = typeof item?.b64_json === 'string' ? item.b64_json : ''
      const remoteUrl = typeof item?.url === 'string' ? item.url : ''
      if (!b64 && !remoteUrl) {
        return null
      }

      return {
        id: `image-${index + 1}`,
        prompt: fallbackPrompt,
        size: fallbackSize,
        data_url: b64 ? `data:image/png;base64,${b64}` : null,
        remote_url: remoteUrl || null
      }
    })
    .filter(Boolean)

  return {
    images,
    raw: data
  }
}

function dataUrlToBlob(dataUrl, fallbackMimeType) {
  const { buffer, mimeType } = dataUrlToBuffer(dataUrl, fallbackMimeType)
  return new Blob([buffer], { type: mimeType })
}

function dataUrlToBuffer(dataUrl, fallbackMimeType) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/i.exec(String(dataUrl || ''))
  if (!match) {
    throw appError(400, 'Invalid image data_url')
  }

  const mimeType = match[1] || fallbackMimeType || 'application/octet-stream'
  const rawData = match[3] || ''
  return {
    buffer: Buffer.from(rawData, match[2] ? 'base64' : 'utf8'),
    mimeType
  }
}

function hashBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function extFromMime(mimeType) {
  return extByMime[String(mimeType || '').toLowerCase()] || '.bin'
}

function conversationSnapshotPath(userId, conversationId) {
  return path.join(conversationsRoot, String(userId), `${conversationId}.json`)
}

async function ensureParentDir(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true })
}

async function writeJsonFile(filePath, payload) {
  await ensureParentDir(filePath)
  await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8')
}

async function readJsonFile(filePath) {
  const raw = await readFile(filePath, 'utf8')
  return JSON.parse(raw)
}

async function findAssetByHash(userId, sha256) {
  const pool = requireDb()
  const result = await pool.query(
    `SELECT id, user_id, kind, file_path, mime_type, size_bytes, sha256, public_token
     FROM playground_assets
     WHERE user_id = $1 AND sha256 = $2`,
    [userId, sha256]
  )
  return result.rows[0] || null
}

async function getAssetByToken(token) {
  const pool = requireDb()
  const result = await pool.query(
    `SELECT id, user_id, kind, file_path, mime_type, size_bytes, sha256, public_token
     FROM playground_assets
     WHERE public_token = $1`,
    [token]
  )
  return result.rows[0] || null
}

function assetPublicUrl(token) {
  return `/api/playground/assets/${token}`
}

async function persistAsset(userId, kind, namedAsset) {
  if (namedAsset?.assetToken) {
    const existing = await getAssetByToken(namedAsset.assetToken)
    if (existing && Number(existing.user_id) === Number(userId)) {
      return existing
    }
  }

  if (!namedAsset?.dataUrl || !String(namedAsset.dataUrl).startsWith('data:')) {
    return null
  }

  const { buffer, mimeType } = dataUrlToBuffer(namedAsset.dataUrl, namedAsset.mimeType)
  const sha256 = hashBuffer(buffer)
  const existing = await findAssetByHash(userId, sha256)
  if (existing) {
    return existing
  }

  const assetId = randomUUID()
  const token = randomUUID()
  const extension = extFromMime(mimeType)
  const relativePath = path.join(String(userId), kind, `${assetId}${extension}`)
  const absolutePath = path.join(assetsRoot, relativePath)
  await ensureParentDir(absolutePath)
  await writeFile(absolutePath, buffer)

  const pool = requireDb()
  const result = await pool.query(
    `INSERT INTO playground_assets (id, user_id, kind, file_path, mime_type, size_bytes, sha256, public_token, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
     RETURNING id, user_id, kind, file_path, mime_type, size_bytes, sha256, public_token`,
    [assetId, userId, kind, relativePath, mimeType, buffer.length, sha256, token]
  )

  return result.rows[0]
}

async function hydrateAssetRef(assetRef) {
  if (!assetRef?.assetToken) {
    return null
  }
  const asset = await getAssetByToken(assetRef.assetToken)
  if (!asset) {
    return null
  }
  return {
    id: assetRef.id || asset.id,
    name: assetRef.name || path.basename(asset.file_path),
    mimeType: asset.mime_type,
    dataUrl: assetPublicUrl(asset.public_token),
    assetToken: asset.public_token
  }
}

function normalizeTaskPayload(payload) {
  const mode = payload?.mode === 'edit' ? 'edit' : 'generate'
  const prompt = typeof payload?.prompt === 'string' ? payload.prompt.trim() : ''
  const size = typeof payload?.size === 'string' ? payload.size.trim() : ''
  const model = typeof payload?.model === 'string' ? payload.model.trim() : ''
  const responseFormat = typeof payload?.response_format === 'string' ? payload.response_format.trim() : 'b64_json'
  const n = Number.isInteger(payload?.n) && payload.n > 0 ? payload.n : 1
  const images = Array.isArray(payload?.images) ? payload.images : []
  const conversationId = typeof payload?.conversation_id === 'string' ? payload.conversation_id.trim() : ''

  return {
    mode,
    prompt,
    size,
    model,
    response_format: responseFormat,
    n,
    images,
    conversation_id: conversationId || null
  }
}

async function callImageUpstream(task) {
  if (task.payload.mode === 'edit') {
    const form = new FormData()
    form.set('model', task.payload.model)
    form.set('prompt', task.payload.prompt)
    form.set('size', task.payload.size)
    form.set('n', String(task.payload.n))
    form.set('response_format', task.payload.response_format)

    for (const [index, image] of task.payload.images.entries()) {
      const blob = dataUrlToBlob(image?.data_url, image?.mime_type)
      const filename = typeof image?.name === 'string' && image.name.trim() ? image.name.trim() : `edit-source-${index + 1}.png`
      form.append('image', blob, filename)
    }

    return fetch(`${upstream}/v1/images/edits`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${task.apiKey}`
      },
      body: form
    })
  }

  return fetch(`${upstream}/v1/images/generations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${task.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: task.payload.model,
      prompt: task.payload.prompt,
      size: task.payload.size,
      n: task.payload.n,
      response_format: task.payload.response_format
    })
  })
}

function buildTaskResponse(task) {
  return {
    task_id: task.id,
    status: task.status,
    conversation_id: task.payload.conversation_id,
    mode: task.payload.mode,
    prompt: task.payload.prompt,
    size: task.payload.size,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    error: task.error || null,
    result: task.status === 'completed' ? task.result : null
  }
}

async function runImageTask(task) {
  task.status = 'processing'
  task.updatedAt = nowIso()

  try {
    const response = await callImageUpstream(task)
    const text = await response.text()
    let data = null
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        data = text
      }
    }

    if (!response.ok) {
      throw appError(response.status, parseUpstreamError(data, `Image request failed: HTTP ${response.status}`))
    }

    task.status = 'completed'
    task.result = normalizeImageResult(data, task.payload.prompt, task.payload.size)
    task.updatedAt = nowIso()
  } catch (error) {
    task.status = 'failed'
    task.error = error instanceof Error ? error.message : 'Image task failed'
    task.updatedAt = nowIso()
  }
}

function createImageTask(body, userId) {
  const apiKey = typeof body?.api_key === 'string' ? body.api_key.trim() : ''
  const rawPayload = body?.payload && typeof body.payload === 'object' ? body.payload : null

  if (!apiKey) {
    throw appError(400, 'api_key is required')
  }
  if (!rawPayload) {
    throw appError(400, 'payload is required')
  }

  const payload = normalizeTaskPayload(rawPayload)
  if (!payload.prompt) {
    throw appError(400, 'payload.prompt is required')
  }
  if (!payload.model) {
    throw appError(400, 'payload.model is required')
  }
  if (!payload.size) {
    throw appError(400, 'payload.size is required')
  }
  if (payload.mode === 'edit' && payload.images.length === 0) {
    throw appError(400, 'payload.images is required for edit mode')
  }

  const id = randomUUID()
  const task = {
    id,
    userId,
    apiKey,
    payload,
    status: 'queued',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    error: null,
    result: null
  }

  tasks.set(id, task)
  void runImageTask(task)
  return task
}

function cleanupTasks() {
  const now = Date.now()
  for (const [id, task] of tasks.entries()) {
    const updatedAt = Date.parse(task.updatedAt || task.createdAt)
    const createdAt = Date.parse(task.createdAt)
    const ageSinceUpdate = Number.isFinite(updatedAt) ? now - updatedAt : 0
    const ageSinceCreate = Number.isFinite(createdAt) ? now - createdAt : 0
    if (
      ageSinceCreate > taskHardTTLms ||
      ((task.status === 'completed' || task.status === 'failed') && ageSinceUpdate > taskRetentionMs)
    ) {
      tasks.delete(id)
    }
  }
}

function deriveConversationTitle(state) {
  const chatMessages = Array.isArray(state?.chatMessages) ? state.chatMessages : []
  const firstUserMessage = chatMessages.find((message) => message?.role === 'user' && typeof message?.content === 'string' && message.content.trim())
  if (!firstUserMessage) {
    return '新会话'
  }
  return firstUserMessage.content.trim().slice(0, 48) || '新会话'
}

function stateEnvelope(state) {
  return {
    chatMessages: Array.isArray(state?.chatMessages) ? state.chatMessages : [],
    generatedImages: Array.isArray(state?.generatedImages) ? state.generatedImages : []
  }
}

async function normalizeStateForStorage(userId, state) {
  const normalized = stateEnvelope(state)
  const storedMessages = []

  for (const message of normalized.chatMessages) {
    const attachments = []
    for (const attachment of message.attachments || []) {
      const asset = await persistAsset(userId, 'attachment', attachment)
      attachments.push(asset
        ? {
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          assetToken: asset.public_token
        }
        : {
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          externalUrl: attachment.dataUrl
        })
    }

    let imageAsset = null
    let externalImageUrl = null
    if (typeof message.imageDataUrl === 'string' && message.imageDataUrl.trim()) {
      if (message.imageAssetToken) {
        imageAsset = await persistAsset(userId, 'message-image', {
          assetToken: message.imageAssetToken,
          dataUrl: message.imageDataUrl,
          mimeType: 'image/png'
        })
      } else if (message.imageDataUrl.startsWith('data:')) {
        imageAsset = await persistAsset(userId, 'message-image', {
          dataUrl: message.imageDataUrl,
          mimeType: 'image/png'
        })
      } else {
        externalImageUrl = message.imageDataUrl
      }
    }

    storedMessages.push({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      attachments,
      imageAssetToken: imageAsset?.public_token || null,
      externalImageUrl
    })
  }

  const storedGeneratedImages = []
  for (const image of normalized.generatedImages) {
    let asset = null
    if (image.assetToken) {
      asset = await persistAsset(userId, 'generated-image', {
        assetToken: image.assetToken,
        dataUrl: image.dataUrl,
        mimeType: 'image/png'
      })
    } else if (typeof image.dataUrl === 'string' && image.dataUrl.startsWith('data:')) {
      asset = await persistAsset(userId, 'generated-image', {
        dataUrl: image.dataUrl,
        mimeType: 'image/png'
      })
    }

    storedGeneratedImages.push({
      id: image.id,
      shareKey: image.shareKey || null,
      prompt: image.prompt,
      size: image.size,
      createdAt: image.createdAt,
      assetToken: asset?.public_token || null,
      remoteUrl: image.remoteUrl || null
    })
  }

  return {
    chatMessages: storedMessages,
    generatedImages: storedGeneratedImages
  }
}

async function hydrateConversationState(snapshot) {
  const normalized = stateEnvelope(snapshot)
  const chatMessages = []

  for (const message of normalized.chatMessages) {
    const attachments = []
    for (const attachment of message.attachments || []) {
      if (attachment.assetToken) {
        const hydrated = await hydrateAssetRef(attachment)
        if (hydrated) {
          attachments.push(hydrated)
        }
      } else if (typeof attachment.externalUrl === 'string' && attachment.externalUrl.trim()) {
        attachments.push({
          id: attachment.id,
          name: attachment.name || 'image.png',
          mimeType: attachment.mimeType || 'image/png',
          dataUrl: attachment.externalUrl
        })
      }
    }

    let imageDataUrl = message.externalImageUrl || undefined
    let imageAssetToken
    if (!imageDataUrl && message.imageAssetToken) {
      const hydratedImage = await hydrateAssetRef({
        assetToken: message.imageAssetToken,
        id: message.id,
        mimeType: 'image/png',
        name: `${message.id}.png`
      })
      imageDataUrl = hydratedImage?.dataUrl
      imageAssetToken = hydratedImage?.assetToken
    }

    chatMessages.push({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: Number(message.createdAt) || Date.now(),
      attachments: attachments.length > 0 ? attachments : undefined,
      imageDataUrl,
      imageAssetToken
    })
  }

  const generatedImages = []
  for (const image of normalized.generatedImages) {
    let dataUrl
    let assetToken
    if (image.assetToken) {
      const hydrated = await hydrateAssetRef({
        assetToken: image.assetToken,
        id: image.id,
        mimeType: 'image/png',
        name: `${image.id}.png`
      })
      dataUrl = hydrated?.dataUrl
      assetToken = hydrated?.assetToken
    }

    generatedImages.push({
      id: image.id,
      shareKey: image.shareKey || undefined,
      prompt: image.prompt,
      size: image.size,
      dataUrl,
      remoteUrl: image.remoteUrl || undefined,
      createdAt: Number(image.createdAt) || Date.now(),
      assetToken
    })
  }

  return {
    chatMessages,
    generatedImages
  }
}

async function listConversations(userId) {
  const pool = requireDb()
  const result = await pool.query(
    `SELECT id, title, created_at, updated_at, last_message_at
     FROM playground_conversations
     WHERE user_id = $1
     ORDER BY updated_at DESC`,
    [userId]
  )

  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessageAt: row.last_message_at
  }))
}

async function createConversation(userId, requestedTitle = '') {
  const pool = requireDb()
  const id = randomUUID()
  const title = requestedTitle.trim() || '新会话'
  const snapshotPath = conversationSnapshotPath(userId, id)
  await writeJsonFile(snapshotPath, stateEnvelope({}))

  const result = await pool.query(
    `INSERT INTO playground_conversations (id, user_id, title, snapshot_path, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     RETURNING id, title, created_at, updated_at, last_message_at`,
    [id, userId, title, snapshotPath]
  )

  const row = result.rows[0]
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessageAt: row.last_message_at
  }
}

async function getConversationRow(userId, conversationId) {
  const pool = requireDb()
  const result = await pool.query(
    `SELECT id, title, snapshot_path, created_at, updated_at, last_message_at
     FROM playground_conversations
     WHERE id = $1 AND user_id = $2`,
    [conversationId, userId]
  )
  return result.rows[0] || null
}

async function loadConversation(userId, conversationId) {
  const row = await getConversationRow(userId, conversationId)
  if (!row) {
    throw appError(404, 'Conversation not found')
  }

  const snapshot = await readJsonFile(row.snapshot_path)
  const state = await hydrateConversationState(snapshot)

  return {
    conversation: {
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastMessageAt: row.last_message_at
    },
    state
  }
}

async function saveConversationState(userId, conversationId, state) {
  const row = await getConversationRow(userId, conversationId)
  if (!row) {
    throw appError(404, 'Conversation not found')
  }

  const normalizedSnapshot = await normalizeStateForStorage(userId, state)
  const title = deriveConversationTitle(normalizedSnapshot)
  const chatMessages = Array.isArray(normalizedSnapshot.chatMessages) ? normalizedSnapshot.chatMessages : []
  const lastMessageAt = chatMessages.length > 0
    ? new Date(Number(chatMessages[chatMessages.length - 1].createdAt) || Date.now()).toISOString()
    : null

  await writeJsonFile(row.snapshot_path, normalizedSnapshot)
  const pool = requireDb()
  await pool.query(
    `UPDATE playground_conversations
     SET title = $3,
         last_message_at = $4,
         updated_at = NOW()
     WHERE id = $1 AND user_id = $2`,
    [conversationId, userId, title, lastMessageAt]
  )

  return {
    savedAt: nowIso(),
    title
  }
}

function mapGalleryRow(row) {
  return {
    id: row.id,
    prompt: row.prompt,
    size: row.size,
    imageUrl: row.asset_token ? assetPublicUrl(row.asset_token) : row.remote_url,
    sourceConversationId: row.source_conversation_id,
    sourceImageId: row.source_image_id,
    sharedByUserId: Number(row.shared_by_user_id),
    sharedByName: row.shared_by_name || undefined,
    createdAt: row.created_at
  }
}

async function listGalleryItems() {
  const pool = requireDb()
  const result = await pool.query(
    `SELECT id, asset_token, remote_url, prompt, size, source_conversation_id, source_image_id,
            shared_by_user_id, shared_by_name, created_at
     FROM playground_gallery_items
     ORDER BY created_at DESC
     LIMIT 100`
  )
  return result.rows.map(mapGalleryRow)
}

async function shareGalleryImage(user, body) {
  const conversationId = typeof body?.conversation_id === 'string' ? body.conversation_id.trim() : ''
  const imageId = typeof body?.image_id === 'string' ? body.image_id.trim() : ''
  const requestedAssetToken = typeof body?.asset_token === 'string' ? body.asset_token.trim() : ''
  const requestedRemoteUrl = typeof body?.remote_url === 'string' ? body.remote_url.trim() : ''
  if (!conversationId || !imageId) {
    throw appError(400, 'conversation_id and image_id are required')
  }

  const conversation = await loadConversation(user.id, conversationId)
  const candidates = conversation.state.generatedImages.filter((item) => item.id === imageId)
  const image = candidates.find((item) => (
    (requestedAssetToken && item.assetToken === requestedAssetToken) ||
    (requestedRemoteUrl && item.remoteUrl === requestedRemoteUrl)
  )) || candidates[0]
  if (!image) {
    throw appError(404, 'Generated image not found in this conversation')
  }

  const assetToken = image.assetToken || null
  const remoteUrl = image.remoteUrl || null
  if (requestedAssetToken && assetToken !== requestedAssetToken) {
    throw appError(404, 'Generated image asset does not match this conversation')
  }
  if (requestedRemoteUrl && remoteUrl !== requestedRemoteUrl) {
    throw appError(404, 'Generated image URL does not match this conversation')
  }
  if (!assetToken && !remoteUrl) {
    throw appError(409, 'Image is not persisted yet; save the conversation before sharing')
  }

  const pool = requireDb()
  const existing = await pool.query(
    `SELECT id, asset_token, remote_url, prompt, size, source_conversation_id, source_image_id,
            shared_by_user_id, shared_by_name, created_at
     FROM playground_gallery_items
     WHERE shared_by_user_id = $1
       AND (($2::uuid IS NOT NULL AND asset_token = $2::uuid) OR ($3::text IS NOT NULL AND remote_url = $3::text))
     LIMIT 1`,
    [user.id, assetToken, remoteUrl]
  )
  if (existing.rows[0]) {
    return {
      item: mapGalleryRow(existing.rows[0]),
      alreadyExists: true
    }
  }

  const id = randomUUID()
  const sharedByName = user.username || user.email || `User ${user.id}`
  const result = await pool.query(
    `INSERT INTO playground_gallery_items (
       id, asset_token, remote_url, prompt, size, source_conversation_id, source_image_id,
       shared_by_user_id, shared_by_name, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
     RETURNING id, asset_token, remote_url, prompt, size, source_conversation_id, source_image_id,
               shared_by_user_id, shared_by_name, created_at`,
    [
      id,
      assetToken,
      remoteUrl,
      image.prompt || 'Untitled prompt',
      image.size || 'unknown',
      conversationId,
      imageId,
      user.id,
      sharedByName
    ]
  )
  const row = result.rows[0]
  return {
    item: mapGalleryRow(row),
    alreadyExists: false
  }
}

async function proxyRequest(req, res) {
  const targetUrl = new URL(req.url, upstream)
  const headers = new Headers()

  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      headers.set(key, value.join(', '))
    } else if (typeof value === 'string') {
      headers.set(key, value)
    }
  }
  headers.set('host', targetUrl.host)

  const chunks = []
  for await (const chunk of req) {
    chunks.push(chunk)
  }
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined

  const response = await fetch(targetUrl, {
    method: req.method,
    headers,
    body
  })

  const responseHeaders = {}
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'transfer-encoding') {
      return
    }
    responseHeaders[key] = value
  })

  res.writeHead(response.status, responseHeaders)
  if (!response.body) {
    res.end()
    return
  }

  Readable.fromWeb(response.body).pipe(res)
}

async function serveStatic(req, res) {
  if (!existsSync(staticRoot)) {
    json(res, 503, {
      code: 503,
      message: 'Static assets not built yet. Run the production image build or use Vite dev mode.'
    })
    return
  }

  const requestPath = (req.url || '/').split('?')[0]
  const normalizedPath = requestPath === '/' ? '/index.html' : requestPath
  const safePath = normalizedPath.replace(/^\/+/, '')
  let filePath = path.join(staticRoot, safePath)

  try {
    const fileStat = await stat(filePath)
    if (fileStat.isDirectory()) {
      filePath = path.join(filePath, 'index.html')
    }
  } catch {
    filePath = path.join(staticRoot, 'index.html')
  }

  const ext = path.extname(filePath).toLowerCase()
  const contentType = mimeTypes[ext] || 'application/octet-stream'
  res.writeHead(200, { 'Content-Type': contentType })
  createReadStream(filePath).pipe(res)
}

setInterval(cleanupTasks, 5 * 60 * 1000).unref()
await ensureRuntime()

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost')

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('ok\n')
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/playground/gallery') {
      const items = await listGalleryItems()
      json(res, 200, { code: 0, message: 'success', data: items })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/playground/gallery') {
      const user = await getAuthenticatedUser(req)
      const body = await parseJsonBody(req)
      const result = await shareGalleryImage(user, body)
      json(res, result.alreadyExists ? 200 : 201, { code: 0, message: 'success', data: result })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/playground/conversations') {
      const user = await getAuthenticatedUser(req)
      const conversations = await listConversations(user.id)
      json(res, 200, { code: 0, message: 'success', data: conversations })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/playground/conversations') {
      const user = await getAuthenticatedUser(req)
      const body = await parseJsonBody(req)
      const conversation = await createConversation(user.id, typeof body?.title === 'string' ? body.title : '')
      json(res, 201, { code: 0, message: 'success', data: conversation })
      return
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/playground/conversations/')) {
      const user = await getAuthenticatedUser(req)
      const conversationId = url.pathname.split('/').pop()
      if (!conversationId) {
        throw appError(400, 'Conversation ID is required')
      }
      const payload = await loadConversation(user.id, conversationId)
      json(res, 200, { code: 0, message: 'success', data: payload })
      return
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/playground/assets/')) {
      const token = url.pathname.split('/').pop()
      if (!token) {
        throw appError(400, 'Asset token is required')
      }
      const asset = await getAssetByToken(token)
      if (!asset) {
        throw appError(404, 'Asset not found')
      }
      const filePath = path.join(assetsRoot, asset.file_path)
      res.writeHead(200, {
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Type': asset.mime_type
      })
      createReadStream(filePath).pipe(res)
      return
    }

    if (req.method === 'PUT' && url.pathname.startsWith('/api/playground/conversations/')) {
      const user = await getAuthenticatedUser(req)
      const conversationId = url.pathname.split('/').pop()
      if (!conversationId) {
        throw appError(400, 'Conversation ID is required')
      }
      const body = await parseJsonBody(req)
      const result = await saveConversationState(user.id, conversationId, body)
      json(res, 200, { code: 0, message: 'success', data: result })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/playground/tasks') {
      const user = await getAuthenticatedUser(req)
      const body = await parseJsonBody(req)
      const task = createImageTask(body, user.id)
      json(res, 202, {
        code: 0,
        message: 'accepted',
        data: {
          task_id: task.id,
          status: task.status
        }
      })
      return
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/playground/tasks/')) {
      const user = await getAuthenticatedUser(req)
      const taskId = url.pathname.split('/').pop()
      const task = taskId ? tasks.get(taskId) : null
      if (!task || task.userId !== user.id) {
        throw appError(404, 'Task not found')
      }
      json(res, 200, {
        code: 0,
        message: 'success',
        data: buildTaskResponse(task)
      })
      return
    }

    if (
      url.pathname.startsWith('/api/v1/') ||
      url.pathname.startsWith('/v1/') ||
      url.pathname.startsWith('/images/')
    ) {
      await proxyRequest(req, res)
      return
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      throw appError(404, 'Not found')
    }

    await serveStatic(req, res)
  } catch (error) {
    json(res, getErrorStatus(error), {
      code: getErrorStatus(error),
      message: error instanceof Error ? error.message : 'Internal server error'
    })
  }
})

server.listen(port, '0.0.0.0', () => {
  console.log(`image-playground server listening on http://0.0.0.0:${port}`)
  console.log(`playground data dir: ${dataRoot}`)
  if (db) {
    console.log('playground PostgreSQL persistence is enabled')
  }
})
