'use client';

import { useState } from 'react';

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button className="btn-ghost btn-sm" type="button" onClick={copy} aria-live="polite">
      {copied ? 'Copied' : label}
    </button>
  );
}
