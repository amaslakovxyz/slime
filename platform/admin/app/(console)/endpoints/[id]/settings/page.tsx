import { deleteEndpointAction, updateConnectorAction, updateSettingsAction } from '@/app/actions';
import { formatDate } from '@/app/format';
import { ConfirmSubmit } from '@/app/ui/confirm-submit';
import { PROVIDER_INFO } from '@/app/ui/providers';
import { TestConnection } from '@/app/ui/test-connection';
import { CONNECTOR_SPECS, maskConnectionUrl } from '@/lib/connectors';
import { connectionUrl, PROVIDERS } from '@/lib/endpoints';
import { loadEndpoint } from '../data';

// Everything about the endpoint that is not its traffic: name and provider, the
// database connection, identifiers, and deletion.
export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { id } = await params;
  const { error, saved } = await searchParams;
  const { email, ep } = await loadEndpoint(id);
  const settled = ep.status === 'ready' || ep.status === 'failed';
  const renamable = ep.status !== 'deleting';
  const spec = CONNECTOR_SPECS[ep.connectorType];
  // Masked on the server: the password never reaches the browser.
  const stored = await connectionUrl(email, ep.endpointId);
  const masked = stored ? maskConnectionUrl(stored) : null;
  const connectionEditable = settled || ep.status === 'pending';

  return (
    <>
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      {saved && (
        <div className="alert alert-ok" role="status">
          {ep.status === 'updating' ? 'Saved. Restarting…' : 'Saved.'}
        </div>
      )}

      <section className="card settings-card">
        <h2 className="card-title">General</h2>
        <form action={updateSettingsAction} className="form-stack">
          <input type="hidden" name="endpointId" value={ep.endpointId} />
          <label className="field">
            <span className="field-label">Name</span>
            <input name="name" maxLength={40} required defaultValue={ep.name} disabled={!renamable} />
          </label>
          <label className="field">
            <span className="field-label">LLM provider</span>
            {/* A disabled select is not submitted, so the current value travels as a hidden field. */}
            {!settled && <input type="hidden" name="provider" value={ep.provider} />}
            <select name="provider" defaultValue={ep.provider} disabled={!settled}>
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_INFO[p].label}
                </option>
              ))}
            </select>
            <span className="field-hint">{settled ? 'Change restarts the endpoint.' : `Locked while ${ep.status}.`}</span>
          </label>
          <div className="form-actions">
            <button className="btn" type="submit" disabled={!renamable}>
              Save
            </button>
          </div>
        </form>
      </section>

      <section className="section card settings-card">
        <h2 className="card-title">{spec.label}</h2>
        {masked ? (
          <code className="masked-url">{masked.display}</code>
        ) : (
          <p className="muted">{stored ? 'The stored URL could not be parsed.' : 'No connection URL is stored.'}</p>
        )}
        <TestConnection endpointId={ep.endpointId} />
        <form action={updateConnectorAction} className="form-stack settings-replace">
          <input type="hidden" name="endpointId" value={ep.endpointId} />
          <input type="hidden" name="connectorType" value={ep.connectorType} />
          <label className="field">
            <span className="field-label">Replace URL</span>
            <input
              name="databaseUrl"
              type="password"
              autoComplete="off"
              spellCheck={false}
              required
              placeholder={spec.placeholder}
              disabled={!connectionEditable}
            />
            {!connectionEditable && <span className="field-hint">Locked while {ep.status}.</span>}
          </label>
          <div className="form-actions">
            <button className="btn-ghost" type="submit" disabled={!connectionEditable}>
              {settled ? 'Save and restart' : 'Save'}
            </button>
          </div>
        </form>
      </section>

      <section className="section card settings-card">
        <dl className="kv">
          <dt>Endpoint ID</dt>
          <dd className="mono">{ep.endpointId}</dd>
          <dt>Created</dt>
          <dd>{formatDate(ep.createdAt)}</dd>
          <dt>Updated</dt>
          <dd>{formatDate(ep.updatedAt)}</dd>
        </dl>
      </section>

      <section className="section card danger-zone settings-card">
        <div className="danger-row">
          <p className="card-sub">Delete the endpoint, its secrets and handlers.{!settled && ` Locked while ${ep.status}.`}</p>
          <form action={deleteEndpointAction}>
            <input type="hidden" name="endpointId" value={ep.endpointId} />
            <ConfirmSubmit
              className="btn-danger"
              disabled={!settled}
              message={`Delete "${ep.name}"? Its URL, token, secrets and handlers are removed; this cannot be undone.`}
            >
              Delete endpoint
            </ConfirmSubmit>
          </form>
        </div>
      </section>
    </>
  );
}
