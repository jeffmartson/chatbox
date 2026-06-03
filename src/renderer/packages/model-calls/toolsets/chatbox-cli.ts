import type { ChatboxAILicenseDetail } from '@shared/types/settings'
import { jsonSchema, type ToolSet } from 'ai'
import * as remote from '@/packages/remote'
import { settingsStore } from '@/stores/settingsStore'

function maskLicenseKey(key?: string): string | undefined {
  if (!key) return undefined
  return `configured (...${key.slice(-4)})`
}

function quotaSummary(detail?: ChatboxAILicenseDetail) {
  if (!detail) return undefined
  const expansionRemaining = Math.max((detail.expansion_pack_limit || 0) - (detail.expansion_pack_usage || 0), 0)
  const imageRemaining = Math.max((detail.image_total_quota || 0) - (detail.image_used_count || 0), 0)
  return {
    unifiedTokens: {
      remaining: detail.remaining_quota_unified,
      used: detail.unified_token_usage,
      total: detail.unified_token_limit,
      nextRefreshTime: detail.token_next_refresh_time,
      expireTime: detail.token_expire_time,
      details: detail.unified_token_usage_details,
    },
    expansionPack: {
      remaining: expansionRemaining,
      used: detail.expansion_pack_usage,
      total: detail.expansion_pack_limit,
    },
    image: {
      remaining: imageRemaining,
      used: detail.image_used_count,
      total: detail.image_total_quota,
      planLimit: detail.plan_image_limit,
    },
  }
}

function accountStatus() {
  const settings = settingsStore.getState()
  const detail = settings.licenseDetail
  return {
    signedIn: settings.licenseActivationMethod === 'login',
    licenseConfigured: Boolean(settings.licenseKey),
    licenseKey: maskLicenseKey(settings.licenseKey),
    activationMethod: settings.licenseActivationMethod ?? 'none',
    hasExpiredLicense: Boolean(settings.hasExpiredLicense),
    plan: detail
      ? {
          name: detail.name,
          status: detail.status,
          type: detail.type,
          defaultModel: detail.defaultModel,
          priceType: detail.price_type,
          orderType: detail.order_type,
          expiresAt: detail.expires_at,
        }
      : settings.licensePlanName
        ? { name: settings.licensePlanName }
        : undefined,
    quota: quotaSummary(detail),
  }
}

function help() {
  return {
    commands: [
      'help - show available commands',
      'status - show signed-in/license/plan summary',
      'license - show license and plan summary without exposing the raw key',
      'quota - show remaining token/image/expansion-pack quota from cached local data',
      'refresh - refresh license/quota details from Chatbox API, then show status',
    ],
    examples: ['chatbox account status', 'chatbox quota', 'chatbox license refresh'],
  }
}

function parseAction(command: string): 'help' | 'status' | 'license' | 'quota' | 'refresh' | 'unknown' {
  const normalized = command.trim().toLowerCase()
  if (!normalized || normalized === 'help' || normalized.includes('--help') || normalized.includes('-h')) return 'help'
  if (/\brefresh\b|\bsync\b|\breload\b/.test(normalized)) return 'refresh'
  if (/\bquota\b|\busage\b|\bremaining\b|\bcredits?\b/.test(normalized)) return 'quota'
  if (/\blicen[cs]e\b|\bplan\b|\bsubscription\b|\bbilling\b/.test(normalized)) return 'license'
  if (/\bstatus\b|\baccount\b|\bwhoami\b|\bprofile\b/.test(normalized)) return 'status'
  return 'unknown'
}

export function buildChatboxCliToolSet(options?: { onUsed?: () => void }) {
  const chatbox_cli: ToolSet[string] = {
    description:
      'Run a virtual Chatbox account CLI command. This is a controlled tool, not a real shell. ' +
      'Use it for Chatbox account, license, plan, quota, and billing status questions. ' +
      'Supported commands: help, status, license, quota, refresh.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description:
            'Virtual CLI command, e.g. "chatbox account status", "chatbox quota", or "chatbox license refresh"',
        },
      },
      required: ['command'],
      additionalProperties: false,
    }),
    execute: async (input) => {
      const cliInput = input as { command: string }
      options?.onUsed?.()
      const action = parseAction(cliInput.command)
      if (action === 'help') return help()
      if (action === 'unknown') {
        return {
          error: `Unsupported chatbox_cli command: ${cliInput.command}`,
          ...help(),
        }
      }

      if (action === 'refresh') {
        const licenseKey = settingsStore.getState().licenseKey
        if (!licenseKey) {
          return {
            error: 'No Chatbox license is configured.',
            status: accountStatus(),
          }
        }

        const response = await remote.getLicenseDetailRealtime({ licenseKey })
        if (response.data) {
          settingsStore.setState({
            licenseDetail: response.data,
            licensePlanName: response.data.name,
            hasExpiredLicense: response.error?.code === 'expired' || response.error?.code === 'expired_license',
          })
        }
        return {
          refreshed: Boolean(response.data),
          error: response.error,
          status: accountStatus(),
        }
      }

      const status = accountStatus()
      if (action === 'quota') return { quota: status.quota, licenseConfigured: status.licenseConfigured }
      if (action === 'license') {
        return {
          licenseConfigured: status.licenseConfigured,
          licenseKey: status.licenseKey,
          activationMethod: status.activationMethod,
          hasExpiredLicense: status.hasExpiredLicense,
          plan: status.plan,
        }
      }
      return status
    },
  }

  return {
    description: `
### Chatbox Account CLI
When answering Chatbox product, billing, license, plan, or quota questions, you can call \`chatbox_cli\`.
It accepts CLI-like commands but runs as a controlled app tool, not a real shell.
Use commands such as \`chatbox account status\`, \`chatbox quota\`, \`chatbox license\`, or \`chatbox license refresh\`.
The tool never returns the raw license key.
`,
    tools: { chatbox_cli },
  }
}
