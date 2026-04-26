import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')
const dataRoot = path.resolve(process.env.PLAYGROUND_DATA_DIR || path.join(repoRoot, 'data', 'playground'))
const conversationsRoot = path.join(dataRoot, 'conversations')

function printHelp() {
  console.log(`
Usage:
  npm run backfill:library -- [options]

Options:
  --dry-run                 Scan snapshots and print what would be upserted.
  --user-id=N               Only process one user's conversation snapshots.
  --conversation-id=UUID    Only process one conversation snapshot.
  --limit=N                 Only process the first N conversation snapshots after filtering.
  --help                    Show this help message.

Required environment variables:
  DATABASE_URL

Optional environment variables:
  PLAYGROUND_DATA_DIR       Default: ./data/playground

Examples:
  npm run backfill:library -- --dry-run
  npm run backfill:library -- --user-id=7
  npm run backfill:library -- --conversation-id=26d4a5c4-2cab-434a-9a86-e5c6ae741c47
`.trim())
}

function parseArgs(argv) {
  const options = {
    conversationId: '',
    dryRun: false,
    help: false,
    limit: null,
    userId: null
  }

  for (const arg of argv) {
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    if (arg.startsWith('--user-id=')) {
      const value = Number.parseInt(arg.slice('--user-id='.length), 10)
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`Invalid --user-id value: ${arg}`)
      }
      options.userId = value
      continue
    }
    if (arg.startsWith('--conversation-id=')) {
      const value = arg.slice('--conversation-id='.length).trim()
      if (!value) {
        throw new Error(`Invalid --conversation-id value: ${arg}`)
      }
      options.conversationId = value
      continue
    }
    if (arg.startsWith('--limit=')) {
      const value = Number.parseInt(arg.slice('--limit='.length), 10)
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`Invalid --limit value: ${arg}`)
      }
      options.limit = value
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  return options
}

function requireEnv(name) {
  const value = String(process.env[name] || '').trim()
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

function normalizePrompt(value) {
  const prompt = typeof value === 'string' ? value.trim() : ''
  return prompt || 'Untitled prompt'
}

function normalizeSize(value) {
  const size = typeof value === 'string' ? value.trim() : ''
  return size || 'unknown'
}

function parseCreatedAt(value) {
  const timestamp = Number(value)
  if (Number.isFinite(timestamp) && timestamp > 0) {
    return new Date(timestamp).toISOString()
  }
  return new Date().toISOString()
}

async function listConversationFiles(options) {
  if (!existsSync(conversationsRoot)) {
    throw new Error(`Conversations directory does not exist: ${conversationsRoot}`)
  }

  const userDirs = await readdir(conversationsRoot, { withFileTypes: true })
  const files = []

  for (const entry of userDirs) {
    if (!entry.isDirectory()) {
      continue
    }
    const userId = Number.parseInt(entry.name, 10)
    if (!Number.isInteger(userId) || userId <= 0) {
      continue
    }
    if (options.userId != null && userId !== options.userId) {
      continue
    }

    const userRoot = path.join(conversationsRoot, entry.name)
    const conversationEntries = await readdir(userRoot, { withFileTypes: true })
    for (const conversationEntry of conversationEntries) {
      if (!conversationEntry.isFile() || !conversationEntry.name.endsWith('.json')) {
        continue
      }
      const conversationId = conversationEntry.name.slice(0, -'.json'.length)
      if (options.conversationId && conversationId !== options.conversationId) {
        continue
      }
      files.push({
        userId,
        conversationId,
        filePath: path.join(userRoot, conversationEntry.name)
      })
    }
  }

  files.sort((left, right) => left.filePath.localeCompare(right.filePath))
  return options.limit == null ? files : files.slice(0, options.limit)
}

async function extractConversationImages(file) {
  const raw = await readFile(file.filePath, 'utf8')
  const snapshot = JSON.parse(raw)
  const generatedImages = Array.isArray(snapshot?.generatedImages) ? snapshot.generatedImages : []
  const images = []

  for (const image of generatedImages) {
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

    images.push({
      userId: file.userId,
      conversationId: file.conversationId,
      sourceImageId,
      assetToken,
      remoteUrl,
      prompt: normalizePrompt(image?.prompt),
      size: normalizeSize(image?.size),
      createdAt: parseCreatedAt(image?.createdAt)
    })
  }

  return images
}

async function ensureLibraryTable(pool) {
  await pool.query(`
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

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_playground_library_source
    ON playground_library_items (user_id, source_conversation_id, source_image_id)
  `)
}

async function upsertLibraryItem(pool, item) {
  const result = await pool.query(
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
       size = EXCLUDED.size
     RETURNING xmax = 0 AS inserted`,
    [
      randomUUID(),
      item.userId,
      item.assetToken,
      item.remoteUrl,
      item.prompt,
      item.size,
      item.conversationId,
      item.sourceImageId,
      item.createdAt
    ]
  )

  return Boolean(result.rows[0]?.inserted)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }

  const files = await listConversationFiles(options)
  const summary = {
    scannedConversations: files.length,
    scannedImages: 0,
    inserted: 0,
    updated: 0,
    invalidSnapshots: 0
  }

  let pool = null
  if (!options.dryRun) {
    pool = new Pool({
      connectionString: requireEnv('DATABASE_URL')
    })
    await ensureLibraryTable(pool)
  }

  try {
    for (const file of files) {
      let images = []
      try {
        images = await extractConversationImages(file)
      } catch (error) {
        summary.invalidSnapshots += 1
        console.warn(`Skipping invalid snapshot: ${file.filePath}`)
        console.warn(error instanceof Error ? error.message : String(error))
        continue
      }

      summary.scannedImages += images.length
      for (const image of images) {
        if (options.dryRun) {
          console.log(`[dry-run] ${image.userId}/${image.conversationId} -> ${image.sourceImageId}`)
          continue
        }

        const inserted = await upsertLibraryItem(pool, image)
        if (inserted) {
          summary.inserted += 1
        } else {
          summary.updated += 1
        }
      }
    }
  } finally {
    await pool?.end()
  }

  console.log('')
  console.log('Library backfill summary')
  console.log(`Conversations scanned: ${summary.scannedConversations}`)
  console.log(`Images discovered: ${summary.scannedImages}`)
  console.log(`Inserted: ${summary.inserted}`)
  console.log(`Updated: ${summary.updated}`)
  console.log(`Invalid snapshots: ${summary.invalidSnapshots}`)
  if (options.dryRun) {
    console.log('Mode: dry-run')
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
