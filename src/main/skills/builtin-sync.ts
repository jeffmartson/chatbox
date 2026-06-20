import type { SkillInfo, SkillMetadata } from '@shared/types/skills'
import crypto from 'crypto'
import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { getLogger } from '../util'
import { builtinSkills } from './builtin'
import { parseSkillFile } from './parser'
import { isValidSkillName } from './validation'

const log = getLogger('skills:builtin-sync')

const MANIFEST_FILE = 'manifest.json'
const FETCH_TIMEOUT_MS = 10_000

interface SnapshotEntry {
  version: number
  hash: string
  updatedAt: number
  origin: 'seed' | 'remote'
}

interface SnapshotManifest {
  skills: Record<string, SnapshotEntry>
  syncedAt: number
}

interface RemoteManifestItem {
  name: string
  description: string
  version: number
  hash: string
  updated_at: number
}

interface RemoteSkillDetail {
  name: string
  description: string
  body: string
  version: number
  hash: string
  allowed_tools?: string[]
  metadata?: Record<string, string>
  license?: string
}

/** 内置 skill 快照目录，与用户自定义 skill 目录（userData/skills）隔离，避免被当作可删除的自定义 skill。 */
export function getBuiltinSkillsDir(): string {
  return path.join(app.getPath('userData'), 'builtin-skills')
}

function getManifestPath(): string {
  return path.join(getBuiltinSkillsDir(), MANIFEST_FILE)
}

/** 与后端一致的内容 hash：sha256(trim(body))。 */
function hashBody(body: string): string {
  return crypto.createHash('sha256').update(body.trim()).digest('hex')
}

function getApiOrigin(): string {
  if (process.env.USE_LOCAL_API) {
    return 'http://localhost:8002'
  }
  return 'https://api.chatboxai.app'
}

function readManifest(): SnapshotManifest {
  try {
    const raw = fs.readFileSync(getManifestPath(), 'utf-8')
    const parsed = JSON.parse(raw) as SnapshotManifest
    if (parsed && typeof parsed === 'object' && parsed.skills) {
      return { skills: parsed.skills, syncedAt: parsed.syncedAt ?? 0 }
    }
  } catch {
    // 首次或损坏，返回空 manifest
  }
  return { skills: {}, syncedAt: 0 }
}

function writeManifest(manifest: SnapshotManifest): void {
  fs.mkdirSync(getBuiltinSkillsDir(), { recursive: true })
  fs.writeFileSync(getManifestPath(), JSON.stringify(manifest, null, 2), 'utf-8')
}

/**
 * 序列化 frontmatter 为标准 YAML。标量值用 JSON.stringify（合法的 YAML 双引号字符串），
 * 数组/对象用标准缩进格式，保证能被 parser 的 gray-matter（js-yaml）正确解析回来。
 */
function serializeFrontmatter(fm: Record<string, unknown>): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(fm)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      lines.push(`${key}:`)
      for (const item of value) lines.push(`  - ${JSON.stringify(item)}`)
    } else if (typeof value === 'object') {
      lines.push(`${key}:`)
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        lines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
      }
    } else {
      lines.push(`${key}: ${JSON.stringify(value)}`)
    }
  }
  return lines.join('\n')
}

/** 将 skill 内容写入快照目录的 SKILL.md（frontmatter + body），与 parser 的解析格式一致。 */
function writeSnapshotSkill(name: string, metadata: SkillMetadata, body: string): void {
  const skillDir = path.join(getBuiltinSkillsDir(), name)
  fs.mkdirSync(skillDir, { recursive: true })

  const frontmatter: Record<string, unknown> = {
    name: metadata.name,
    description: metadata.description,
  }
  if (metadata.license) frontmatter.license = metadata.license
  if (metadata.compatibility) frontmatter.compatibility = metadata.compatibility
  if (metadata.metadata && Object.keys(metadata.metadata).length > 0) frontmatter.metadata = metadata.metadata
  if (metadata.allowedTools && metadata.allowedTools.length > 0) frontmatter.allowedTools = metadata.allowedTools

  const content = `---\n${serializeFrontmatter(frontmatter)}\n---\n\n${body.trim()}\n`
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf-8')
}

/**
 * 确保打包种子已落地到快照目录。
 * - 快照缺失该 skill：写入种子。
 * - 快照仍是种子来源（origin='seed'）但客户端升级带来了更新的种子（hash 变化）：用新种子覆盖。
 * - 快照已被远端覆盖（origin='remote'）：不动，远端版本（基于后端权威）优先。
 * 幂等，可重复调用。
 */
