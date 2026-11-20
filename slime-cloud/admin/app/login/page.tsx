import { redirect } from 'next/navigation';
import { login, signup } from '@/app/actions';
import { currentUser } from '@/lib/auth';

const ERRORS: Record<string, string> = {
  invalid: 'Wrong email or password',
  taken: 'Email already registered',
  weak: 'Password must be at least 8 characters',
  email: 'Enter a valid email address',
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await currentUser()) redirect('/');
  const { error } = await searchParams;
  const message = error ? ERRORS[error] : undefined;
  return (
    <main className="shell">
      <header className="header">
        <span className="wordmark">slime cloud</span>
      </header>
      {message && (
        <div className="alert" role="alert" style={{ maxWidth: 760, margin: '0 auto' }}>
          {message}
        </div>
      )}
      <div className="login-grid">
        <form action={login} className="card stack">
          <h2>Log in</h2>
          <label>
            Email
            <input name="email" type="email" autoComplete="email" required />
          </label>
          <label>
            Password
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
          <button className="btn" type="submit">
            Log in
          </button>
        </form>
        <form action={signup} className="card stack">
          <h2>Create account</h2>
          <label>
            Email
            <input name="email" type="email" autoComplete="email" required />
          </label>
          <label>
            Password
            <input name="password" type="password" autoComplete="new-password" minLength={8} required />
          </label>
          <button className="btn" type="submit">
            Create account
          </button>
        </form>
      </div>
    </main>
  );
}
