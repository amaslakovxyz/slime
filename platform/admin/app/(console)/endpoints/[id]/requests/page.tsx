import { LivePoller } from '@/app/ui/live-poller';
import { readLifecycle } from '@/lib/lifecycle';
import { loadEndpoint } from '../data';

// Every request that hit the endpoint, newest first. Same live feed the Lifecycle
// tab summarizes (GET /v0/events, the runtime's last 50), shown here as a plain
// log so the operator can watch the queue as calls land. Read-only; no actions.
const time = (iso: string) => new Date(iso).toLocaleTimeString('en-GB');

export default async function RequestsLogPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ep } = await loadEndpoint(id);
  const data = await readLifecycle(ep);

  return (
    <>
      <LivePoller />
      <section className="card">
        <div className="section-head">
          <h2 className="section-title">Requests log</h2>
          {data.ok && (
            <span className="muted small">
              {data.total} total{data.events.length < data.total ? ` · last ${data.events.length}` : ''}
            </span>
          )}
        </div>
        {!data.ok ? (
          <p className="muted small" role="status">{data.reason}</p>
        ) : data.events.length === 0 ? (
          <p className="lc-empty">No requests yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Handler</th>
                  <th>Stage</th>
                  <th>Cache</th>
                  <th className="num">Latency</th>
                </tr>
              </thead>
              <tbody>
                {data.events.map((e, i) => (
                  <tr key={`${e.at}-${i}`}>
                    <td className="mono">{time(e.at)}</td>
                    <td className="mono" title={e.handlerKey}>#{e.handlerKey.slice(0, 6)}</td>
                    <td><span className={`tier-pill tier-pill-${e.tier}`}>{e.tier}</span></td>
                    <td>{e.route === 'crystal' ? 'own route' : e.cache}</td>
                    <td className="num mono">{e.ms.toFixed(1)} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
