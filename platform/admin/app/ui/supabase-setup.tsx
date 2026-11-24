'use client';

import { useEffect, useState } from 'react';
import { CopyButton } from '@/app/ui/copy-button';
import { SUPABASE_READER_ROLE, supabaseReaderSql } from '@/lib/connectors';

/**
 * Create form, Supabase connector: the SQL for a read-only role, then where the
 * pooler URL is. The password is made here and never leaves the browser unless
 * the user pastes it back in the URL; hex keeps it URL-safe.
 */
export function SupabaseSetup() {
  // Generated after mount: a value from the server render would not match the client's.
  const [password, setPassword] = useState('');
  useEffect(() => {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    setPassword(Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''));
  }, []);
  const sql = supabaseReaderSql(password || '…');

  return (
    <div className="supabase-setup">
      <ol>
        <li>
          Create a read-only role: run this in the Supabase SQL Editor. Save the password; it is shown only here.
          <div className="lc-copy">
            <pre>{sql}</pre>
            <CopyButton value={sql} />
          </div>
        </li>
        <li>
          In the Supabase dashboard, open <strong>Connect</strong> and copy the <strong>Transaction pooler</strong> (or
          Session pooler) URL. Replace the user <code>postgres.&lt;ref&gt;</code> with{' '}
          <code>{SUPABASE_READER_ROLE}.&lt;ref&gt;</code> and <code>[YOUR-PASSWORD]</code> with the password above.
        </li>
      </ol>
    </div>
  );
}
