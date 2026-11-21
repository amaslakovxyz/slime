// UI copy per provider; kept out of lib/endpoints so client components can use it.
export const PROVIDER_INFO: Record<string, { label: string; blurb: string }> = {
  claude: { label: 'Claude', blurb: 'Anthropic, best synthesis quality' },
  groq: { label: 'Groq', blurb: 'Fastest generation' },
  offline: { label: 'Offline', blurb: 'Prebuilt handlers only, no LLM calls' },
};
