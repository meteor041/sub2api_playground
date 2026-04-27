import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { Pool } from 'pg'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const port = Number.parseInt(process.env.PORT || '8081', 10)
const upstream = (process.env.METEORAPI_UPSTREAM || process.env.SUB2API_UPSTREAM || 'https://meteor041.com').replace(/\/$/, '')
const publicOrigin = (process.env.PLAYGROUND_PUBLIC_ORIGIN || '').replace(/\/$/, '')
const imageCdnBase = (process.env.PLAYGROUND_IMAGE_CDN_BASE || 'https://img.meteor041.com/meteor-images').replace(/\/$/, '')
const r2Endpoint = (process.env.R2_ENDPOINT || '').replace(/\/$/, '')
const r2Bucket = String(process.env.R2_BUCKET || '').trim()
const r2Region = String(process.env.R2_REGION || 'auto').trim() || 'auto'
const r2AccessKeyId = String(process.env.R2_ACCESS_KEY_ID || '').trim()
const r2SecretAccessKey = String(process.env.R2_SECRET_ACCESS_KEY || '').trim()
const keepLocalAssets = process.env.PLAYGROUND_KEEP_LOCAL_ASSETS === 'true'
const r2Configured = Boolean(r2Endpoint && r2Bucket && r2AccessKeyId && r2SecretAccessKey)
const cloudflareImageResizingEnabled = process.env.PLAYGROUND_ENABLE_CF_IMAGE_RESIZING === 'true'
const thumbnailWidth = Number.parseInt(process.env.PLAYGROUND_THUMBNAIL_WIDTH || '480', 10)
const staticRoot = path.join(__dirname, 'dist')
const dataRoot = path.resolve(process.env.PLAYGROUND_DATA_DIR || path.join(__dirname, 'data', 'playground'))
const conversationsRoot = path.join(dataRoot, 'conversations')
const assetsRoot = path.join(dataRoot, 'assets')

const taskRetentionMs = 60 * 60 * 1000
const taskHardTTLms = 6 * 60 * 60 * 1000
const tasks = new Map()
const authUserCache = new Map()
const authUserCacheTtlMs = 60 * 1000
const rateLimitHits = new Map()

const db = process.env.DATABASE_URL
  ? new Pool({
    connectionString: process.env.DATABASE_URL
  })
  : null

