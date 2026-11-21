import { updateConnectorAction } from '@/app/actions';
import { ConnectorLogo } from '@/app/ui/connector-logo';
import { TestConnection } from '@/app/ui/test-connection';
import { CONNECTOR_SPECS, CONNECTORS, maskConnectionUrl } from '@/lib/connectors';
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
            ? 'Connection saved. The endpoint is redeploying with it.'
            : 'Connection saved. The provisioner will use it when it picks the endpoint up.'}
        </div>
      )}

      <div className="split">
        <section className="card">
          <div className="connector-head">
            <ConnectorLogo type={ep.connectorType} />
            <div>
              <h2 className="card-title">{spec.label}</h2>
              <span className="muted small">Current connection</span>
            </div>
          </div>
          {masked ? (
            <>
              <code className="masked-url">{masked.display}</code>
              <dl className="kv">
                <dt>Scheme</dt>
                <dd className="mono">{masked.scheme}</dd>
                <dt>User</dt>
                <dd className="mono">{masked.user || '—'}</dd>
                <dt>Password</dt>
                <dd className="mono">****</dd>
                <dt>Host</dt>
                <dd className="mono">{masked.host}</dd>
                <dt>Port</dt>
                <dd className="mono">{masked.port}</dd>
                <dt>Database</dt>
                <dd className="mono">{masked.database || '—'}</dd>
              </dl>
            </>
          ) : (
            <p className="muted">{stored ? 'The stored URL could not be parsed.' : 'No connection URL is stored.'}</p>
          )}
          <TestConnection endpointId={ep.endpointId} />
        </section>

        <section className="card">
          <h2 className="card-title">Replace connection</h2>
          <p className="card-sub">
            {redeploys
              ? 'Saving moves the endpoint to updating: slime-provisioner redeploys it so fresh instances load the new secret.'
              : ep.status === 'pending'
                ? 'The endpoint has not been provisioned yet, so only the stored secret changes.'
                : `Not available while ${ep.status}.`}
            {editable && ' Locally (secret file, DynamoDB Local) saving just stores the secret.'}
          </p>
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
                {redeploys ? 'Save and redeploy' : 'Save connection'}
              </button>
            </div>
          </form>
        </section>
      </div>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Other systems</h2>
          <span className="muted small">One connector per endpoint</span>
        </div>
        <div className="choices">
          {CONNECTORS.filter((c) => c.type !== ep.connectorType).map((c) => (
            <div className={`choice${c.available ? '' : ' is-disabled'}`} key={c.type}>
              <span className="choice-top">
                <ConnectorLogo type={c.type} />
                {!c.available && <span className="tag">coming soon</span>}
              </span>
              <span className="choice-name">{c.label}</span>
              <span className="choice-blurb">{c.blurb}</span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
