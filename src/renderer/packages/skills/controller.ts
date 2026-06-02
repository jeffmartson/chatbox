import type { MarketplaceSkill, SkillInfo, SkillMetadata } from '@shared/types/skills'

interface SkillScriptResult {
  success: boolean
  stdout: string
  stderr: string
  exitCode: number | null
}

interface SkillInstallResult {
  success: boolean
  skillName: string
  error?: string
}

interface SkillUpdateResult {
  hasUpdate: boolean
  currentHash?: string
  latestHash?: string
  error?: string
}

const skillsChangeListeners = new Set<() => void>()

export function notifySkillsChanged(): void {
  for (const listener of skillsChangeListeners) {
    listener()
  }
}

export function subscribeSkillsChanged(listener: () => void): () => void {
  skillsChangeListeners.add(listener)
  return () => {
    skillsChangeListeners.delete(listener)
  }
}

export const skillsController = {
  discoverSkills(): Promise<SkillInfo[]> {
    return window.electronAPI.invoke('skills:discover')
  },

  loadSkill(name: string): Promise<{ metadata: SkillMetadata; body: string } | null> {
    return window.electronAPI.invoke('skills:load', name)
  },

  getSkillsDirectory(): Promise<string> {
    return window.electronAPI.invoke('skills:get-directory')
  },

  async openSkillsDirectory(): Promise<void> {
    await window.electronAPI.invoke('skills:open-directory')
  },

  executeScript(skillName: string, scriptName: string, args?: string[]): Promise<SkillScriptResult> {
    return window.electronAPI.invoke('skills:execute-script', { skillName, scriptName, args })
  },

  async installSkill(owner: string, repo: string, skillPath: string): Promise<SkillInstallResult> {
    const result = await window.electronAPI.invoke('skills:install', { owner, repo, skillPath })
    if (result.success) notifySkillsChanged()
    return result
  },

  async installFromSandbox(sandboxPath: string, sessionId?: string, sourceInfo?: string): Promise<SkillInstallResult> {
    const result = await window.electronAPI.invoke('skills:install-from-sandbox', {
      sandboxPath,
      sessionId,
      sourceInfo,
    })
    if (result.success) notifySkillsChanged()
    return result
  },

  userExec(command: string, timeout?: number): Promise<SkillScriptResult> {
    return window.electronAPI.invoke('skills:user-exec', { command, timeout })
  },

  async installMarketplaceSkill(skill: MarketplaceSkill): Promise<SkillInstallResult> {
    const result = await window.electronAPI.invoke('skills:install-marketplace', skill)
    if (result.success) notifySkillsChanged()
    return result
  },

  async deleteSkill(name: string): Promise<{ success: boolean; error?: string }> {
    const result = await window.electronAPI.invoke('skills:delete', name)
    if (result.success) notifySkillsChanged()
    return result
  },

  scanRepo(owner: string, repo: string): Promise<Array<{ name: string; path: string; description?: string }>> {
    return window.electronAPI.invoke('skills:scan-repo', owner, repo)
  },

  checkForUpdate(name: string): Promise<SkillUpdateResult> {
    return window.electronAPI.invoke('skills:check-update', name)
  },

  checkForUpdatesBatch(): Promise<Record<string, { hasUpdate: boolean; error?: string }>> {
    return window.electronAPI.invoke('skills:check-updates-batch')
  },
}