const r2Client = r2Configured
  ? new S3Client({
    region: r2Region,
    endpoint: r2Endpoint,
    credentials: {
      accessKeyId: r2AccessKeyId,
      secretAccessKey: r2SecretAccessKey
    }
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

function json(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, {
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders
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

function getClientIp(req) {
  const forwardedFor = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map((item) => item.trim())
    .find(Boolean)
  return forwardedFor || req.socket?.remoteAddress || 'unknown'
}

function createRateLimitError(rule) {
  const retryAfterSeconds = Math.max(1, Math.ceil(rule.windowMs / 1000))
  const error = appError(429, rule.message || 'Too many requests')
  error.retryAfterSeconds = retryAfterSeconds
  return error
}

function cleanupRateLimitHits() {
  const now = Date.now()
  for (const [key, hit] of rateLimitHits.entries()) {
    if (hit.resetAt <= now) {
      rateLimitHits.delete(key)
    }
  }
}

function resolveRateLimitRule(req, url) {
  if (req.method === 'POST' && url.pathname === '/api/v1/auth/login') {
    return {
      key: 'login',
      limit: 20,
      windowMs: 60 * 1000,
      message: '登录请求过于频繁，请稍后再试'
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/playground/tasks') {
    return {
      key: 'task-create',
      limit: 12,
      windowMs: 10 * 1000,
      message: '创建图片任务过于频繁，请稍后再试'
    }
  }

  if (
    (req.method === 'POST' && url.pathname === '/api/playground/conversations') ||
    (req.method === 'PUT' && url.pathname.startsWith('/api/playground/conversations/'))
  ) {
    return {
      key: 'conversation-write',
      limit: 30,
      windowMs: 10 * 1000,
      message: '会话保存过于频繁，请稍后再试'
    }
  }

  if (
    (req.method === 'POST' && url.pathname === '/api/playground/library/batch') ||
    ((req.method === 'PATCH' || req.method === 'DELETE') && url.pathname.startsWith('/api/playground/library/'))
  ) {
    return {
      key: 'library-write',
      limit: 20,
      windowMs: 10 * 1000,
      message: '作品库操作过于频繁，请稍后再试'
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/playground/gallery') {
    return {
      key: 'gallery-share',
      limit: 10,
      windowMs: 10 * 1000,
      message: '分享操作过于频繁，请稍后再试'
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/playground/ppt/export') {
    return {
      key: 'ppt-export',
      limit: 6,
      windowMs: 60 * 1000,
      message: '导出 PPT 过于频繁，请稍后再试'
    }
  }

  return null
}

function applyRateLimit(req, url) {
  const rule = resolveRateLimitRule(req, url)
  if (!rule) {
    return
  }

  const now = Date.now()
  const clientIp = getClientIp(req)
  const cacheKey = `${rule.key}:${clientIp}`
  const current = rateLimitHits.get(cacheKey)

  if (!current || current.resetAt <= now) {
    rateLimitHits.set(cacheKey, {
      count: 1,
      resetAt: now + rule.windowMs
    })
    return
  }

  if (current.count >= rule.limit) {
    throw createRateLimitError(rule)
  }

  current.count += 1
}

async function ensureRuntime() {
  await mkdir(conversationsRoot, { recursive: true })
  await mkdir(assetsRoot, { recursive: true })

  if (!r2Configured && (r2Endpoint || r2Bucket || r2AccessKeyId || r2SecretAccessKey)) {
    console.warn('R2 is partially configured; asset writes will stay on local disk until all R2_* variables are set.')
  }

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

  await db.query(`
    CREATE TABLE IF NOT EXISTS playground_library_items (
      id UUID PRIMARY KEY,
      user_id BIGINT NOT NULL,
      asset_token UUID,
      remote_url TEXT,
      prompt TEXT NOT NULL DEFAULT '',
      size TEXT NOT NULL DEFAULT 'unknown',
      source_conversation_id UUID,
      source_image_id TEXT,
      folder TEXT NOT NULL DEFAULT '',
      tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      favorite BOOLEAN NOT NULL DEFAULT FALSE,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT playground_library_items_image_source CHECK (asset_token IS NOT NULL OR remote_url IS NOT NULL)
    )
  `)

  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_playground_library_source
    ON playground_library_items (user_id, source_conversation_id, source_image_id)
  `)

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_playground_library_user_updated
    ON playground_library_items (user_id, updated_at DESC)
    WHERE deleted_at IS NULL
  `)

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_playground_library_user_created
    ON playground_library_items (user_id, created_at DESC)
    WHERE deleted_at IS NULL
  `)

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_playground_library_user_favorite
    ON playground_library_items (user_id, favorite, created_at DESC)
    WHERE deleted_at IS NULL
  `)

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_playground_library_tags
    ON playground_library_items USING GIN (tags)
  `)

  await db.query(`
    CREATE TABLE IF NOT EXISTS playground_image_tasks (
      id UUID PRIMARY KEY,
      user_id BIGINT NOT NULL,
      api_key TEXT,
      payload JSONB NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      result JSONB,
      archived BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_playground_image_tasks_user_updated
    ON playground_image_tasks (user_id, updated_at DESC)
  `)

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_playground_image_tasks_status
    ON playground_image_tasks (status, archived)
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
      const outputFormat = typeof item?.output_format === 'string' ? item.output_format : 'png'
      if (!b64 && !remoteUrl) {
        return null
      }

      return {
        id: `image-${index + 1}`,
        prompt: fallbackPrompt,
        size: fallbackSize,
        data_url: b64 ? base64ImageDataUrl(b64, outputFormat) : null,
        remote_url: remoteUrl || null,
        image_url: remoteUrl || null
      }
    })
    .filter(Boolean)

  return {
    images,
    raw: data
  }
}

function imageMimeType(outputFormat = '') {
  const normalized = String(outputFormat || '').trim().toLowerCase()
  switch (normalized) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'webp':
      return 'image/webp'
    case 'gif':
      return 'image/gif'
    case 'png':
    default:
      return 'image/png'
  }
}

function base64ImageDataUrl(value, outputFormat = 'png') {
  const raw = String(value || '').trim()
  if (!raw) {
    return null
  }
  if (raw.startsWith('data:')) {
    return raw
  }
  return `data:${imageMimeType(outputFormat)};base64,${raw}`
}

function createStreamImageItem(task, fields) {
  const b64 = typeof fields?.b64_json === 'string'
    ? fields.b64_json
    : (typeof fields?.partial_image_b64 === 'string' ? fields.partial_image_b64 : '')
  const result = typeof fields?.result === 'string' ? fields.result : ''
  const rawUrl = typeof fields?.url === 'string' ? fields.url.trim() : ''
  const outputFormat = typeof fields?.output_format === 'string' ? fields.output_format : 'png'
  const dataUrl = base64ImageDataUrl(b64 || result, outputFormat) || (rawUrl.startsWith('data:') ? rawUrl : null)
  const remoteUrl = rawUrl && !rawUrl.startsWith('data:') ? rawUrl : ''

  if (!dataUrl && !remoteUrl) {
    return null
  }

  return {
    id: 'image-1',
    prompt: typeof fields?.revised_prompt === 'string' && fields.revised_prompt.trim()
      ? fields.revised_prompt.trim()
      : task.payload.prompt,
    size: typeof fields?.size === 'string' && fields.size.trim() ? fields.size.trim() : task.payload.size,
    data_url: dataUrl,
    remote_url: remoteUrl || null,
    image_url: remoteUrl || null
  }
}

function collectStreamImageItems(event, task) {
  if (!event || typeof event !== 'object') {
    return []
  }

  const eventType = typeof event.type === 'string' ? event.type : ''
  if (Array.isArray(event.data)) {
    return normalizeImageResult(event, task.payload.prompt, task.payload.size).images
  }

  const directImage = createStreamImageItem(task, event)
  if (
    directImage &&
    (
      eventType.includes('partial_image') ||
      eventType.endsWith('.completed') ||
      eventType === 'image_generation.completed' ||
      eventType === 'image_edit.completed'
    )
  ) {
    return [directImage]
  }

  if (eventType === 'response.output_item.done' && event.item?.type === 'image_generation_call') {
    const item = createStreamImageItem(task, event.item)
    return item ? [item] : []
  }

  const output = Array.isArray(event.response?.output)
    ? event.response.output
    : (Array.isArray(event.output) ? event.output : [])
  return output
    .map((item, index) => item?.type === 'image_generation_call'
      ? createStreamImageItem(task, { ...item, index })
      : null)
    .filter(Boolean)
}

function summarizeStreamEvent(event) {
  if (!event || typeof event !== 'object') {
    return event
  }
  const clone = JSON.parse(JSON.stringify(event))
  delete clone.b64_json
  delete clone.partial_image_b64
  delete clone.result
  if (clone.item) {
    delete clone.item.result
  }
  if (clone.response?.output && Array.isArray(clone.response.output)) {
    clone.response.output = clone.response.output.map((item) => {
      if (!item || typeof item !== 'object') return item
      const next = { ...item }
      delete next.result
      return next
    })
  }
  return clone
}

function mergeTaskStreamImages(task, images, rawEvents) {
  if (!images.length) {
    return false
  }
  const latest = {
    ...images[images.length - 1],
    id: 'image-1'
  }
  task.result = {
    images: [latest],
    raw: {
      stream: true,
      events: rawEvents.slice(-20)
    }
  }
  return true
}

function parseSseDataBlock(block) {
  const data = String(block || '')
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
    .trim()
  if (!data || data === '[DONE]') {
    return null
  }
  try {
    return JSON.parse(data)
  } catch {
    return null
  }
}

async function processImageStreamResponse(response, task) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const data = await readResponseJson(response)
    task.result = normalizeImageResult(data, task.payload.prompt, task.payload.size)
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const rawEvents = []
  let buffer = ''

  async function handleBlock(block) {
    const event = parseSseDataBlock(block)
    if (!event) {
      return
    }
    rawEvents.push(summarizeStreamEvent(event))
    const images = collectStreamImageItems(event, task)
    if (!mergeTaskStreamImages(task, images, rawEvents)) {
      return
    }
    task.status = 'processing'
    task.updatedAt = nowIso()
    await updatePersistedImageTask(task)
  }

  while (true) {
    const { done, value } = await reader.read()
    if (value) {
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      let separatorIndex = buffer.indexOf('\n\n')
      while (separatorIndex >= 0) {
        const block = buffer.slice(0, separatorIndex)
        buffer = buffer.slice(separatorIndex + 2)
        await handleBlock(block)
        separatorIndex = buffer.indexOf('\n\n')
      }
    }
    if (done) {
      break
    }
  }

  if (buffer.trim()) {
    await handleBlock(buffer)
  }
}

async function readResponseJson(response) {
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

function dataUrlToBlob(dataUrl, fallbackMimeType) {
  const { buffer, mimeType } = dataUrlToBuffer(dataUrl, fallbackMimeType)
  return new Blob([buffer], { type: mimeType })
}

async function bodyToBuffer(body) {
  if (!body) {
    return Buffer.alloc(0)
  }
  if (Buffer.isBuffer(body)) {
    return body
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body)
  }
  if (typeof body.transformToByteArray === 'function') {
    return Buffer.from(await body.transformToByteArray())
  }
  if (typeof body.transformToWebStream === 'function') {
    return bodyToBuffer(Readable.fromWeb(body.transformToWebStream()))
  }

  const chunks = []
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
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

function sanitizeDownloadFilename(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}

function buildAssetDownloadFilename(asset, requestedName = '') {
  const requested = sanitizeDownloadFilename(requestedName)
  const ext = extFromMime(asset?.mime_type)
  if (requested) {
    return path.extname(requested) ? requested : `${requested}${ext}`
  }
  return `${asset?.public_token || 'playground-image'}${ext}`
}

function buildAttachmentDisposition(filename) {
  const safeFilename = sanitizeDownloadFilename(filename) || 'download'
  const asciiFilename = safeFilename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'")
  return `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`
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

function assetImageUrl(token) {
  const key = typeof token === 'string' ? token.trim().replace(/^\/+/, '') : ''
  return key ? `${imageCdnBase}/${key}` : ''
}

function assetObjectKey(token) {
  const key = typeof token === 'string' ? token.trim().replace(/^\/+/, '') : ''
  if (!key) {
    return ''
  }
  try {
    const pathname = new URL(imageCdnBase).pathname.replace(/^\/+|\/+$/g, '')
    return pathname ? `${pathname}/${key}` : key
  } catch {
    return key
  }
}

function resolveImageUrl(assetToken, remoteUrl) {
  const assetUrl = assetImageUrl(assetToken)
  if (assetUrl) {
    return assetUrl
  }
  const directUrl = typeof remoteUrl === 'string' ? remoteUrl.trim() : ''
  return directUrl || null
}

function assetTokenFromUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) {
    return ''
  }

  try {
    const url = new URL(raw, 'http://local')
    const assetMatch = url.pathname.match(/\/api\/playground\/assets\/([^/?#]+)/)
    if (assetMatch) {
      return decodeURIComponent(assetMatch[1])
    }

    const cdnBase = new URL(imageCdnBase)
    if (url.origin === cdnBase.origin) {
      const basePath = cdnBase.pathname.replace(/\/+$/g, '')
      const prefix = basePath ? `${basePath}/` : '/'
      if (url.pathname.startsWith(prefix)) {
        return decodeURIComponent(url.pathname.slice(prefix.length).split('/')[0] || '')
      }
    }
  } catch {
    return ''
  }

  return ''
}

function shouldKeepLocalAssetCopy() {
  return !r2Configured || keepLocalAssets
}

function assetAbsolutePath(filePath) {
  return path.join(assetsRoot, filePath)
}

async function writeLocalAssetFile(filePath, buffer) {
  const absolutePath = assetAbsolutePath(filePath)
  await ensureParentDir(absolutePath)
  await writeFile(absolutePath, buffer)
}

async function uploadAssetToR2(token, buffer, mimeType) {
  if (!r2Client || !r2Bucket) {
    return
  }
  const key = assetObjectKey(token)
  if (!key) {
    throw appError(500, 'Asset token is required for R2 upload')
  }
  await r2Client.send(new PutObjectCommand({
    Bucket: r2Bucket,
    Key: key,
    Body: buffer,
    ContentType: mimeType,
    CacheControl: 'public, max-age=31536000, immutable'
  }))
}

async function streamAssetFromR2(res, asset, { headOnly = false, downloadName = '' } = {}) {
  if (!r2Client || !r2Bucket) {
    throw appError(404, 'Asset file not found')
  }

  const key = assetObjectKey(asset.public_token)
  if (!key) {
    throw appError(404, 'Asset file not found')
  }

  let response
  try {
    response = await r2Client.send(new GetObjectCommand({
      Bucket: r2Bucket,
      Key: key
    }))
  } catch {
    throw appError(404, 'Asset file not found')
  }

  const headers = {
    'Cache-Control': 'public, max-age=31536000, immutable',
    'CDN-Cache-Control': 'public, max-age=31536000, immutable',
    'Content-Disposition': buildAttachmentDisposition(buildAssetDownloadFilename(asset, downloadName)),
    'Content-Type': response.ContentType || asset.mime_type
  }

  const contentLength = Number(response.ContentLength || asset.size_bytes || 0)
  if (contentLength > 0) {
    headers['Content-Length'] = String(contentLength)
  }

  res.writeHead(200, headers)
  if (headOnly) {
    res.end()
    return
  }

  const body = response.Body
  if (!body) {
    res.end()
    return
  }

  if (typeof body.pipe === 'function') {
    body.pipe(res)
    return
  }

  if (typeof body.transformToWebStream === 'function') {
    Readable.fromWeb(body.transformToWebStream()).pipe(res)
    return
  }

  throw appError(500, 'Unsupported asset stream')
}

async function loadAssetBuffer(asset) {
  const localPath = assetAbsolutePath(asset.file_path)
  if (existsSync(localPath)) {
    return {
      buffer: await readFile(localPath),
      mimeType: asset.mime_type || 'image/png'
    }
  }

  if (r2Client && r2Bucket) {
    const key = assetObjectKey(asset.public_token)
    if (!key) {
      throw appError(404, 'Asset file not found')
    }
    const response = await r2Client.send(new GetObjectCommand({
      Bucket: r2Bucket,
      Key: key
    }))
    return {
      buffer: await bodyToBuffer(response.Body),
      mimeType: response.ContentType || asset.mime_type || 'image/png'
    }
  }

  const remoteUrl = assetImageUrl(asset.public_token)
  if (remoteUrl) {
    return fetchImageUrlBuffer(remoteUrl, asset.mime_type || 'image/png')
  }

  throw appError(404, 'Asset file not found')
}

async function fetchImageUrlBuffer(value, fallbackMimeType = 'image/png') {
  let url
  try {
    url = new URL(String(value || '').trim())
  } catch {
    throw appError(400, 'Invalid image URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw appError(400, 'Invalid image URL')
  }

  const response = await fetch(url)
  if (!response.ok) {
    throw appError(response.status, `Unable to fetch edit source image: HTTP ${response.status}`)
  }
  const mimeType = response.headers.get('content-type') || fallbackMimeType || 'image/png'
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    mimeType
  }
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function normalizePptExportRequest(body) {
  const rawPlan = body?.plan
  if (!rawPlan || typeof rawPlan !== 'object') {
    throw appError(400, 'PPT plan is required')
  }

  const rawSlides = Array.isArray(rawPlan.slides) ? rawPlan.slides.slice(0, 30) : []
  if (rawSlides.length === 0) {
    throw appError(400, 'At least one PPT slide is required')
  }

  const slides = rawSlides.map((slide, index) => {
    const keyPoints = Array.isArray(slide?.keyPoints)
      ? slide.keyPoints
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean)
        .slice(0, 8)
      : []

    return {
      pageNumber: Number.isInteger(slide?.pageNumber) && slide.pageNumber > 0 ? slide.pageNumber : index + 1,
      title: typeof slide?.title === 'string' && slide.title.trim() ? slide.title.trim() : `第 ${index + 1} 页`,
      objective: typeof slide?.objective === 'string' ? slide.objective.trim() : '',
      keyPoints,
      layout: typeof slide?.layout === 'string' ? slide.layout.trim() : '',
      visualDirection: typeof slide?.visualDirection === 'string' ? slide.visualDirection.trim() : '',
      speakerNotes: typeof slide?.speakerNotes === 'string' ? slide.speakerNotes.trim() : '',
      generationPrompt: typeof slide?.generationPrompt === 'string' ? slide.generationPrompt.trim() : '',
      slideImageId: typeof slide?.slideImageId === 'string' && slide.slideImageId.trim() ? slide.slideImageId.trim() : '',
      slideImageUrl: typeof slide?.slideImageUrl === 'string' && slide.slideImageUrl.trim() ? slide.slideImageUrl.trim() : ''
    }
  })

  const slideImages = new Map()
  const rawSlideImages = Array.isArray(body?.slideImages) ? body.slideImages : []
  for (const item of rawSlideImages) {
    const slideImageId = typeof item?.slideImageId === 'string' ? item.slideImageId.trim() : ''
    const source = typeof item?.source === 'string' ? item.source.trim() : ''
    if (slideImageId && source) {
      slideImages.set(slideImageId, source)
    }
  }

  return {
    plan: {
      projectTitle: typeof rawPlan.projectTitle === 'string' ? rawPlan.projectTitle.trim() : 'PPT Export',
      summary: typeof rawPlan.summary === 'string' ? rawPlan.summary.trim() : '',
      targetAudience: typeof rawPlan.targetAudience === 'string' ? rawPlan.targetAudience.trim() : '',
      narrativeFlow: typeof rawPlan.narrativeFlow === 'string' ? rawPlan.narrativeFlow.trim() : '',
      visualSystem: typeof rawPlan.visualSystem === 'string' ? rawPlan.visualSystem.trim() : '',
      slides
    },
    slideImages
  }
}

function requestOrigin(req) {
  if (publicOrigin) {
    return publicOrigin
  }
  const host = req.headers?.['x-forwarded-host'] || req.headers?.host || `127.0.0.1:${port}`
  const protocol = req.headers?.['x-forwarded-proto'] || 'http'
  return `${protocol}://${host}`
}

async function loadPptExportImage(userId, req, source) {
  const trimmed = String(source || '').trim()
  if (!trimmed) {
    return null
  }

  if (trimmed.startsWith('data:')) {
    return dataUrlToBuffer(trimmed, 'image/png')
  }

  const assetToken = assetTokenFromUrl(trimmed)
  if (assetToken) {
    const asset = await getAssetByToken(assetToken)
    if (!asset) {
      throw appError(404, 'PPT export image not found')
    }
    if (Number(asset.user_id) !== Number(userId)) {
      throw appError(403, 'PPT export image access denied')
    }
    return loadAssetBuffer(asset)
  }

  const absoluteUrl = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `${requestOrigin(req)}${trimmed.startsWith('/') ? trimmed : `/${trimmed}`}`
  return fetchImageUrlBuffer(absoluteUrl, 'image/png')
}

function buildPptTextParagraphs(lines, options = {}) {
  const fontSize = Number.isFinite(options.fontSize) ? options.fontSize : 1800
  const bold = options.bold ? ' b="1"' : ''
  const color = options.color ? `<a:solidFill><a:srgbClr val="${options.color}"/></a:solidFill>` : ''
  const paragraphs = lines
    .filter((line) => typeof line === 'string' && line.trim())
    .map((line) => `      <a:p><a:pPr algn="l"/><a:r><a:rPr lang="zh-CN" sz="${fontSize}"${bold}>${color}</a:rPr><a:t>${escapeXml(line)}</a:t></a:r><a:endParaRPr lang="zh-CN" sz="${fontSize}"${bold}/></a:p>`)
  if (paragraphs.length === 0) {
    return `      <a:p><a:endParaRPr lang="zh-CN" sz="${fontSize}"${bold}/></a:p>`
  }
  return paragraphs.join('\n')
}

function buildPptTextBox(id, name, x, y, cx, cy, lines, options = {}) {
  const noFill = options.fill ? '' : '<a:noFill/>'
  const fill = options.fill ? `<a:solidFill><a:srgbClr val="${options.fill}"/></a:solidFill>` : ''
  const line = options.line ? `<a:ln w="12700"><a:solidFill><a:srgbClr val="${options.line}"/></a:solidFill></a:ln>` : '<a:ln><a:noFill/></a:ln>'
  const bodyPr = options.bodyPr || 'wrap="square" rtlCol="0" anchor="t"'
  return `    <p:sp>
      <p:nvSpPr>
        <p:cNvPr id="${id}" name="${escapeXml(name)}"/>
        <p:cNvSpPr txBox="1"/>
        <p:nvPr/>
      </p:nvSpPr>
      <p:spPr>
        <a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>
        <a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom>
        ${fill || noFill}
        ${line}
      </p:spPr>
      <p:txBody>
        <a:bodyPr ${bodyPr}/>
        <a:lstStyle/>
${buildPptTextParagraphs(lines, options)}
      </p:txBody>
    </p:sp>`
}

function buildPptPicture(id, name, relId, x, y, cx, cy) {
  return `    <p:pic>
      <p:nvPicPr>
        <p:cNvPr id="${id}" name="${escapeXml(name)}"/>
        <p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>
        <p:nvPr/>
      </p:nvPicPr>
      <p:blipFill>
        <a:blip r:embed="${relId}"/>
        <a:stretch><a:fillRect/></a:stretch>
      </p:blipFill>
      <p:spPr>
        <a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>
        <a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom>
        <a:ln w="12700"><a:solidFill><a:srgbClr val="D0D7E2"/></a:solidFill></a:ln>
      </p:spPr>
    </p:pic>`
}

function buildSlideXml(slide, imageRelId = '') {
  const hasImage = Boolean(imageRelId)
  const contentWidth = hasImage ? 5922000 : 10515600
  const bodyLines = slide.keyPoints.length > 0
    ? slide.keyPoints.map((item) => `• ${item}`)
    : ['• 暂无要点']
  const summaryLines = [
    slide.objective,
    slide.layout ? `版式：${slide.layout}` : '',
    slide.visualDirection ? `视觉：${slide.visualDirection}` : ''
  ].filter(Boolean)

  const shapes = [
    buildPptTextBox(2, 'Title', 457200, 320040, 10515600, 762000, [slide.title], {
      fontSize: 2600,
      bold: true,
      color: '172033'
    }),
    buildPptTextBox(3, 'Summary', 457200, 1219200, contentWidth, 1143000, summaryLines, {
      fontSize: 1600,
      fill: 'F6F8FB',
      line: 'DDE5EF',
      color: '334155',
      bodyPr: 'wrap="square" rtlCol="0" anchor="ctr" lIns="182880" rIns="182880" tIns="121920" bIns="121920"'
    }),
    buildPptTextBox(4, 'Key Points', 457200, 2514600, contentWidth, 2540000, bodyLines, {
      fontSize: 1800,
      color: '111827'
    }),
    buildPptTextBox(5, 'Speaker Notes', 457200, 5257800, 10515600, 1097280, [
      slide.speakerNotes || '讲述建议：按这一页的目标串联上下文，并聚焦一个主要信息点。'
    ], {
      fontSize: 1400,
      fill: 'FFF4ED',
      line: 'FDBA74',
      color: '7C2D12',
      bodyPr: 'wrap="square" rtlCol="0" anchor="t" lIns="182880" rIns="182880" tIns="121920" bIns="121920"'
    })
  ]

  if (hasImage) {
    shapes.push(buildPptPicture(6, 'Slide Image', imageRelId, 6858000, 1219200, 4069080, 3048000))
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg>
      <p:bgPr>
        <a:solidFill><a:srgbClr val="FBFCFE"/></a:solidFill>
        <a:effectLst/>
      </p:bgPr>
    </p:bg>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr>
        <a:xfrm>
          <a:off x="0" y="0"/>
          <a:ext cx="0" cy="0"/>
          <a:chOff x="0" y="0"/>
          <a:chExt cx="0" cy="0"/>
        </a:xfrm>
      </p:grpSpPr>
${shapes.join('\n')}
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`
}

function buildSlideRelsXml(imageRelId = '', imageTarget = '') {
  const imageRelationship = imageRelId && imageTarget
    ? `\n  <Relationship Id="${imageRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${escapeXml(imageTarget)}"/>`
    : ''
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>${imageRelationship}
</Relationships>`
}

function buildPresentationXml(slideCount) {
  const slideIds = Array.from({ length: slideCount }, (_, index) => (
    `    <p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`
  )).join('\n')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1" autoCompressPictures="0">
  <p:sldMasterIdLst>
    <p:sldMasterId id="2147483648" r:id="rId1"/>
  </p:sldMasterIdLst>
  <p:sldIdLst>
${slideIds}
  </p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000" type="screen16x9"/>
  <p:notesSz cx="6858000" cy="9144000"/>
  <p:defaultTextStyle/>
</p:presentation>`
}

function buildPresentationRelsXml(slideCount) {
  const slideRelationships = Array.from({ length: slideCount }, (_, index) => (
    `  <Relationship Id="rId${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`
  )).join('\n')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
${slideRelationships}
</Relationships>`
}

function buildContentTypesXml(slideCount, imageExtensions) {
  const imageDefaults = Array.from(imageExtensions)
    .map((ext) => {
      if (ext === 'png') return '  <Default Extension="png" ContentType="image/png"/>'
      if (ext === 'jpg' || ext === 'jpeg') return '  <Default Extension="jpg" ContentType="image/jpeg"/>'
      if (ext === 'webp') return '  <Default Extension="webp" ContentType="image/webp"/>'
      if (ext === 'gif') return '  <Default Extension="gif" ContentType="image/gif"/>'
      return ''
    })
    .filter(Boolean)
    .join('\n')
  const slideOverrides = Array.from({ length: slideCount }, (_, index) => (
    `  <Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
  )).join('\n')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
${imageDefaults ? `${imageDefaults}\n` : ''}  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/>
  <Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/>
  <Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
${slideOverrides}
</Types>`
}

function buildPptxTemplateFiles(title, slideCount) {
  const safeTitle = escapeXml(title || 'PPT Export')
  const now = new Date().toISOString()
  return {
    '[Content_Types].xml': null,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
    'docProps/app.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Microsoft Office PowerPoint</Application>
  <PresentationFormat>Widescreen</PresentationFormat>
  <Slides>${slideCount}</Slides>
  <Notes>0</Notes>
  <HiddenSlides>0</HiddenSlides>
  <MMClips>0</MMClips>
  <ScaleCrop>false</ScaleCrop>
  <Company>MeteorAPI</Company>
  <LinksUpToDate>false</LinksUpToDate>
  <SharedDoc>false</SharedDoc>
  <HyperlinksChanged>false</HyperlinksChanged>
  <AppVersion>16.0000</AppVersion>
</Properties>`,
    'docProps/core.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${safeTitle}</dc:title>
  <dc:creator>MeteorAPI Playground</dc:creator>
  <cp:lastModifiedBy>MeteorAPI Playground</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`,
    'ppt/presProps.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentationPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`,
    'ppt/viewProps.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:viewPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:normalViewPr showOutlineIcons="0" snapVertSplitter="1">
    <p:restoredLeft sz="15620"/>
    <p:restoredTop sz="94660"/>
  </p:normalViewPr>
  <p:slideViewPr>
    <p:cSldViewPr showGuides="1" snapToGrid="1" snapToObjects="1"/>
  </p:slideViewPr>
  <p:notesTextViewPr/>
  <p:gridSpacing cx="78028800" cy="78028800"/>
</p:viewPr>`,
    'ppt/tableStyles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`,
    'ppt/slideMasters/slideMaster1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld name="Office Theme">
    <p:bg>
      <p:bgPr>
        <a:solidFill><a:srgbClr val="FBFCFE"/></a:solidFill>
        <a:effectLst/>
      </p:bgPr>
    </p:bg>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr>
        <a:xfrm>
          <a:off x="0" y="0"/>
          <a:ext cx="0" cy="0"/>
          <a:chOff x="0" y="0"/>
          <a:chExt cx="0" cy="0"/>
        </a:xfrm>
      </p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:sldLayoutIdLst>
    <p:sldLayoutId id="1" r:id="rId1"/>
  </p:sldLayoutIdLst>
  <p:txStyles>
    <p:titleStyle/>
    <p:bodyStyle/>
    <p:otherStyle/>
  </p:txStyles>
</p:sldMaster>`,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`,
    'ppt/slideLayouts/slideLayout1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
  <p:cSld name="Blank">
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr>
        <a:xfrm>
          <a:off x="0" y="0"/>
          <a:ext cx="0" cy="0"/>
          <a:chOff x="0" y="0"/>
          <a:chExt cx="0" cy="0"/>
        </a:xfrm>
      </p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`,
    'ppt/theme/theme1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="MeteorAPI Theme">
  <a:themeElements>
    <a:clrScheme name="MeteorAPI">
      <a:dk1><a:srgbClr val="111827"/></a:dk1>
      <a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="172033"/></a:dk2>
      <a:lt2><a:srgbClr val="F8FAFC"/></a:lt2>
      <a:accent1><a:srgbClr val="F97316"/></a:accent1>
      <a:accent2><a:srgbClr val="2563EB"/></a:accent2>
      <a:accent3><a:srgbClr val="0F766E"/></a:accent3>
      <a:accent4><a:srgbClr val="9333EA"/></a:accent4>
      <a:accent5><a:srgbClr val="DC2626"/></a:accent5>
      <a:accent6><a:srgbClr val="475569"/></a:accent6>
      <a:hlink><a:srgbClr val="2563EB"/></a:hlink>
      <a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="MeteorAPI">
      <a:majorFont>
        <a:latin typeface="Aptos Display"/>
        <a:ea typeface="Microsoft YaHei"/>
        <a:cs typeface="Arial"/>
      </a:majorFont>
      <a:minorFont>
        <a:latin typeface="Aptos"/>
        <a:ea typeface="Microsoft YaHei"/>
        <a:cs typeface="Arial"/>
      </a:minorFont>
    </a:fontScheme>
    <a:fmtScheme name="MeteorAPI">
      <a:fillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
      </a:fillStyleLst>
      <a:lnStyleLst>
        <a:ln w="9525" cap="flat" cmpd="sng" algn="ctr">
          <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
          <a:prstDash val="solid"/>
        </a:ln>
      </a:lnStyleLst>
      <a:effectStyleLst>
        <a:effectStyle><a:effectLst/></a:effectStyle>
      </a:effectStyleLst>
      <a:bgFillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
      </a:bgFillStyleLst>
    </a:fmtScheme>
  </a:themeElements>
  <a:objectDefaults/>
  <a:extraClrSchemeLst/>
</a:theme>`
  }
}

async function createPptxBuffer(userId, req, payload) {
  const { plan, slideImages } = normalizePptExportRequest(payload)
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'playground-pptx-'))
  const packageRoot = path.join(tempRoot, 'package')
  const outputPath = path.join(tempRoot, 'export.pptx')

  try {
    await mkdir(path.join(packageRoot, '_rels'), { recursive: true })
    await mkdir(path.join(packageRoot, 'docProps'), { recursive: true })
    await mkdir(path.join(packageRoot, 'ppt', '_rels'), { recursive: true })
    await mkdir(path.join(packageRoot, 'ppt', 'slides', '_rels'), { recursive: true })
    await mkdir(path.join(packageRoot, 'ppt', 'slideMasters', '_rels'), { recursive: true })
    await mkdir(path.join(packageRoot, 'ppt', 'slideLayouts', '_rels'), { recursive: true })
    await mkdir(path.join(packageRoot, 'ppt', 'theme'), { recursive: true })
    await mkdir(path.join(packageRoot, 'ppt', 'media'), { recursive: true })

    const templateFiles = buildPptxTemplateFiles(plan.projectTitle, plan.slides.length)
    const imageExtensions = new Set()

    for (const [relativePath, content] of Object.entries(templateFiles)) {
      if (content === null) {
        continue
      }
      const target = path.join(packageRoot, relativePath)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, content, 'utf8')
    }

    for (let index = 0; index < plan.slides.length; index += 1) {
      const slide = plan.slides[index]
      const source = slide.slideImageId ? slideImages.get(slide.slideImageId) : ''
      let mediaFileName = ''
      let imageRelId = ''

      if (source) {
        const image = await loadPptExportImage(userId, req, source)
        if (image?.buffer?.length) {
          const ext = extFromMime(image.mimeType || 'image/png').replace(/^\./, '') || 'png'
          mediaFileName = `image${index + 1}.${ext === 'jpeg' ? 'jpg' : ext}`
          imageRelId = 'rId2'
          imageExtensions.add(ext === 'jpeg' ? 'jpg' : ext)
          await writeFile(path.join(packageRoot, 'ppt', 'media', mediaFileName), image.buffer)
        }
      }

      await writeFile(path.join(packageRoot, 'ppt', 'slides', `slide${index + 1}.xml`), buildSlideXml(slide, imageRelId), 'utf8')
      await writeFile(
        path.join(packageRoot, 'ppt', 'slides', '_rels', `slide${index + 1}.xml.rels`),
        buildSlideRelsXml(imageRelId, mediaFileName),
        'utf8'
      )
    }

    await writeFile(path.join(packageRoot, '[Content_Types].xml'), buildContentTypesXml(plan.slides.length, imageExtensions), 'utf8')
    await writeFile(path.join(packageRoot, 'ppt', 'presentation.xml'), buildPresentationXml(plan.slides.length), 'utf8')
    await writeFile(path.join(packageRoot, 'ppt', '_rels', 'presentation.xml.rels'), buildPresentationRelsXml(plan.slides.length), 'utf8')

    await new Promise((resolve, reject) => {
      execFile(
        'zip',
        ['-qr', outputPath, '[Content_Types].xml', '_rels', 'docProps', 'ppt'],
        { cwd: packageRoot },
        (error) => {
          if (error) {
            reject(appError(500, 'Unable to package PPTX export'))
            return
          }
          resolve()
        }
      )
    })

    return {
      buffer: await readFile(outputPath),
      filename: `${(plan.projectTitle || 'ppt-export').replace(/[^\w\u4e00-\u9fa5-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'ppt-export'}.pptx`
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

async function persistAssetBinary(asset, buffer, mimeType) {
  if (r2Configured) {
    await uploadAssetToR2(asset.public_token, buffer, mimeType)
  }
  if (shouldKeepLocalAssetCopy()) {
    await writeLocalAssetFile(asset.file_path, buffer)
  }
}

function absolutePublicUrl(req, value) {
  if (/^https?:\/\//i.test(value)) {
    return value
  }
  const host = req.headers?.['x-forwarded-host'] || req.headers?.host
  if (!publicOrigin && !host) {
    return value
  }
  const origin = publicOrigin || `${req.headers?.['x-forwarded-proto'] || 'http'}://${host}`
  return `${origin}${value.startsWith('/') ? value : `/${value}`}`
}

function cloudflareImageUrl(req, value, width = thumbnailWidth) {
  if (!cloudflareImageResizingEnabled) {
    return value
  }
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 480
  const originalUrl = absolutePublicUrl(req, value)
  if (!/^https?:\/\//i.test(originalUrl)) {
    return value
  }
  return `/cdn-cgi/image/width=${safeWidth},quality=70,format=webp,fit=scale-down/${originalUrl}`
}

async function persistAsset(userId, kind, namedAsset) {
  let buffer = null
  let mimeType = ''
  if (namedAsset?.dataUrl && String(namedAsset.dataUrl).startsWith('data:')) {
    const parsed = dataUrlToBuffer(namedAsset.dataUrl, namedAsset.mimeType)
    buffer = parsed.buffer
    mimeType = parsed.mimeType
  }

  if (namedAsset?.assetToken) {
    const existing = await getAssetByToken(namedAsset.assetToken)
    if (existing && Number(existing.user_id) === Number(userId)) {
      if (buffer) {
        await persistAssetBinary(existing, buffer, mimeType || existing.mime_type)
      }
      return existing
    }
  }

  if (!buffer) {
    return null
  }

  const sha256 = hashBuffer(buffer)
  const existing = await findAssetByHash(userId, sha256)
  if (existing) {
    await persistAssetBinary(existing, buffer, mimeType || existing.mime_type)
    return existing
  }

  const assetId = randomUUID()
  const token = randomUUID()
  const extension = extFromMime(mimeType)
  const relativePath = path.join(String(userId), kind, `${assetId}${extension}`)
  const assetRecord = {
    id: assetId,
    user_id: userId,
    kind,
    file_path: relativePath,
    mime_type: mimeType,
    size_bytes: buffer.length,
    sha256,
    public_token: token
  }

  await persistAssetBinary(assetRecord, buffer, mimeType)

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
    assetToken: asset.public_token,
    image_url: resolveImageUrl(asset.public_token, '')
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
  const rawMask = payload?.mask && typeof payload.mask === 'object' ? payload.mask : null
  const mask = rawMask && typeof rawMask.data_url === 'string' && rawMask.data_url.trim()
    ? {
      name: typeof rawMask.name === 'string' && rawMask.name.trim() ? rawMask.name.trim() : 'mask.png',
      mime_type: typeof rawMask.mime_type === 'string' && rawMask.mime_type.trim() ? rawMask.mime_type.trim() : 'image/png',
      data_url: rawMask.data_url
    }
    : null
  const conversationId = typeof payload?.conversation_id === 'string' ? payload.conversation_id.trim() : ''
  const source = payload?.source === 'chat' ? 'chat' : 'direct'
  const assistantMessageId = typeof payload?.assistant_message_id === 'string' ? payload.assistant_message_id.trim() : ''
  const stream = payload?.stream !== false
  const partialImages = Number.isInteger(payload?.partial_images) && payload.partial_images > 0
    ? Math.min(payload.partial_images, 3)
    : 2

  return {
    mode,
    prompt,
    size,
    model,
    response_format: responseFormat,
    n,
    stream,
    partial_images: partialImages,
    images,
    mask,
    conversation_id: conversationId || null,
    source,
    assistant_message_id: assistantMessageId || null
  }
}

async function resolveEditImageBlob(image, task, index) {
  const dataUrl = typeof image?.data_url === 'string' ? image.data_url.trim() : ''
  if (dataUrl.startsWith('data:')) {
    return dataUrlToBlob(dataUrl, image?.mime_type)
  }

  const assetToken = (
    typeof image?.asset_token === 'string' ? image.asset_token.trim() : ''
  ) || assetTokenFromUrl(dataUrl) || assetTokenFromUrl(image?.image_url) || assetTokenFromUrl(image?.remote_url)

  if (assetToken) {
    const asset = await getAssetByToken(assetToken)
    if (!asset || Number(asset.user_id) !== Number(task.userId)) {
      throw appError(404, 'Edit source image not found')
    }
    const { buffer, mimeType } = await loadAssetBuffer(asset)
    return new Blob([buffer], { type: mimeType || image?.mime_type || asset.mime_type || 'image/png' })
  }

  const remoteUrl = (
    typeof image?.remote_url === 'string' ? image.remote_url.trim() : ''
  ) || (
    typeof image?.image_url === 'string' ? image.image_url.trim() : ''
  ) || (/^https?:\/\//i.test(dataUrl) ? dataUrl : '')

  if (remoteUrl) {
    const { buffer, mimeType } = await fetchImageUrlBuffer(remoteUrl, image?.mime_type || 'image/png')
    return new Blob([buffer], { type: mimeType || image?.mime_type || 'image/png' })
  }

  throw appError(400, `Edit source image ${index + 1} is missing data_url, asset_token, or image_url`)
}

async function callImageUpstream(task) {
  if (task.payload.mode === 'edit') {
    const form = new FormData()
    form.set('model', task.payload.model)
    form.set('prompt', task.payload.prompt)
    form.set('size', task.payload.size)
    form.set('n', String(task.payload.n))
    form.set('response_format', task.payload.response_format)
    form.set('stream', String(task.payload.stream))
    if (task.payload.stream) {
      form.set('partial_images', String(task.payload.partial_images))
    }

    for (const [index, image] of task.payload.images.entries()) {
      const blob = await resolveEditImageBlob(image, task, index)
      const filename = typeof image?.name === 'string' && image.name.trim() ? image.name.trim() : `edit-source-${index + 1}.png`
      form.append('image', blob, filename)
    }
    if (task.payload.mask?.data_url) {
      const blob = dataUrlToBlob(task.payload.mask.data_url, task.payload.mask.mime_type || 'image/png')
      const filename = typeof task.payload.mask.name === 'string' && task.payload.mask.name.trim()
        ? task.payload.mask.name.trim()
        : 'mask.png'
      form.append('mask', blob, filename)
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
      response_format: task.payload.response_format,
      stream: task.payload.stream,
      partial_images: task.payload.partial_images
    })
  })
}

function buildTaskResponse(task) {
  const status = task.status === 'completed' && !task.archived ? 'processing' : task.status
  const result = task.result && typeof task.result === 'object'
    ? {
      ...task.result,
      images: Array.isArray(task.result.images)
        ? task.result.images.map((image) => ({
          ...image,
          image_url: typeof image?.image_url === 'string' && image.image_url.trim()
            ? image.image_url.trim()
            : resolveImageUrl('', image?.remote_url)
        }))
        : []
    }
    : null
  return {
    task_id: task.id,
    status,
    conversation_id: task.payload.conversation_id,
    mode: task.payload.mode,
    prompt: task.payload.prompt,
    size: task.payload.size,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    error: task.error || null,
    result
  }
}

function mapTaskRow(row) {
  return {
    id: row.id,
    userId: Number(row.user_id),
    apiKey: row.api_key || '',
    payload: row.payload,
    status: row.status,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    error: row.error || null,
    result: row.result || null,
    archived: Boolean(row.archived)
  }
}

async function getPersistedImageTask(taskId) {
  const pool = requireDb()
  const result = await pool.query(
    `SELECT id, user_id, api_key, payload, status, error, result, archived, created_at, updated_at
     FROM playground_image_tasks
     WHERE id = $1`,
    [taskId]
  )
  return result.rows[0] ? mapTaskRow(result.rows[0]) : null
}

async function insertPersistedImageTask(task) {
  const pool = requireDb()
  await pool.query(
    `INSERT INTO playground_image_tasks (id, user_id, api_key, payload, status, error, result, archived, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      task.id,
      task.userId,
      task.apiKey,
      JSON.stringify(task.payload),
      task.status,
      task.error,
      task.result ? JSON.stringify(task.result) : null,
      task.archived,
      task.createdAt,
      task.updatedAt
    ]
  )
}

async function updatePersistedImageTask(task) {
  const pool = requireDb()
  await pool.query(
    `UPDATE playground_image_tasks
     SET api_key = $2,
         payload = $3,
         status = $4,
         error = $5,
         result = $6,
         archived = $7,
         updated_at = $8
     WHERE id = $1`,
    [
      task.id,
      task.status === 'completed' || task.status === 'failed' ? null : task.apiKey,
      JSON.stringify(task.payload),
      task.status,
      task.error,
      task.result ? JSON.stringify(task.result) : null,
      task.archived,
      task.updatedAt
    ]
  )
}

function buildTaskImageItems(task) {
  return (task.result?.images || [])
    .map((image, index) => ({
      id: `${task.id}-${image.id || index + 1}`,
      shareKey: `${task.id}-${image.id || index + 1}`,
      prompt: image.prompt || task.payload.prompt,
      size: image.size || task.payload.size,
      dataUrl: image.data_url || undefined,
      remoteUrl: image.remote_url || undefined,
      image_url: typeof image.image_url === 'string' && image.image_url.trim()
        ? image.image_url.trim()
        : (resolveImageUrl('', image.remote_url) || undefined),
      createdAt: Date.now()
    }))
    .filter((image) => image.dataUrl || image.remoteUrl)
}

function replaceOrAppendStoredMessage(messages, message) {
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

async function archiveImageTaskToConversation(task) {
  if (task.archived || !task.payload.conversation_id) {
    return
  }

  const conversation = await loadConversation(task.userId, task.payload.conversation_id)
  const taskImages = task.status === 'completed' ? buildTaskImageItems(task) : []
  const nextImages = task.status === 'completed'
    ? [...taskImages, ...conversation.state.generatedImages]
    : conversation.state.generatedImages
  const firstImage = nextImages[0] || null
  const assistantMessageId = task.payload.assistant_message_id || `assistant-image-${task.id}`
  const content = task.status === 'failed'
    ? `图片任务失败：${task.error || '图片生成失败'}`
    : (task.payload.mode === 'edit'
      ? `已按要求编辑图片：${task.payload.prompt}`
      : `已根据提示词生成图片：${task.payload.prompt}`)
  const nextMessages = replaceOrAppendStoredMessage(conversation.state.chatMessages, {
    id: assistantMessageId,
    role: 'assistant',
    content,
    createdAt: Date.now(),
    imageDataUrl: task.status === 'completed' && firstImage
      ? firstImage.dataUrl || firstImage.image_url || firstImage.remoteUrl
      : undefined
  })

  await saveConversationState(task.userId, task.payload.conversation_id, {
    workspaceType: conversation.state.workspaceType === 'ppt' ? 'ppt' : 'create',
    chatMessages: nextMessages,
    generatedImages: nextImages,
    pptState: conversation.state.pptState || null
  })
  if (task.status === 'completed' && taskImages.length > 0 && Array.isArray(task.result?.images)) {
    const originalResultImages = task.result.images
    const hydratedConversation = await loadConversation(task.userId, task.payload.conversation_id)
    const taskImageIds = new Set(taskImages.map((image) => image.id))
    const hydratedImageMap = new Map(
      hydratedConversation.state.generatedImages
        .filter((image) => taskImageIds.has(image.id))
        .map((image) => [image.id, image])
    )
    task.result = {
      ...task.result,
      images: taskImages.map((taskImage, index) => {
        const originalImage = originalResultImages[index] || {}
        const hydratedImage = hydratedImageMap.get(taskImage.id)
        return {
          id: originalImage.id || `image-${index + 1}`,
          prompt: hydratedImage?.prompt || taskImage.prompt,
          size: hydratedImage?.size || taskImage.size,
          data_url: hydratedImage?.dataUrl || taskImage.dataUrl || null,
          remote_url: hydratedImage?.remoteUrl || taskImage.remoteUrl || null,
          image_url: hydratedImage?.image_url || taskImage.image_url || null
        }
      })
    }
  }
  task.archived = true
  task.updatedAt = nowIso()
  await updatePersistedImageTask(task)
}

async function runImageTask(task) {
  task.status = 'processing'
  task.updatedAt = nowIso()
  await updatePersistedImageTask(task)

  try {
    const response = await callImageUpstream(task)

    if (!response.ok) {
      const data = await readResponseJson(response)
      throw appError(response.status, parseUpstreamError(data, `Image request failed: HTTP ${response.status}`))
    }

    const contentType = response.headers.get('content-type') || ''
    if (task.payload.stream && contentType.includes('text/event-stream')) {
      await processImageStreamResponse(response, task)
    } else {
      const data = await readResponseJson(response)
      task.result = normalizeImageResult(data, task.payload.prompt, task.payload.size)
    }
    if (!task.result.images || task.result.images.length === 0) {
      throw new Error('图片生成成功，但响应中没有可展示的图片。')
    }
    task.status = 'completed'
    task.updatedAt = nowIso()
    await archiveImageTaskToConversation(task)
  } catch (error) {
    task.status = 'failed'
    task.error = error instanceof Error ? error.message : 'Image task failed'
    task.updatedAt = nowIso()
    try {
      await archiveImageTaskToConversation(task)
    } catch (archiveError) {
      console.error(`Failed to archive failed image task ${task.id}:`, archiveError)
    }
  }
  await updatePersistedImageTask(task)
}

async function createImageTask(body, userId) {
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
    result: null,
    archived: false
  }

  tasks.set(id, task)
  await insertPersistedImageTask(task)
  void runImageTask(task)
  return task
}

async function resumePersistedImageTasks() {
  if (!db) {
    return
  }
  const result = await db.query(
    `SELECT id, user_id, api_key, payload, status, error, result, archived, created_at, updated_at
     FROM playground_image_tasks
     WHERE status IN ('queued', 'processing')
     ORDER BY created_at ASC`
  )
  for (const row of result.rows) {
    const task = mapTaskRow(row)
    if (!task.apiKey) {
      task.status = 'failed'
      task.error = '任务恢复失败：缺少 API Key'
      task.updatedAt = nowIso()
      await updatePersistedImageTask(task)
      await archiveImageTaskToConversation(task)
      continue
    }
    task.status = 'queued'
    task.updatedAt = nowIso()
    tasks.set(task.id, task)
    void runImageTask(task)
  }
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
  if (firstUserMessage) {
    return firstUserMessage.content.trim().slice(0, 48) || '新会话'
  }

  const pptState = state?.pptState && typeof state.pptState === 'object' ? state.pptState : null
  const projectTitle = typeof pptState?.plan?.projectTitle === 'string' ? pptState.plan.projectTitle.trim() : ''
  if (projectTitle) {
    return projectTitle.slice(0, 48)
  }
  const prompt = typeof pptState?.prompt === 'string' ? pptState.prompt.trim() : ''
  if (prompt) {
    return prompt.slice(0, 48)
  }

  return '新会话'
}

function normalizeWorkspaceType(state) {
  if (state?.workspaceType === 'create' || state?.workspaceType === 'ppt') {
    return state.workspaceType
  }

  const chatMessages = Array.isArray(state?.chatMessages) ? state.chatMessages : []
  const generatedImages = Array.isArray(state?.generatedImages) ? state.generatedImages : []
  const hasPpt = Boolean(state?.pptState && typeof state.pptState === 'object' && !Array.isArray(state.pptState))
  if (chatMessages.length > 0 || generatedImages.length > 0) {
    return 'create'
  }
  if (hasPpt) {
    return 'ppt'
  }
  return 'create'
}

function stateEnvelope(state) {
  return {
    workspaceType: normalizeWorkspaceType(state),
    chatMessages: Array.isArray(state?.chatMessages) ? state.chatMessages : [],
    generatedImages: Array.isArray(state?.generatedImages) ? state.generatedImages : [],
    pptState: state?.pptState && typeof state.pptState === 'object' && !Array.isArray(state.pptState)
      ? state.pptState
      : null
  }
}

function normalizePptState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return null
  }

  const plan = state.plan && typeof state.plan === 'object' && !Array.isArray(state.plan)
    ? state.plan
    : null

  return {
    prompt: typeof state.prompt === 'string' ? state.prompt : '',
    style: typeof state.style === 'string' ? state.style : '',
    designDetails: typeof state.designDetails === 'string' ? state.designDetails : '',
    pageCount: Number.isFinite(Number(state.pageCount)) ? Math.min(Math.max(Number(state.pageCount), 1), 30) : 8,
    model: typeof state.model === 'string' ? state.model : '',
    plan
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
    workspaceType: normalizeWorkspaceType(normalized),
    chatMessages: storedMessages,
    generatedImages: storedGeneratedImages,
    pptState: normalizePptState(normalized.pptState)
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
          dataUrl: attachment.externalUrl,
          image_url: attachment.externalUrl
        })
      }
    }

    let imageDataUrl = message.externalImageUrl || undefined
    let image_url = message.externalImageUrl || undefined
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
      image_url = hydratedImage?.image_url
    }

    chatMessages.push({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: Number(message.createdAt) || Date.now(),
      attachments: attachments.length > 0 ? attachments : undefined,
      imageDataUrl,
      imageAssetToken,
      image_url
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
      assetToken,
      image_url: resolveImageUrl(assetToken, image.remoteUrl)
    })
  }

  return {
    workspaceType: normalizeWorkspaceType(normalized),
    chatMessages,
    generatedImages,
    pptState: normalizePptState(normalized.pptState)
  }
}

async function conversationWorkspaceType(userId, row) {
  try {
    const snapshotPath = await ensureConversationSnapshotPath(userId, row)
    const snapshot = await readJsonFile(snapshotPath)
    return normalizeWorkspaceType(snapshot)
  } catch {
    return 'create'
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

  return Promise.all(result.rows.map(async (row) => ({
    id: row.id,
    title: row.title,
    workspaceType: await conversationWorkspaceType(userId, row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessageAt: row.last_message_at
  })))
}

async function createConversation(userId, requestedTitle = '', workspaceType = 'create') {
  const pool = requireDb()
  const id = randomUUID()
  const title = requestedTitle.trim() || '新会话'
  const snapshotPath = conversationSnapshotPath(userId, id)
  await writeJsonFile(snapshotPath, stateEnvelope({ workspaceType }))

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
    workspaceType,
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

async function ensureConversationSnapshotPath(userId, row) {
  const expectedPath = conversationSnapshotPath(userId, row.id)
  const storedPath = typeof row.snapshot_path === 'string' ? row.snapshot_path : ''

  if (storedPath && existsSync(storedPath)) {
    return storedPath
  }

  if (existsSync(expectedPath)) {
    if (storedPath !== expectedPath) {
      const pool = requireDb()
      await pool.query(
        `UPDATE playground_conversations
         SET snapshot_path = $3
         WHERE id = $1 AND user_id = $2`,
        [row.id, userId, expectedPath]
      )
      row.snapshot_path = expectedPath
    }
    return expectedPath
  }

  return storedPath || expectedPath
}

async function loadConversation(userId, conversationId) {
  const row = await getConversationRow(userId, conversationId)
  if (!row) {
    throw appError(404, 'Conversation not found')
  }

  const snapshotPath = await ensureConversationSnapshotPath(userId, row)
  const snapshot = await readJsonFile(snapshotPath)
  const state = await hydrateConversationState(snapshot)

  return {
    conversation: {
      id: row.id,
      title: row.title,
      workspaceType: normalizeWorkspaceType(state),
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

  const snapshotPath = await ensureConversationSnapshotPath(userId, row)
  await writeJsonFile(snapshotPath, normalizedSnapshot)
  const pool = requireDb()
  await pool.query(
    `UPDATE playground_conversations
     SET title = $3,
         last_message_at = $4,
         updated_at = NOW()
     WHERE id = $1 AND user_id = $2`,
    [conversationId, userId, title, lastMessageAt]
  )
  await upsertLibraryItemsForConversation(userId, conversationId, normalizedSnapshot.generatedImages || [])

  return {
    savedAt: nowIso(),
    title
  }
}

function normalizeLibraryFolder(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 64)
}

function normalizeLibraryTags(value) {
  const rawTags = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(/[,\n，]+/) : [])
  const tags = []
  const seen = new Set()
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

function normalizeLibraryIds(value) {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  if (!Array.isArray(value)) {
    return []
  }
  const ids = []
  const seen = new Set()
  for (const item of value) {
    const id = String(item || '').trim()
    if (!uuidPattern.test(id) || seen.has(id)) {
      continue
    }
    seen.add(id)
    ids.push(id)
    if (ids.length >= 200) {
      break
    }
  }
  return ids
}

function mapLibraryRow(row, req) {
  const originalUrl = row.asset_token ? assetPublicUrl(row.asset_token) : row.remote_url
  const thumbnailUrl = row.asset_token ? cloudflareImageUrl(req, originalUrl) : originalUrl
  return {
    id: row.id,
    prompt: row.prompt,
    size: row.size,
    image_url: resolveImageUrl(row.asset_token, row.remote_url),
    imageUrl: thumbnailUrl,
    thumbnailUrl,
    originalUrl,
    sourceConversationId: row.source_conversation_id || undefined,
    sourceImageId: row.source_image_id || undefined,
    folder: row.folder || '',
    tags: Array.isArray(row.tags) ? row.tags : [],
    favorite: Boolean(row.favorite),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

async function upsertLibraryItemsForConversation(userId, conversationId, images) {
  if (!Array.isArray(images) || images.length === 0) {
    return
  }
  const pool = requireDb()
  for (const image of images) {
    const sourceImageId = typeof image?.id === 'string' ? image.id.trim() : ''
    const assetToken = typeof image?.assetToken === 'string' && image.assetToken.trim()
      ? image.assetToken.trim()
      : null
    const remoteUrl = typeof image?.remoteUrl === 'string' && image.remoteUrl.trim()
      ? image.remoteUrl.trim()
      : null
    if (!sourceImageId || (!assetToken && !remoteUrl)) {
      continue
    }

    await pool.query(
      `INSERT INTO playground_library_items (
         id, user_id, asset_token, remote_url, prompt, size, source_conversation_id, source_image_id,
         created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, NOW())
       ON CONFLICT (user_id, source_conversation_id, source_image_id)
       DO UPDATE SET
         asset_token = EXCLUDED.asset_token,
         remote_url = EXCLUDED.remote_url,
         prompt = EXCLUDED.prompt,
         size = EXCLUDED.size`,
      [
        randomUUID(),
        userId,
        assetToken,
        remoteUrl,
        typeof image.prompt === 'string' && image.prompt.trim() ? image.prompt.trim() : 'Untitled prompt',
        typeof image.size === 'string' && image.size.trim() ? image.size.trim() : 'unknown',
        conversationId,
        sourceImageId,
        Number.isFinite(Number(image.createdAt)) ? new Date(Number(image.createdAt)).toISOString() : nowIso()
      ]
    )
  }
}

function libraryFilterFromSearchParams(searchParams) {
  const folderParam = searchParams.has('folder') ? String(searchParams.get('folder') || '') : null
  return {
    query: String(searchParams.get('q') || '').trim().slice(0, 120),
    folder: folderParam === null
      ? null
      : (folderParam === '__none' ? '' : normalizeLibraryFolder(folderParam)),
    tag: normalizeLibraryTags([searchParams.get('tag') || ''])[0] || '',
    favorite: searchParams.get('favorite') === '1'
  }
}

function libraryWhereClause(filters) {
  return `
    WHERE user_id = $1
      AND deleted_at IS NULL
      AND (
        $2::text = ''
        OR prompt ILIKE '%' || $2 || '%'
        OR size ILIKE '%' || $2 || '%'
        OR folder ILIKE '%' || $2 || '%'
        OR source_image_id ILIKE '%' || $2 || '%'
        OR EXISTS (
          SELECT 1
          FROM unnest(tags) AS tag_name
          WHERE tag_name ILIKE '%' || $2 || '%'
        )
      )
      AND ($3::text IS NULL OR folder = $3)
      AND ($4::text = '' OR EXISTS (
        SELECT 1
        FROM unnest(tags) AS tag_name
        WHERE lower(tag_name) = lower($4)
      ))
      AND ($5::boolean = FALSE OR favorite = TRUE)
  `
}

async function listLibraryItems(req, user, searchParams) {
  const pool = requireDb()
  const safeLimit = Math.min(Math.max(Number.parseInt(String(searchParams.get('limit') || '24'), 10) || 24, 1), 60)
  const safeOffset = Math.max(Number.parseInt(String(searchParams.get('offset') || '0'), 10) || 0, 0)
  const filters = libraryFilterFromSearchParams(searchParams)
  const filterValues = [user.id, filters.query, filters.folder, filters.tag, filters.favorite]
  const where = libraryWhereClause(filters)

  const [itemsResult, countResult, foldersResult, tagsResult] = await Promise.all([
    pool.query(
      `SELECT id, asset_token, remote_url, prompt, size, source_conversation_id, source_image_id,
              folder, tags, favorite, created_at, updated_at
       FROM playground_library_items
       ${where}
       ORDER BY favorite DESC, created_at DESC
       LIMIT $6 OFFSET $7`,
      [...filterValues, safeLimit + 1, safeOffset]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total
       FROM playground_library_items
       ${where}`,
      filterValues
    ),
    pool.query(
      `SELECT folder AS name, COUNT(*)::int AS count
       FROM playground_library_items
       WHERE user_id = $1 AND deleted_at IS NULL
       GROUP BY folder
       ORDER BY count DESC, folder ASC`,
      [user.id]
    ),
    pool.query(
      `SELECT tag_name AS name, COUNT(*)::int AS count
       FROM playground_library_items, unnest(tags) AS tag_name
       WHERE user_id = $1 AND deleted_at IS NULL
       GROUP BY tag_name
       ORDER BY count DESC, tag_name ASC`,
      [user.id]
    )
  ])

  const rows = itemsResult.rows.slice(0, safeLimit)
  return {
    items: rows.map((row) => mapLibraryRow(row, req)),
    nextOffset: itemsResult.rows.length > safeLimit ? safeOffset + rows.length : null,
    hasMore: itemsResult.rows.length > safeLimit,
    folders: foldersResult.rows.map((row) => ({ name: row.name || '', count: Number(row.count) || 0 })),
    tags: tagsResult.rows.map((row) => ({ name: row.name, count: Number(row.count) || 0 })),
    total: Number(countResult.rows[0]?.total) || 0
  }
}

