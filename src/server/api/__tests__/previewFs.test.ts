import { describe, expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { contentTypeForPath, handlePreviewFs } from '../previewFs'

describe('contentTypeForPath', () => {
  it('maps common web asset extensions', () => {
    expect(contentTypeForPath('/x/index.html')).toBe('text/html; charset=utf-8')
    expect(contentTypeForPath('/x/app.css')).toBe('text/css; charset=utf-8')
    expect(contentTypeForPath('/x/app.js')).toBe('text/javascript; charset=utf-8')
    expect(contentTypeForPath('/x/data.json')).toBe('application/json; charset=utf-8')
    expect(contentTypeForPath('/x/logo.svg')).toBe('image/svg+xml')
    expect(contentTypeForPath('/x/p.png')).toBe('image/png')
  })
  it('falls back to octet-stream for unknown', () => {
    expect(contentTypeForPath('/x/file.bin')).toBe('application/octet-stream')
  })
})

function setupWorkspace() {
  const root = mkdtempSync(path.join(tmpdir(), 'pfs-'))
  writeFileSync(path.join(root, 'index.html'), '<h1>ok</h1>')
  mkdirSync(path.join(root, 'assets'))
  writeFileSync(path.join(root, 'assets', 'a.css'), 'body{}')
  return root
}

describe('handlePreviewFs', () => {
  it('serves an in-workspace file with content-type', async () => {
    const root = setupWorkspace()
    const resolve = async (id: string) => (id === 's1' ? root : null)
    const res = await handlePreviewFs(new URL('http://127.0.0.1/preview-fs/s1/index.html'), resolve)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await res.text()).toBe('<h1>ok</h1>')
  })

  it('serves nested assets', async () => {
    const root = setupWorkspace()
    const resolve = async () => root
    const res = await handlePreviewFs(new URL('http://127.0.0.1/preview-fs/s1/assets/a.css'), resolve)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/css; charset=utf-8')
  })

  it('blocks path traversal with 403', async () => {
    const root = setupWorkspace()
    const resolve = async () => root
    const res = await handlePreviewFs(new URL('http://127.0.0.1/preview-fs/s1/../../etc/passwd'), resolve)
    expect(res.status).toBe(403)
  })

  it('404 when session has no workdir', async () => {
    const resolve = async () => null
    const res = await handlePreviewFs(new URL('http://127.0.0.1/preview-fs/sX/index.html'), resolve)
    expect(res.status).toBe(404)
  })
})
