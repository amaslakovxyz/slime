'use client';

import { startTransition, useActionState, useState, type FormEvent } from 'react';
import { createEndpointAction, type FormState } from '@/app/actions';
import { ConnectorLogo } from '@/app/ui/connector-logo';
import { PROVIDER_INFO } from '@/app/ui/providers';
import { TestConnection } from '@/app/ui/test-connection';
import { CONNECTOR_SPECS, CONNECTORS } from '@/lib/connectors';

// Submitted through onSubmit instead of <form action>: React resets a form
// after an action, which would wipe the fields whenever validation fails.
export function NewEndpointForm({ providers }: { providers: string[] }) {
  const [state, action, pending] = useActionState<FormState, FormData>(createEndpointAction, {});
  // Controlled only because Test connection needs the current value.
  const [url, setUrl] = useState('');
  const spec = CONNECTOR_SPECS.postgres;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    startTransition(() => action(form));
  };

  return (
    <div className="split">
      <form onSubmit={submit} className="card form-card">
        {state.error && (
          <div className="alert" role="alert">
            {state.error}
          </div>
        )}

        <fieldset className="step">
          <legend>
            <span className="step-num">1</span> Name and provider
          </legend>
          <label className="field">
            <span className="field-label">Name</span>
            <input name="name" maxLength={40} required placeholder="shop" />
          </label>
          <div className="field">
            <span className="field-label">LLM provider</span>
            <div className="choices choices-3">
              {providers.map((p) => (
                <label className="choice" key={p}>
                  <input type="radio" name="provider" value={p} defaultChecked={p === 'claude'} />
                  <span className="choice-name">{PROVIDER_INFO[p]?.label ?? p}</span>
                  <span className="choice-blurb">{PROVIDER_INFO[p]?.blurb}</span>
                </label>
              ))}
            </div>
          </div>
        </fieldset>

        <fieldset className="step">
          <legend>
            <span className="step-num">2</span> Connector
          </legend>
          <div className="choices">
            {CONNECTORS.map((c) => (
              <label className={`choice${c.available ? '' : ' is-disabled'}`} key={c.type}>
                <input
                  type="radio"
                  name="connectorType"
                  value={c.type}
                  disabled={!c.available}
                  defaultChecked={c.type === 'postgres'}
                />
                <span className="choice-top">
                  <ConnectorLogo type={c.type} />
                  {!c.available && <span className="tag">coming soon</span>}
                </span>
                <span className="choice-name">{c.label}</span>
                <span className="choice-blurb">{c.blurb}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="step">
          <legend>
            <span className="step-num">3</span> Connection
          </legend>
          <label className="field">
            <span className="field-label">{spec.field}</span>
            <input
              name="databaseUrl"
              type="password"
              autoComplete="off"
              spellCheck={false}
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={spec.placeholder}
            />
            <span className="field-hint">
              Use a read-only role. The URL is stored only in the secret store, never in the control table.
            </span>
          </label>
          <TestConnection url={url.trim()} />
        </fieldset>

        <div className="form-actions">
          <button className="btn" type="submit" disabled={pending}>
            {pending ? 'Creating…' : 'Create endpoint'}
          </button>
        </div>
      </form>

      <aside className="card aside-card">
        <h2 className="card-title">What happens next</h2>
        <ol className="steps-list">
          <li>
            <strong>pending</strong> Secrets go to the secret store, the endpoint record to slime-control.
          </li>
          <li>
            <strong>provisioning</strong> slime-provisioner creates a role, a function on the Gas layer and its URL.
          </li>
          <li>
            <strong>ready</strong> A health check against your database passes; the URL starts answering.
          </li>
        </ol>
        <p className="field-hint">
          Locally (DynamoDB Local) nothing provisions, so a new endpoint stays <span className="mono">pending</span>.
        </p>
      </aside>
    </div>
  );
}
