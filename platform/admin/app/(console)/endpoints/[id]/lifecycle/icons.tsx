// Stroke icons for the lifecycle diagram, drawn like the sidebar's (24 px grid, currentColor).
// Decorative: every icon sits next to text, a tooltip or an aria-label that carries its meaning.
import type { ReactNode } from 'react';

const PATHS = {
  plug: <path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0V8ZM12 17v5" />,
  // Bubbles: three wavy lines read as a menu (≡) at 15 px.
  gas: <path d="M12 15a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM19 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM20 17.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z" />,
  liquid: <path d="M12 3c3.5 4.2 6 7.4 6 10.5a6 6 0 0 1-12 0C6 10.4 8.5 7.2 12 3Z" />,
  crystal: <path d="M6 3h12l3 6-9 12L3 9l3-6ZM3 9h18M12 21 8.5 9 12 3l3.5 6L12 21" />,
  repeat: <path d="m17 2 4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3" />,
  review: <path d="M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6l-8-3ZM9 12l2 2 4-4" />,
  auto: <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />,
  you: <path d="m9 9 5 12 1.8-5.2L21 14 9 9ZM7.2 2.2 8 5.1M5.1 8l-2.9-.8M14 4.1 12 6M6 12l-1.9 2" />,
  agent: <path d="M4 11a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-6ZM12 8V4M10 4h4M9 13v1M15 13v1" />,
  memory: <path d="M6 8a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8ZM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />,
  db: <path d="M4 5c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3ZM4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />,
  module: <path d="M21 8 12 3 3 8v8l9 5 9-5V8ZM3 8l9 5 9-5M12 13v8" />,
  coin: <path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM14.5 9.5C14 8.5 13 8 12 8c-1.4 0-2.5.8-2.5 2s1.1 1.6 2.5 2 2.5.8 2.5 2-1.1 2-2.5 2c-1 0-2-.5-2.5-1.5M12 6.5V8M12 16v1.5" />,
  lock: <path d="M5 13a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6ZM8 11V7a4 4 0 0 1 8 0v4" />,
  key: <path d="M12 15a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM11 12l9-9M17 6l3 3M14 9l2 2" />,
  layers: <path d="m12 3 9 5-9 5-9-5 9-5ZM3 13l9 5 9-5" />,
  activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  clock: <path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 7v5l3 2" />,
  check: <path d="m5 12 5 5 9-10" />,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  down: <path d="M12 5v14M6 13l6 6 6-6" />,
  chevron: <path d="m9 6 6 6-6 6" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg className="lc-ico" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}
