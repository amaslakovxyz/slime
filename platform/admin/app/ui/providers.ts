// UI copy per provider; kept out of lib/endpoints so client components can use it.
export const PROVIDER_INFO: Record<string, { label: string; blurb: string }> = {
  claude: { label: 'Claude', blurb: 'Best quality' },
  groq: { label: 'Groq', blurb: 'Fastest' },
  offline: { label: 'Offline', blurb: 'Demo, no LLM' },
};
