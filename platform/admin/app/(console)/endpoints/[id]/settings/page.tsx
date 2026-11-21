import { deleteEndpointAction, updateSettingsAction } from '@/app/actions';
import { PROVIDER_INFO } from '@/app/ui/providers';
import { PROVIDERS } from '@/lib/endpoints';
import { loadEndpoint } from '../data';

export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { id } = await params;
  const { error, saved } = await searchParams;
  const { ep } = await loadEndpoint(id);
  const settled = ep.status === 'ready' || ep.status === 'failed';
  const renamable = ep.status !== 'deleting';

  return (
    <>
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      {saved && (
        <div className="alert alert-ok" role="status">
          {ep.status === 'updating' ? 'Saved. The endpoint is redeploying with the new provider.' : 'Saved.'}
        </div>
      )}

      <section className="card settings-card">
        <h2 className="card-title">General</h2>
        <form action={updateSettingsAction} className="form-stack">
          <input type="hidden" name="endpointId" value={ep.endpointId} />
          <label className="field">
            <span className="field-label">Name</span>
            <input name="name" maxLength={40} required defaultValue={ep.name} disabled={!renamable} />
            <span className="field-hint">Only shown here; the URL and ID never change.</span>
          </label>
          <label className="field">
            <span className="field-label">LLM provider</span>
            {/* A disabled select is not submitted, so the current value travels as a hidden field. */}
            {!settled && <input type="hidden" name="provider" value={ep.provider} />}
            <select name="provider" defaultValue={ep.provider} disabled={!settled}>
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_INFO[p].label} · {PROVIDER_INFO[p].blurb}
                </option>
              ))}
            </select>
            <span className="field-hint">
              {settled
                ? 'Changing the provider redeploys the endpoint (status updating).'
                : `The provider can change once the endpoint is ready or failed (now ${ep.status}).`}
            </span>
          </label>
          <div className="form-actions">
            <button className="btn" type="submit" disabled={!renamable}>
              Save changes
            </button>
          </div>
        </form>
      </section>

      <section className="section card danger-zone settings-card">
        <h2 className="card-title">Danger zone</h2>
        <div className="danger-row">
          <div>
            <strong>Delete this endpoint</strong>
            <p className="card-sub">
              Removes the function, its role, logs, secrets and Liquid handlers. Usage history stays for billing.
              {!settled && ` Available once the endpoint is ready or failed (now ${ep.status}).`}
            </p>
          </div>
          <form action={deleteEndpointAction}>
            <input type="hidden" name="endpointId" value={ep.endpointId} />
            <button className="btn-danger" type="submit" disabled={!settled}>
              Delete endpoint
            </button>
          </form>
        </div>
      </section>
    </>
  );
}