export function ensureBuiltinSeeded(): void {
  try {
    const manifest = readManifest()
    let changed = false
    for (const seed of builtinSkills) {
      const name = seed.metadata.name
      const seedHash = hashBody(seed.body)
      const entry = manifest.skills[name]
      const skillMdPath = path.join(getBuiltinSkillsDir(), name, 'SKILL.md')
      const needsWrite = !entry || !fs.existsSync(skillMdPath) || (entry.origin === 'seed' && entry.hash !== seedHash)
      if (needsWrite) {
        writeSnapshotSkill(name, seed.metadata, seed.body)
        manifest.skills[name] = { version: seed.version, hash: seedHash, updatedAt: Date.now(), origin: 'seed' }
        changed = true
      }
    }
    if (changed) writeManifest(manifest)
  } catch (error) {
    log.error('ensureBuiltinSeeded failed', error)
  }
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) {
      log.warn(`fetchJson non-ok status ${res.status} for ${url}`)
      return null
    }
    return (await res.json()) as T
  } catch (error) {
    log.warn(`fetchJson failed for ${url}`, error)
    return null
  } finally {
    clearTimeout(timer)
  }
}

function buildMetadataFromDetail(detail: RemoteSkillDetail): SkillMetadata {
  const metadata: SkillMetadata = {
    name: detail.name,
    description: detail.description,
  }
  if (detail.license) metadata.license = detail.license
  if (detail.metadata && Object.keys(detail.metadata).length > 0) metadata.metadata = detail.metadata
  if (Array.isArray(detail.allowed_tools) && detail.allowed_tools.length > 0) {
    metadata.allowedTools = detail.allowed_tools
  }
  return metadata
}

/**
 * 从后端拉取内置 skill manifest，按内容 hash 对比本地快照，差异项下载内容并覆盖本地快照。
 * 任何网络/解析失败都静默保留现有快照（绝不清空），保证内置 skill 永远可用。
 * @returns 是否有快照被更新
 */
export async function syncBuiltinSkills(lang?: string): Promise<boolean> {
  ensureBuiltinSeeded()

  const origin = getApiOrigin()
  const langQuery = lang ? `?lang=${encodeURIComponent(lang)}` : ''
  const manifestUrl = `${origin}/api/builtin_skills${langQuery}`

  log.info(`syncBuiltinSkills: fetching manifest from ${manifestUrl}`)
  const remote = await fetchJson<{ data: RemoteManifestItem[] }>(manifestUrl)
  if (!remote || !Array.isArray(remote.data)) {
    log.warn(`syncBuiltinSkills: no usable manifest from ${manifestUrl}, keeping local snapshot`)
    return false
  }

  const manifest = readManifest()
  let changed = false

  for (const item of remote.data) {
    if (!item?.name || typeof item.hash !== 'string') continue
    // 安全：name 会被用作快照目录路径，必须校验，防止后端异常/被篡改的 name（如 "../foo"）
    // 导致 writeSnapshotSkill 写到快照目录之外
    if (!isValidSkillName(item.name)) {
      log.warn(`syncBuiltinSkills: skipping invalid skill name "${item.name}"`)
      continue
    }
    const local = manifest.skills[item.name]
    if (local && local.hash === item.hash) continue // 内容未变，跳过

    const detailUrl = `${origin}/api/builtin_skills/${encodeURIComponent(item.name)}${langQuery}`
    const detailRes = await fetchJson<{ data: RemoteSkillDetail }>(detailUrl)
    const detail = detailRes?.data
    if (!detail || typeof detail.body !== 'string' || !detail.body.trim()) {
      log.warn(`syncBuiltinSkills: skipping "${item.name}", invalid detail`)
      continue
    }

    try {
      writeSnapshotSkill(item.name, buildMetadataFromDetail(detail), detail.body)
      manifest.skills[item.name] = {
        version: detail.version ?? item.version ?? 1,
        hash: hashBody(detail.body),
        updatedAt: Date.now(),
        origin: 'remote',
      }
      changed = true
      log.info(`syncBuiltinSkills: updated "${item.name}" from backend`)
    } catch (error) {
      log.error(`syncBuiltinSkills: failed to write "${item.name}"`, error)
    }
  }

  manifest.syncedAt = Date.now()
  writeManifest(manifest)
  log.info(`syncBuiltinSkills: done, remote=${remote.data.length} skill(s), changed=${changed}`)
  return changed
}

/** 从快照目录发现所有内置 skill（解析 SKILL.md），标记 isBuiltin。 */
export function discoverBuiltinSkills(): SkillInfo[] {
  ensureBuiltinSeeded()

  const dir = getBuiltinSkillsDir()
  const manifest = readManifest()
  const result: SkillInfo[] = []

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    log.error('discoverBuiltinSkills: failed to read snapshot dir', error)
    return result
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillMdPath = path.join(dir, entry.name, 'SKILL.md')
    if (!fs.existsSync(skillMdPath)) continue

    const parsed = parseSkillFile(skillMdPath, entry.name)
    if (!parsed) continue

    const meta = manifest.skills[entry.name]
    result.push({
      ...parsed.metadata,
      path: path.join(dir, entry.name),
      isBuiltin: true,
      source: {
        type: 'builtin',
        installedAt: meta ? new Date(meta.updatedAt).toISOString() : undefined,
      },
    })
  }

  return result
}
