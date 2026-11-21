import { updateConnectorAction } from '@/app/actions';
import { ConnectorLogo } from '@/app/ui/connector-logo';
import { TestConnection } from '@/app/ui/test-connection';
import { CONNECTOR_SPECS, maskConnectionUrl } from '@/lib/connectors';
import { connectionUrl } from '@/lib/endpoints';
import { loadEndpoint } from '../data';

export default async function ConnectorPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { id } = await params;
  const { error, saved } = await searchParams;
  const { email, ep } = await loadEndpoint(id);
  const spec = CONNECTOR_SPECS[ep.connectorType];
  // Masked on the server: the password never reaches the browser.
  const stored = await connectionUrl(email, ep.endpointId);
  const masked = stored ? maskConnectionUrl(stored) : null;
  const redeploys = ep.status === 'ready' || ep.status === 'failed';
  const editable = redeploys || ep.status === 'pending';

  return (
    <>
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      {saved && (
        <div className="alert alert-ok" role="status">
          {redeploys || ep.status === 'updating'
            ? 'Saved. Restarting…'
            : 'Saved.'}
        </div>
      )}

      <div className="split">
        <section className="card">
          <div className="connector-head">
            <ConnectorLogo type={ep.connectorType} />
            <div>
              <h2 className="card-title">{spec.label}</h2>
            </div>
          </div>
          {masked ? (
            <>
              <code className="masked-url">{masked.display}</code>
            </>
          ) : (
            <p className="muted">{stored ? 'The stored URL could not be parsed.' : 'No connection URL is stored.'}</p>
          )}
          <TestConnection endpointId={ep.endpointId} />
        </section>

        <section className="card">
          <h2 className="card-title">Replace connection</h2>
          {!editable && <p className="card-sub">Locked while {ep.status}.</p>}
          <form action={updateConnectorAction} className="form-stack">
            <input type="hidden" name="endpointId" value={ep.endpointId} />
            <input type="hidden" name="connectorType" value={ep.connectorType} />
            <label className="field">
              <span className="field-label">{spec.field}</span>
              <input
                name="databaseUrl"
                type="password"
                autoComplete="off"
                spellCheck={false}
                required
                placeholder={spec.placeholder}
                disabled={!editable}
              />
            </label>
            <div className="form-actions">
              <button className="btn" type="submit" disabled={!editable}>
                {redeploys ? 'Save and restart' : 'Save'}
              </button>
            </div>
          </form>
        </section>
      </div>

    </>
  );
}
