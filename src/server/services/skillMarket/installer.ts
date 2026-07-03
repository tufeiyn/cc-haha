import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { unzipFile } from '../../../utils/dxt/zip.js'
import { getClaudeConfigHomeDir } from '../../../utils/envUtils.js'
import type { SkillMarketInstallResult } from './types.js'

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,80}$/

type NormalizedEntries = Map<string, Uint8Array>

export async function installUserSkillFromZipBytes(input: {
  skillName: string
  zipBytes: Buffer
}): Promise<SkillMarketInstallResult> {
  validateSkillName(input.skillName)

  const userSkillsRoot = path.join(getClaudeConfigHomeDir(), 'skills')
  const targetPath = path.join(userSkillsRoot, input.skillName)
  ensurePathInside(path.resolve(userSkillsRoot), path.resolve(targetPath), 'Install target escapes user skills directory')

  if (await exists(targetPath)) {
    throw new Error(`Skill "${input.skillName}" already exists at ${targetPath}`)
  }

  const zipEntries = await unzipFile(input.zipBytes)
  const entries = normalizeSkillEntries(input.skillName, zipEntries)
  if (!entries.has('SKILL.md')) {
    throw new Error('Package does not contain SKILL.md')
  }

  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-skill-install-'))
  const stagingSkillDir = path.join(stagingRoot, input.skillName)
  let targetCreated = false

  try {
    await fs.mkdir(stagingSkillDir)
    await writeEntries(stagingSkillDir, entries)

    await fs.mkdir(userSkillsRoot, { recursive: true })
    await createTargetDirectory(targetPath, input.skillName)
    targetCreated = true
    await writeEntries(targetPath, entries)

    return { installed: true, skillName: input.skillName, targetPath }
  } catch (error) {
    if (targetCreated) {
      await fs.rm(targetPath, { recursive: true, force: true })
    }
    throw error
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true })
  }
}

function validateSkillName(skillName: string): void {
  if (!SKILL_NAME_PATTERN.test(skillName)) {
    throw new Error(`Invalid skill name: ${skillName}`)
  }
}

function normalizeSkillEntries(
  skillName: string,
  entries: Record<string, Uint8Array>,
): NormalizedEntries {
  const validatedEntries = Object.entries(entries)
    .map(([entryPath, bytes]) => ({
      path: normalizeArchiveEntryPath(entryPath),
      bytes,
    }))
    .filter((entry): entry is { path: string; bytes: Uint8Array } => entry.path !== null)

  const packageRoot = findPackageRoot(skillName, validatedEntries.map((entry) => entry.path))
  const normalized = new Map<string, Uint8Array>()

  for (const entry of validatedEntries) {
    const relativePath = packageRoot ? stripPackageRoot(entry.path, packageRoot) : entry.path
    validateRelativeInstallPath(relativePath)
    if (normalized.has(relativePath)) {
      throw new Error(`Duplicate file path detected: "${relativePath}"`)
    }
    normalized.set(relativePath, entry.bytes)
  }

  return normalized
}

function normalizeArchiveEntryPath(entryPath: string): string | null {
  if (!entryPath || entryPath.includes('\0')) {
    throw new Error(`Unsafe file path detected: "${entryPath}"`)
  }

  if (/^[a-zA-Z]:/.test(entryPath)) {
    throw new Error(`Unsafe file path detected: "${entryPath}"`)
  }

  const slashed = entryPath.replace(/\\/g, '/')
  if (path.posix.isAbsolute(slashed)) {
    throw new Error(`Unsafe file path detected: "${entryPath}"`)
  }

  const segments = slashed.split('/')
  if (segments.some((segment) => segment === '..')) {
    throw new Error(`Unsafe file path detected: "${entryPath}"`)
  }

  const normalized = path.posix.normalize(slashed)
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized === '..' || path.posix.isAbsolute(normalized)) {
    throw new Error(`Unsafe file path detected: "${entryPath}"`)
  }

  if (slashed.endsWith('/')) {
    return null
  }

  return normalized.replace(/^(\.\/)+/, '')
}

function findPackageRoot(skillName: string, paths: string[]): string | null {
  if (paths.includes('SKILL.md')) {
    return null
  }

  const topLevelNames = new Set(paths.map((entryPath) => entryPath.split('/')[0]!).filter(Boolean))
  if (topLevelNames.size !== 1) {
    return null
  }

  const [topLevelName] = topLevelNames
  if (!topLevelName) {
    return null
  }

  if (topLevelName === skillName || paths.includes(`${topLevelName}/SKILL.md`)) {
    return topLevelName
  }

  return null
}

function stripPackageRoot(entryPath: string, packageRoot: string): string {
  if (!entryPath.startsWith(`${packageRoot}/`)) {
    throw new Error(`Unsafe file path detected: "${entryPath}"`)
  }
  return entryPath.slice(packageRoot.length + 1)
}

function validateRelativeInstallPath(relativePath: string): void {
  if (!relativePath || relativePath.includes('\0') || /^[a-zA-Z]:/.test(relativePath)) {
    throw new Error(`Unsafe file path detected: "${relativePath}"`)
  }

  const normalized = path.posix.normalize(relativePath.replace(/\\/g, '/'))
  if (
    normalized !== relativePath
    || normalized === '.'
    || normalized.startsWith('../')
    || normalized === '..'
    || path.posix.isAbsolute(normalized)
  ) {
    throw new Error(`Unsafe file path detected: "${relativePath}"`)
  }
}

async function writeEntries(rootDir: string, entries: NormalizedEntries): Promise<void> {
  const resolvedRoot = path.resolve(rootDir)

  for (const [relativePath, bytes] of entries) {
    const destination = path.resolve(rootDir, relativePath)
    ensurePathInside(resolvedRoot, destination, `Unsafe destination path: ${relativePath}`)
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.writeFile(destination, bytes)
  }
}

function ensurePathInside(root: string, target: string, message: string): void {
  const relative = path.relative(root, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(message)
  }
}

async function createTargetDirectory(targetPath: string, skillName: string): Promise<void> {
  try {
    await fs.mkdir(targetPath)
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) {
      throw new Error(`Skill "${skillName}" already exists at ${targetPath}`)
    }
    throw error
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath)
    return true
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return false
    }
    throw error
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === code
}
