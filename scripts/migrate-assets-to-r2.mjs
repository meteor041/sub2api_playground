import { createReadStream, existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { Pool } from 'pg'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')
const dataRoot = path.resolve(process.env.PLAYGROUND_DATA_DIR || path.join(repoRoot, 'data', 'playground'))
const assetsRoot = path.join(dataRoot, 'assets')
const imageCdnBase = String(process.env.PLAYGROUND_IMAGE_CDN_BASE || '').trim().replace(/\/$/, '')

function printHelp() {
  console.log(`
Usage:
  npm run migrate:r2 -- [options]

Options:
  --dry-run           Show what would be uploaded without writing to R2.
  --force             Re-upload even if the object already exists in R2.
  --limit=N           Only process the first N assets after filtering.
  --user-id=N         Only migrate assets owned by one user.
  --concurrency=N     Upload concurrency. Default: 4.
  --help              Show this help message.

Required environment variables:
  DATABASE_URL
  R2_ENDPOINT
  R2_BUCKET
  R2_ACCESS_KEY_ID
  R2_SECRET_ACCESS_KEY

Optional environment variables:
  R2_REGION           Default: auto
  PLAYGROUND_DATA_DIR Default: ./data/playground
  PLAYGROUND_IMAGE_CDN_BASE  Used to derive the R2 object key prefix.

Examples:
  npm run migrate:r2 -- --dry-run
  npm run migrate:r2 -- --limit=100 --concurrency=8
  npm run migrate:r2 -- --user-id=42
`.trim())
}

function parseArgs(argv) {
  const options = {
    concurrency: 4,
    dryRun: false,
    force: false,
    help: false,
    limit: null,
    userId: null
  }

  for (const arg of argv) {
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (arg === '--force') {
      options.force = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true
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
    if (arg.startsWith('--user-id=')) {
      const value = Number.parseInt(arg.slice('--user-id='.length), 10)
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`Invalid --user-id value: ${arg}`)
      }
      options.userId = value
      continue
    }
    if (arg.startsWith('--concurrency=')) {
      const value = Number.parseInt(arg.slice('--concurrency='.length), 10)
      if (!Number.isInteger(value) || value <= 0 || value > 32) {
        throw new Error(`Invalid --concurrency value: ${arg}`)
      }
      options.concurrency = value
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

function isNotFoundError(error) {
  const status = Number(error?.$metadata?.httpStatusCode || 0)
  return status === 404 ||
    error?.name === 'NotFound' ||
    error?.name === 'NoSuchKey' ||
    error?.Code === 'NotFound' ||
    error?.Code === 'NoSuchKey'
}

function createR2Client() {
  return new S3Client({
    region: String(process.env.R2_REGION || 'auto').trim() || 'auto',
    endpoint: requireEnv('R2_ENDPOINT').replace(/\/$/, ''),
    credentials: {
      accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY')
    }
  })
}

function assetObjectKey(token) {
  const key = String(token || '').trim().replace(/^\/+/, '')
  if (!key) {
    return ''
  }
  if (!imageCdnBase) {
    return key
  }
  try {
    const pathname = new URL(imageCdnBase).pathname.replace(/^\/+|\/+$/g, '')
    return pathname ? `${pathname}/${key}` : key
  } catch {
    return key
  }
}

async function listAssets(pool, options) {
  const clauses = []
  const values = []

  if (options.userId != null) {
    values.push(options.userId)
    clauses.push(`user_id = $${values.length}`)
  }

  let sql = `
    SELECT id, user_id, kind, file_path, mime_type, size_bytes, sha256, public_token, created_at
    FROM playground_assets
  `
  if (clauses.length > 0) {
    sql += ` WHERE ${clauses.join(' AND ')}`
  }
  sql += ' ORDER BY created_at ASC'
  if (options.limit != null) {
    values.push(options.limit)
    sql += ` LIMIT $${values.length}`
  }

  const result = await pool.query(sql, values)
  return result.rows
}

async function objectExists(client, bucket, key) {
  try {
    await client.send(new HeadObjectCommand({
      Bucket: bucket,
      Key: key
    }))
    return true
  } catch (error) {
    if (isNotFoundError(error)) {
      return false
    }
    throw error
  }
}

async function uploadAsset(client, bucket, asset, filePath) {
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: assetObjectKey(asset.public_token),
    Body: createReadStream(filePath),
    ContentType: asset.mime_type,
    CacheControl: 'public, max-age=31536000, immutable'
  }))
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length)
  let nextIndex = 0

  async function runWorker() {
    while (true) {
      const currentIndex = nextIndex
      nextIndex += 1
      if (currentIndex >= items.length) {
        return
      }
      results[currentIndex] = await worker(items[currentIndex], currentIndex)
    }
  }

  const runners = Array.from({ length: Math.min(concurrency, items.length || 1) }, () => runWorker())
  await Promise.all(runners)
  return results
}

