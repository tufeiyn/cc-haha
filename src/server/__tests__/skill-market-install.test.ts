import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { zipSync } from 'fflate'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { installUserSkillFromZipBytes } from '../services/skillMarket/installer.js'

let tmpHome: string
let originalClaudeConfigDir: string | undefined

const encoder = new TextEncoder()

function zip(entries: Record<string, string>): Buffer {
  return Buffer.from(zipSync(Object.fromEntries(
    Object.entries(entries).map(([name, content]) => [name, encoder.encode(content)]),
  )))
}

function targetPath(skillName: string): string {
  return path.join(tmpHome, '.claude', 'skills', skillName)
}

describe('skill market user installer', () => {
  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-market-install-'))
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, '.claude')
  })

  afterEach(async () => {
    if (originalClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
    }
    await fs.rm(tmpHome, { recursive: true, force: true })
  })

  it('installs a complete skill directory into user skills', async () => {
    const result = await installUserSkillFromZipBytes({
      skillName: 'skill-vetter',
      zipBytes: zip({
        'skill-vetter/SKILL.md': '---\ndescription: Safe\n---\n# Skill',
        'skill-vetter/scripts/check.sh': 'echo ok',
        'skill-vetter/assets/icon.txt': 'icon',
      }),
    })

    expect(result).toEqual({
      installed: true,
      skillName: 'skill-vetter',
      targetPath: targetPath('skill-vetter'),
    })
    await expect(fs.readFile(path.join(targetPath('skill-vetter'), 'SKILL.md'), 'utf-8')).resolves.toContain('# Skill')
    await expect(fs.readFile(path.join(targetPath('skill-vetter'), 'scripts', 'check.sh'), 'utf-8')).resolves.toBe('echo ok')
    await expect(fs.readFile(path.join(targetPath('skill-vetter'), 'assets', 'icon.txt'), 'utf-8')).resolves.toBe('icon')
  })

  it('installs a root-level SKILL.md package structure', async () => {
    await installUserSkillFromZipBytes({
      skillName: 'root-skill',
      zipBytes: zip({
        'SKILL.md': '---\ndescription: Root\n---\n# Root Skill',
        'scripts/check.sh': 'echo root',
      }),
    })

    await expect(fs.readFile(path.join(targetPath('root-skill'), 'SKILL.md'), 'utf-8')).resolves.toContain('Root Skill')
    await expect(fs.readFile(path.join(targetPath('root-skill'), 'scripts', 'check.sh'), 'utf-8')).resolves.toBe('echo root')
  })

  it('rejects unsafe skill names', async () => {
    const unsafeNames = ['', '../escape', '/absolute', 'Skill', 'bad/name', 'bad\\name']

    for (const skillName of unsafeNames) {
      await expect(installUserSkillFromZipBytes({
        skillName,
        zipBytes: zip({ 'SKILL.md': 'bad' }),
      })).rejects.toThrow('Invalid skill name')
    }
  })

  it('rejects path traversal and absolute zip entries before writing the target', async () => {
    const cases = [
      { entry: '../bad-skill/SKILL.md', message: 'Unsafe file path' },
      { entry: '/bad-skill/SKILL.md', message: 'Unsafe file path' },
    ]

    for (const testCase of cases) {
      await expect(installUserSkillFromZipBytes({
        skillName: 'bad-skill',
        zipBytes: zip({ [testCase.entry]: 'bad' }),
      })).rejects.toThrow(testCase.message)
      await expect(fs.stat(targetPath('bad-skill'))).rejects.toThrow()
    }
  })

  it('rejects packages missing SKILL.md', async () => {
    await expect(installUserSkillFromZipBytes({
      skillName: 'missing-entry',
      zipBytes: zip({ 'missing-entry/scripts/check.sh': 'echo nope' }),
    })).rejects.toThrow('SKILL.md')

    await expect(fs.stat(targetPath('missing-entry'))).rejects.toThrow()
  })

  it('does not overwrite an existing non-empty skill directory', async () => {
    await fs.mkdir(targetPath('skill-vetter'), { recursive: true })
    await fs.writeFile(path.join(targetPath('skill-vetter'), 'SKILL.md'), 'existing', 'utf-8')

    await expect(installUserSkillFromZipBytes({
      skillName: 'skill-vetter',
      zipBytes: zip({ 'skill-vetter/SKILL.md': 'new' }),
    })).rejects.toThrow('already exists')

    await expect(fs.readFile(path.join(targetPath('skill-vetter'), 'SKILL.md'), 'utf-8')).resolves.toBe('existing')
  })

  it('does not overwrite an existing empty skill directory', async () => {
    await fs.mkdir(targetPath('empty-skill'), { recursive: true })

    await expect(installUserSkillFromZipBytes({
      skillName: 'empty-skill',
      zipBytes: zip({ 'empty-skill/SKILL.md': 'new' }),
    })).rejects.toThrow('already exists')

    await expect(fs.readdir(targetPath('empty-skill'))).resolves.toEqual([])
  })

  it('strips a single different top-level directory while preserving the requested skill name', async () => {
    await installUserSkillFromZipBytes({
      skillName: 'renamed-skill',
      zipBytes: zip({
        'upstream-name/SKILL.md': '---\ndescription: Renamed\n---\n# Renamed',
        'upstream-name/README.md': 'docs',
      }),
    })

    await expect(fs.readFile(path.join(targetPath('renamed-skill'), 'SKILL.md'), 'utf-8')).resolves.toContain('Renamed')
    await expect(fs.readFile(path.join(targetPath('renamed-skill'), 'README.md'), 'utf-8')).resolves.toBe('docs')
    await expect(fs.stat(path.join(targetPath('renamed-skill'), 'upstream-name'))).rejects.toThrow()
  })
})
