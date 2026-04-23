import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const port = Number.parseInt(process.env.PORT || '8081', 10)
const upstream = (process.env.SUB2API_UPSTREAM || 'http://127.0.0.1:8080').replace(/\/$/, '')
const staticRoot = path.join(__dirname, 'dist')

const taskRetentionMs = 60 * 60 * 1000
const taskHardTTLms = 6 * 60 * 60 * 1000
const tasks = new Map()

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

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0

    req.on('data', (chunk) => {
      total += chunk.length
      if (total > 2 * 1024 * 1024) {
        reject(new Error('Request body too large'))
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
        reject(new Error('Invalid JSON body'))
      }
    })

    req.on('error', reject)
  })
}

function buildTaskResponse(task) {
  return {
    task_id: task.id,
    status: task.status,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    error: task.error || null,
    result: task.status === 'completed' ? task.result : null
  }
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
        id: item?.revised_prompt ? `image-${index + 1}` : `image-${index + 1}`,
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

async function runImageTask(task) {
  task.status = 'processing'
  task.updatedAt = nowIso()

  try {
    const response = await fetch(`${upstream}/v1/images/generations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${task.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(task.payload)
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
      throw new Error(parseUpstreamError(data, `Image request failed: HTTP ${response.status}`))
    }

    task.status = 'completed'
    task.result = normalizeImageResult(
      data,
      typeof task.payload.prompt === 'string' ? task.payload.prompt : '',
      typeof task.payload.size === 'string' ? task.payload.size : ''
    )
    task.updatedAt = nowIso()
  } catch (error) {
    task.status = 'failed'
    task.error = error instanceof Error ? error.message : 'Image task failed'
    task.updatedAt = nowIso()
  }
}

function createImageTask(body) {
  const apiKey = typeof body?.api_key === 'string' ? body.api_key.trim() : ''
  const payload = body?.payload && typeof body.payload === 'object' ? body.payload : null

  if (!apiKey) {
    throw new Error('api_key is required')
  }
  if (!payload) {
    throw new Error('payload is required')
  }
  if (typeof payload.prompt !== 'string' || !payload.prompt.trim()) {
    throw new Error('payload.prompt is required')
  }

  const id = randomUUID()
  const task = {
    id,
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

setInterval(cleanupTasks, 5 * 60 * 1000).unref()

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

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost')

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('ok\n')
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/playground/tasks') {
      const body = await parseJsonBody(req)
      const task = createImageTask(body)
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
      const taskId = url.pathname.split('/').pop()
      const task = taskId ? tasks.get(taskId) : null
      if (!task) {
        json(res, 404, {
          code: 404,
          message: 'Task not found'
        })
        return
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
      json(res, 404, {
        code: 404,
        message: 'Not found'
      })
      return
    }

    await serveStatic(req, res)
  } catch (error) {
    json(res, 500, {
      code: 500,
      message: error instanceof Error ? error.message : 'Internal server error'
    })
  }
})

server.listen(port, '0.0.0.0', () => {
  console.log(`image-playground server listening on http://0.0.0.0:${port}`)
})
