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
    <main className="auth">
      <div className="goo goo-a" aria-hidden="true" />
      <div className="goo goo-b" aria-hidden="true" />
      <form action={login} className="auth-card form-stack">
        <div className="auth-brand">
          <span className="wordmark wordmark-xl">slime</span>
          <span className="brand-sub">cloud</span>
        </div>
        <p className="auth-tagline">Feed the Slime. Endpoints that crystallize.</p>
        {message && (
          <div className="alert" role="alert">
            {message}
          </div>
        )}
        <label className="field">
          <span className="field-label">Email</span>
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label className="field">
          <span className="field-label">Password</span>
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <div className="auth-actions">
          <button className="btn" type="submit">
            Log in
          </button>
          <button className="btn-ghost" type="submit" formAction={signup}>
            Create account
          </button>
        </div>
        <p className="field-hint auth-hint">Password: 8+ characters.</p>
      </form>
    </main>
  );
}
