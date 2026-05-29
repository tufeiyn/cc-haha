import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  isSameOrInsidePathForPlatform,
  normalizeDriveRootPathForPlatform,
} from '../services/windowsDrivePath.js'

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
}

export function contentTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase()
  return CONTENT_TYPES[ext] ?? 'application/octet-stream'
}

export type ResolveWorkDir = (sessionId: string) => Promise<string | null>

const PREFIX = '/preview-fs/'
const MAX_FILE_BYTES = 50 * 1024 * 1024

/**
 * Serve a single file from a session's sandboxed workspace directory.
 *
 * URL shape: `/preview-fs/<sessionId>/<relPath>` where `<relPath>` may itself
 * contain `/` separators. The WHATWG URL parser collapses `..` segments before
 * this handler runs, so a traversal attempt such as
 * `/preview-fs/s1/../../etc/passwd` arrives with its pathname normalized to
 * `/etc/passwd` — i.e. the `/preview-fs/` prefix is gone. We treat any request
 * that lost the prefix as a sandbox escape and return 403. Requests that keep
 * the prefix are additionally re-validated against the resolved work-dir root.
 */
export async function handlePreviewFs(
  url: URL,
  resolveWorkDir: ResolveWorkDir,
): Promise<Response> {
  if (!url.pathname.startsWith(PREFIX)) {
    return new Response('forbidden', { status: 403 })
  }

  const rest = url.pathname.slice(PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return new Response('bad request', { status: 400 })

  const sessionId = decodeURIComponent(rest.slice(0, slash))
  const relRaw = decodeURIComponent(rest.slice(slash + 1))

  const workDir = await resolveWorkDir(sessionId)
  if (!workDir) return new Response('no workdir', { status: 404 })

  const root = path.resolve(normalizeDriveRootPathForPlatform(workDir))
  const target = path.resolve(root, relRaw)
  if (!isSameOrInsidePathForPlatform(target, root)) {
    return new Response('forbidden', { status: 403 })
  }

  let stat: fs.Stats
  try {
    stat = fs.statSync(target)
  } catch {
    return new Response('not found', { status: 404 })
  }
  if (!stat.isFile()) return new Response('not a file', { status: 404 })
  if (stat.size > MAX_FILE_BYTES) return new Response('too large', { status: 413 })

  const data = fs.readFileSync(target)
  return new Response(data, {
    status: 200,
    headers: {
      'Content-Type': contentTypeForPath(target),
      'Content-Length': String(stat.size),
      'Cache-Control': 'no-cache',
    },
  })
}