async function updateLibraryItem(user, itemId, body) {
  const updates = []
  const values = [itemId, user.id]

  if (Object.prototype.hasOwnProperty.call(body || {}, 'folder')) {
    values.push(normalizeLibraryFolder(body.folder))
    updates.push(`folder = $${values.length}`)
  }
  if (Object.prototype.hasOwnProperty.call(body || {}, 'tags')) {
    values.push(normalizeLibraryTags(body.tags))
    updates.push(`tags = $${values.length}::text[]`)
  }
  if (Object.prototype.hasOwnProperty.call(body || {}, 'favorite')) {
    values.push(Boolean(body.favorite))
    updates.push(`favorite = $${values.length}`)
  }

  if (updates.length === 0) {
    throw appError(400, 'No library fields to update')
  }

  const pool = requireDb()
  const result = await pool.query(
    `UPDATE playground_library_items
     SET ${updates.join(', ')}, updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
     RETURNING id, asset_token, remote_url, prompt, size, source_conversation_id, source_image_id,
               folder, tags, favorite, created_at, updated_at`,
    values
  )
  if (!result.rows[0]) {
    throw appError(404, 'Library item not found')
  }
  return mapLibraryRow(result.rows[0], { headers: {} })
}

async function deleteLibraryItems(user, ids) {
  const normalizedIds = normalizeLibraryIds(ids)
  if (normalizedIds.length === 0) {
    throw appError(400, 'No valid library item IDs')
  }
  const pool = requireDb()
  const result = await pool.query(
    `UPDATE playground_library_items
     SET deleted_at = NOW(), updated_at = NOW()
     WHERE user_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`,
    [user.id, normalizedIds]
  )
  return { updated: result.rowCount || 0 }
}

