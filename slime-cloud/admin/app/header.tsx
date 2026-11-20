import { logout } from '@/app/actions';

export function Header({ email }: { email: string }) {
  return (
    <header className="header">
      <a href="/" className="wordmark">
        slime cloud
      </a>
      <div className="header-user">
        <span>{email}</span>
        <form action={logout}>
          <button className="btn-ghost" type="submit">
            Log out
          </button>
        </form>
      </div>
    </header>
  );
}
