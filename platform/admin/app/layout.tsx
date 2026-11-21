import type { ReactNode } from 'react';
import { JetBrains_Mono, Oi, Plus_Jakarta_Sans, Titan_One } from 'next/font/google';
import './globals.css';

// The brand book's four-font hierarchy: Oi for the wordmark, Titan One for
// titles, Plus Jakarta Sans for everything readable, JetBrains Mono for numbers.
const wordmark = Oi({ subsets: ['latin'], weight: '400', variable: '--font-wordmark' });
const display = Titan_One({ subsets: ['latin'], weight: '400', variable: '--font-display' });
const body = Plus_Jakarta_Sans({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-body' });
const mono = JetBrains_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-mono' });

export const metadata = { title: 'slime cloud' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${wordmark.variable} ${display.variable} ${body.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
