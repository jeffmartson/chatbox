import type { SkillMetadata } from '../../../shared/types/skills'

export const metadata: SkillMetadata = {
  name: 'chatbox-product-info',
  description:
    'Chatbox product and billing information specialist. Use when the conversation mentions Chatbox AI, Chatbox product features, subscriptions, pricing, paid plans, licenses, billing, authentication, developer docs, or MCP access.',
}

export const body = `
# Chatbox Product Information

Use this skill when the user asks about Chatbox AI product capabilities, subscriptions, paid plans, license management, billing, authentication, developer APIs, or MCP access.

## Source of truth

- Start from https://chatboxai.app/llms.txt for current machine-readable discovery links.
- For pricing, subscriptions, paid plans, usage limits, or billing, follow the "Machine-readable pricing" link from llms.txt, currently https://chatboxai.app/pricing.md.
- For product guides, follow the guide link from llms.txt.
- For developer, authentication, API, MCP, or integration questions, follow the relevant docs links from llms.txt.

## Tool use

- Use \`chatbox_cli\` for user-specific account, license, plan, and quota details. It is a controlled virtual CLI tool, not a shell.
- Useful commands: \`chatbox account status\`, \`chatbox license\`, \`chatbox quota\`, \`chatbox license refresh\`, and \`help\`.
- Use \`refresh\` when the user asks for current remaining quota or current license state.
- Prefer web/fetch tools for retrieving the current Chatbox documentation pages.
- If only code execution is available, use a short Node.js or Bash request to fetch the relevant Markdown/text URL. Do not install packages.
- Do not use user_exec for documentation lookup.
- Keep fetched excerpts small. Summarize the relevant facts and include the source URL.

## Answering rules

- Fetch the relevant source before answering when current product, pricing, plan, or access details matter.
- Do not rely on memory for prices, plan names, model availability, quotas, or billing policies.
- If the source cannot be fetched, say that the current source could not be accessed and avoid inventing details.
- Include the source URL used in the answer when giving product or billing facts.
- Answer in the user's language unless they ask otherwise.
`