async function migrateAsset(client, bucket, asset, options) {
  const key = assetObjectKey(asset.public_token)
  if (!options.force) {
    const exists = await objectExists(client, bucket, key)
    if (exists) {
      return {
        key,
        status: 'skipped-existing'
      }
    }
  }

  const filePath = path.join(assetsRoot, asset.file_path)
  if (!existsSync(filePath)) {
    return {
      key,
      status: 'missing-local',
      reason: filePath
    }
  }

  const fileStat = await stat(filePath)
  if (!fileStat.isFile()) {
    return {
      key,
      status: 'missing-local',
      reason: `${filePath} is not a file`
    }
  }

  if (options.dryRun) {
    return {
      key,
      status: 'dry-run',
      bytes: fileStat.size
    }
  }

  await uploadAsset(client, bucket, asset, filePath)
  return {
    key,
    status: 'uploaded',
    bytes: fileStat.size
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }

  const databaseUrl = requireEnv('DATABASE_URL')
  const bucket = requireEnv('R2_BUCKET')
  const client = createR2Client()
  const pool = new Pool({ connectionString: databaseUrl })

  try {
    const assets = await listAssets(pool, options)
    console.log(`Found ${assets.length} asset(s) to inspect.`)
    console.log(`Data root: ${dataRoot}`)
    console.log(`Assets root: ${assetsRoot}`)
    console.log(`R2 bucket: ${bucket}`)
    console.log(`R2 key prefix: ${assetObjectKey('example').replace(/\/example$/, '') || '(none)'}`)
    if (options.dryRun) {
      console.log('Mode: dry-run')
    }
    if (options.force) {
      console.log('Mode: force overwrite')
    }

    const summary = {
      dryRun: 0,
      failed: 0,
      missingLocal: 0,
      skippedExisting: 0,
      uploaded: 0
    }

    const results = await mapWithConcurrency(assets, options.concurrency, async (asset, index) => {
      try {
        const result = await migrateAsset(client, bucket, asset, options)
        const prefix = `[${index + 1}/${assets.length}]`
        if (result.status === 'uploaded') {
          console.log(`${prefix} uploaded ${result.key} (${result.bytes} bytes)`)
        } else if (result.status === 'dry-run') {
          console.log(`${prefix} would upload ${result.key} (${result.bytes} bytes)`)
        } else if (result.status === 'skipped-existing') {
          console.log(`${prefix} skipped existing ${result.key}`)
        } else {
          console.warn(`${prefix} missing local asset ${result.key}: ${result.reason}`)
        }
        return result
      } catch (error) {
        return {
          key: String(asset.public_token),
          status: 'failed',
          reason: error instanceof Error ? error.message : String(error)
        }
      }
    })

    for (const result of results) {
      if (result.status === 'uploaded') {
        summary.uploaded += 1
      } else if (result.status === 'dry-run') {
        summary.dryRun += 1
      } else if (result.status === 'skipped-existing') {
        summary.skippedExisting += 1
      } else if (result.status === 'missing-local') {
        summary.missingLocal += 1
      } else {
        summary.failed += 1
        console.error(`Failed to migrate ${result.key}: ${result.reason}`)
      }
    }

    console.log('\nSummary:')
    console.log(`  uploaded: ${summary.uploaded}`)
    console.log(`  skipped-existing: ${summary.skippedExisting}`)
    console.log(`  dry-run: ${summary.dryRun}`)
    console.log(`  missing-local: ${summary.missingLocal}`)
    console.log(`  failed: ${summary.failed}`)

    if (summary.failed > 0 || summary.missingLocal > 0) {
      process.exitCode = 1
    }
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