async function batchUpdateLibraryItems(user, body) {
  const ids = normalizeLibraryIds(body?.ids)
  if (ids.length === 0) {
    throw appError(400, 'No valid library item IDs')
  }

  const action = String(body?.action || '')
  const pool = requireDb()
  if (action === 'delete') {
    return deleteLibraryItems(user, ids)
  }
  if (action === 'favorite' || action === 'unfavorite') {
    const result = await pool.query(
      `UPDATE playground_library_items
       SET favorite = $3, updated_at = NOW()
       WHERE user_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`,
      [user.id, ids, action === 'favorite']
    )
    return { updated: result.rowCount || 0 }
  }
  if (action === 'move') {
    const folder = normalizeLibraryFolder(body?.folder)
    const result = await pool.query(
      `UPDATE playground_library_items
       SET folder = $3, updated_at = NOW()
       WHERE user_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`,
      [user.id, ids, folder]
    )
    return { updated: result.rowCount || 0 }
  }
  if (action === 'set_tags' || action === 'add_tags' || action === 'remove_tags') {
    const incomingTags = normalizeLibraryTags(body?.tags)
    if ((action === 'add_tags' || action === 'remove_tags') && incomingTags.length === 0) {
      throw appError(400, 'tags are required')
    }
    const current = await pool.query(
      `SELECT id, tags
       FROM playground_library_items
       WHERE user_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`,
      [user.id, ids]
    )
    for (const row of current.rows) {
      const currentTags = normalizeLibraryTags(row.tags || [])
      let nextTags = incomingTags
      if (action === 'add_tags') {
        nextTags = normalizeLibraryTags([...currentTags, ...incomingTags])
      } else if (action === 'remove_tags') {
        const removeSet = new Set(incomingTags.map((tag) => tag.toLowerCase()))
        nextTags = currentTags.filter((tag) => !removeSet.has(tag.toLowerCase()))
      }
      await pool.query(
        `UPDATE playground_library_items
         SET tags = $3::text[], updated_at = NOW()
         WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL`,
        [user.id, row.id, nextTags]
      )
    }
    return { updated: current.rows.length }
  }

  throw appError(400, 'Unsupported library batch action')
}

