'use client';

import type { ReactNode } from 'react';

/** A submit button that asks first; cancelling stops the form's server action. */
export function ConfirmSubmit({
  message,
  className,
  disabled,
  children,
}: {
  message: string;
  className?: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      className={className}
      type="submit"
      disabled={disabled}
      onClick={(event) => {
        if (!window.confirm(message)) event.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
