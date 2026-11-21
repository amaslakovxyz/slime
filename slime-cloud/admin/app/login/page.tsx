import { redirect } from 'next/navigation';
import { login, signup } from '@/app/actions';
import { currentUser } from '@/lib/auth';

const ERRORS: Record<string, string> = {
  invalid: 'Wrong email or password',
  taken: 'Email already registered',
  weak: 'Password must be at least 8 characters',
  email: 'Enter a valid email address',
};

// One form, two submit buttons: Enter logs in, "Create account" posts the same
// fields to signup. Kept as an explicit choice instead of auto-creating an
// account on unknown email, so a typo in the email cannot open a new account.
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await currentUser()) redirect('/');
  const { error } = await searchParams;
  const message = error ? ERRORS[error] : undefined;
  return (
    <main className="shell">
      <header className="header">
        <span className="wordmark">slime cloud</span>
      </header>
      <form action={login} className="card stack login-card">
        <h2>Sign in</h2>
        {message && (
          <div className="alert" role="alert">
            {message}
          </div>
        )}
        <label>
          Email
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <div className="login-actions">
          <button className="btn" type="submit">
            Log in
          </button>
          <button className="btn-ghost" type="submit" formAction={signup}>
            Create account
          </button>
        </div>
        <p className="muted">New here? Enter an email and a password of 8+ characters, then Create account.</p>
      </form>
    </main>
  );
}