function mapGalleryRow(row, req) {
  const originalUrl = row.asset_token ? assetPublicUrl(row.asset_token) : row.remote_url
  const thumbnailUrl = row.asset_token ? cloudflareImageUrl(req, originalUrl) : originalUrl
  return {
    id: row.id,
    prompt: row.prompt,
    size: row.size,
    image_url: resolveImageUrl(row.asset_token, row.remote_url),
    imageUrl: thumbnailUrl,
    thumbnailUrl,
    originalUrl,
    sourceConversationId: row.source_conversation_id,
    sourceImageId: row.source_image_id,
    sharedByUserId: Number(row.shared_by_user_id),
    sharedByName: row.shared_by_name || undefined,
    createdAt: row.created_at
  }
}

async function listGalleryItems(req, limit, offset) {
  const pool = requireDb()
  const safeLimit = Math.min(Math.max(Number.parseInt(String(limit || '2'), 10) || 2, 1), 12)
  const safeOffset = Math.max(Number.parseInt(String(offset || '0'), 10) || 0, 0)
  const result = await pool.query(
    `SELECT id, asset_token, remote_url, prompt, size, source_conversation_id, source_image_id,
            shared_by_user_id, shared_by_name, created_at
     FROM playground_gallery_items
     ORDER BY created_at DESC
     LIMIT $1 OFFSET $2`,
    [safeLimit + 1, safeOffset]
  )
  const hasMore = result.rows.length > safeLimit
  const items = result.rows.slice(0, safeLimit).map((row) => mapGalleryRow(row, req))
  return {
    items,
    nextOffset: hasMore ? safeOffset + items.length : null,
    hasMore
  }
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
      item: mapGalleryRow(existing.rows[0], { headers: {} }),
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
    item: mapGalleryRow(row, { headers: {} }),
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
setInterval(cleanupRateLimitHits, 60 * 1000).unref()
await ensureRuntime()
await resumePersistedImageTasks()

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost')

    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      res.end('ok\n')
      return
    }

    applyRateLimit(req, url)

    if (req.method === 'GET' && url.pathname === '/api/playground/gallery') {
      const page = await listGalleryItems(req, url.searchParams.get('limit'), url.searchParams.get('offset'))
      const body = JSON.stringify({ code: 0, message: 'success', data: page })
      res.writeHead(200, {
        'Cache-Control': 'public, max-age=30, s-maxage=300, stale-while-revalidate=600',
        'CDN-Cache-Control': 'public, max-age=300, stale-while-revalidate=600',
        'Content-Length': Buffer.byteLength(body),
        'Content-Type': 'application/json; charset=utf-8'
      })
      res.end(body)
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/playground/gallery') {
      const user = await getAuthenticatedUser(req)
      const body = await parseJsonBody(req)
      const result = await shareGalleryImage(user, body)
      json(res, result.alreadyExists ? 200 : 201, { code: 0, message: 'success', data: result })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/playground/library') {
      const user = await getAuthenticatedUser(req)
      const page = await listLibraryItems(req, user, url.searchParams)
      json(res, 200, { code: 0, message: 'success', data: page })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/playground/library/batch') {
      const user = await getAuthenticatedUser(req)
      const body = await parseJsonBody(req)
      const result = await batchUpdateLibraryItems(user, body)
      json(res, 200, { code: 0, message: 'success', data: result })
      return
    }

    if ((req.method === 'PATCH' || req.method === 'DELETE') && url.pathname.startsWith('/api/playground/library/')) {
      const user = await getAuthenticatedUser(req)
      const itemId = url.pathname.split('/').pop()
      if (!itemId) {
        throw appError(400, 'Library item ID is required')
      }
      if (req.method === 'DELETE') {
        const result = await deleteLibraryItems(user, [itemId])
        json(res, 200, { code: 0, message: 'success', data: result })
        return
      }
      const body = await parseJsonBody(req)
      const item = await updateLibraryItem(user, itemId, body)
      json(res, 200, { code: 0, message: 'success', data: item })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/playground/conversations') {
      const user = await getAuthenticatedUser(req)
      const conversations = await listConversations(user.id)
      json(res, 200, { code: 0, message: 'success', data: conversations })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/playground/ppt/export') {
      const user = await getAuthenticatedUser(req)
      const body = await parseJsonBody(req)
      const exported = await createPptxBuffer(user.id, req, body)
      res.writeHead(200, {
        'Content-Disposition': buildAttachmentDisposition(exported.filename),
        'Content-Length': String(exported.buffer.length),
        'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      })
      res.end(exported.buffer)
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/playground/conversations') {
      const user = await getAuthenticatedUser(req)
      const body = await parseJsonBody(req)
      const workspaceType = body?.workspace_type === 'ppt' ? 'ppt' : 'create'
      const conversation = await createConversation(user.id, typeof body?.title === 'string' ? body.title : '', workspaceType)
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

    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/api/playground/assets/')) {
      const token = url.pathname.split('/').pop()
      if (!token) {
        throw appError(400, 'Asset token is required')
      }
      const wantsDownload = url.searchParams.get('download') === '1'
      const downloadName = typeof url.searchParams.get('filename') === 'string' ? url.searchParams.get('filename') : ''
      const asset = await getAssetByToken(token)
      if (!asset) {
        throw appError(404, 'Asset not found')
      }
      const filePath = assetAbsolutePath(asset.file_path)
      if (!existsSync(filePath)) {
        if (!r2Configured) {
          throw appError(404, 'Asset file not found')
        }
        if (wantsDownload) {
          await streamAssetFromR2(res, asset, {
            headOnly: req.method === 'HEAD',
            downloadName
          })
          return
        }
        const redirectUrl = assetImageUrl(asset.public_token)
        if (!redirectUrl) {
          throw appError(404, 'Asset file not found')
        }
        res.writeHead(307, {
          'Cache-Control': 'public, max-age=31536000, immutable',
          'CDN-Cache-Control': 'public, max-age=31536000, immutable',
          Location: redirectUrl
        })
        res.end()
        return
      }
      const headers = {
        'Cache-Control': 'public, max-age=31536000, immutable',
        'CDN-Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Length': String(asset.size_bytes),
        'Content-Type': asset.mime_type
      }
      if (wantsDownload) {
        headers['Content-Disposition'] = buildAttachmentDisposition(buildAssetDownloadFilename(asset, downloadName))
      }
      res.writeHead(200, headers)
      if (req.method === 'HEAD') {
        res.end()
        return
      }
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
      const task = await createImageTask(body, user.id)
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
      const task = taskId ? (tasks.get(taskId) || await getPersistedImageTask(taskId)) : null
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
    const extraHeaders = {}
    if (Number.isInteger(error?.retryAfterSeconds)) {
      extraHeaders['Retry-After'] = String(error.retryAfterSeconds)
    }
    json(res, getErrorStatus(error), {
      code: getErrorStatus(error),
      message: error instanceof Error ? error.message : 'Internal server error'
    }, extraHeaders)
  }
})

server.listen(port, '0.0.0.0', () => {
  console.log(`image-playground server listening on http://0.0.0.0:${port}`)
  console.log(`playground data dir: ${dataRoot}`)
  if (db) {
    console.log('playground PostgreSQL persistence is enabled')
  }
})
