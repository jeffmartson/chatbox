import type { SkillInfo, SkillSource } from '@shared/types/skills'
import fs from 'fs'
import path from 'path'
import { getLogger } from '../util'
import { parseSkillFile } from './parser'
import { normalizeClaudeSkillName } from './validation'

const log = getLogger('skills:discovery')

export function discoverSkills(skillsDir: string): SkillInfo[] {
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true })
    log.info(`Created skills directory: ${skillsDir}`)
  }

  const customSkills: SkillInfo[] = []

  try {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const skillMdPath = path.join(skillsDir, entry.name, 'SKILL.md')
      if (!fs.existsSync(skillMdPath)) continue

      const parsed = parseSkillFile(skillMdPath, entry.name)
      if (!parsed) continue

      let source: SkillSource | undefined
      const sourcePath = path.join(skillsDir, entry.name, 'source.json')
      try {
        if (fs.existsSync(sourcePath)) {
          source = JSON.parse(fs.readFileSync(sourcePath, 'utf-8')) as SkillSource
        }
      } catch {
        log.warn(`Failed to read source.json for skill "${entry.name}"`)
      }

      customSkills.push({
        ...parsed.metadata,
        path: path.join(skillsDir, entry.name),
        isBuiltin: false,
        source,
      })
    }
  } catch (error) {
    log.error(`Failed to scan skills directory: ${skillsDir}`, error)
  }

  const seenNames = new Set<string>()
  const deduplicatedSkills: SkillInfo[] = []
  for (const skill of customSkills) {
    if (seenNames.has(skill.name)) {
      log.warn(`Duplicate skill name "${skill.name}" found, keeping first occurrence`)
      continue
    }
    seenNames.add(skill.name)
    deduplicatedSkills.push(skill)
  }

  return deduplicatedSkills
}

/**
 * Discover skills from a Claude Code skills directory (~/.claude/skills/).
 * Follows symlinks, deduplicates by realpath, normalizes names to kebab-case.
 * @param claudeSkillsDir Path to the Claude Code skills directory
 * @param excludeNames Names already claimed by Chatbox skills (Chatbox wins collisions)
 */
export function discoverClaudeSkills(claudeSkillsDir: string, excludeNames: Set<string>): SkillInfo[] {
  if (!fs.existsSync(claudeSkillsDir)) {
    return []
  }

  const claudeSkills: SkillInfo[] = []
  const seenRealPaths = new Set<string>()

  try {
    const entries = fs.readdirSync(claudeSkillsDir, { withFileTypes: true })
    for (const entry of entries) {
      const entryPath = path.join(claudeSkillsDir, entry.name)

      // Use statSync to follow symlinks (entry.isDirectory() returns false for symlinks)
      let stat: fs.Stats
      try {
        stat = fs.statSync(entryPath)
      } catch {
        // Broken symlink or inaccessible — skip
        continue
      }
      if (!stat.isDirectory()) continue

      // Deduplicate by realpath (symlinked skills resolve to same target)
      let realPath: string
      try {
        realPath = fs.realpathSync(entryPath)
      } catch {
        continue
      }
      if (seenRealPaths.has(realPath)) continue
      seenRealPaths.add(realPath)

      const skillMdPath = path.join(entryPath, 'SKILL.md')
      if (!fs.existsSync(skillMdPath)) continue

      // Parse with relaxed validation — don't pass directoryName to avoid strict name matching
      const parsed = parseSkillFile(skillMdPath)
      if (!parsed) continue

      const normalizedName = normalizeClaudeSkillName(parsed.metadata.name, entry.name)
      if (!normalizedName) {
        log.warn(`Could not normalize Claude skill name for "${entry.name}", skipping`)
        continue
      }

      // Chatbox skills win name collisions
      if (excludeNames.has(normalizedName)) continue

      claudeSkills.push({
        ...parsed.metadata,
        name: normalizedName,
        path: entryPath,
        isBuiltin: false,
        source: { type: 'claude-code', skillPath: realPath },
      })
    }
  } catch (error) {
    log.error(`Failed to scan Claude skills directory: ${claudeSkillsDir}`, error)
  }

  // Deduplicate by normalized name (keep first occurrence)
  const seenNames = new Set<string>()
  const deduplicatedSkills: SkillInfo[] = []
  for (const skill of claudeSkills) {
    if (seenNames.has(skill.name)) continue
    seenNames.add(skill.name)
    deduplicatedSkills.push(skill)
  }

  return deduplicatedSkills
}
