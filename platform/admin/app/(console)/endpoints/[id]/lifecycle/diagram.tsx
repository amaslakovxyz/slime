'use client';

// The lifecycle diagram: Connected -> Gas -> Liquid -> Crystal as a vertical flow
// of stages and the arrows between them, with a side panel that explains whatever
// is selected (what the stage is, where its code lives, what moves a handler on)
// and lists the handlers in it now. Until the operator picks something the panel
// follows the current stage, so a live poll that moves the endpoint on moves it too.
import { useState } from 'react';
// Types only: lib/lifecycle also holds server reads (the secret store), which must stay out of the client bundle.
import type { HandlerRow, Stage, StageId, Tier, TierStats, Transition } from '@/lib/lifecycle';

type Selection = { kind: 'stage'; id: StageId } | { kind: 'edge'; id: Transition['id'] };

/** Verified against core/src/config/defaults.ts and docs/product/atlas-demo-cheatsheet.md (2026-11-22). */
const STAGE_COPY: Record<StageId, { summary: string; lives: (cloud: boolean) => string; tokens: string }> = {
  connected: {
    summary: 'The endpoint runs on your database with a read-only role, behind its URL and slm_ key. It answers whatever your agent asks.',
    lives: (cloud) => (cloud ? 'Settings in SSM; the shared runtime Lambda serves it' : 'Settings in the secret store; one local runtime process serves it'),
    tokens: 'None until a request arrives',
  },
  gas: {
    summary: 'A new request: the model wrote a handler for it and the handler already answers. Repeats run the cached code. Not reviewed yet.',
    lives: (cloud) => (cloud ? 'Memory of one runtime instance; gone when the window ends' : 'Memory of the runtime process; a restart drops it'),
    tokens: 'Once, to write the handler',
  },
  liquid: {
    summary: 'Reviewed and saved. Every call with the same intent, input names and output shape runs it, whatever the input values.',
    lives: () => 'The saved-handlers table; survives restarts',
    tokens: 'None per call',
  },
  crystal: {
    summary: 'Its own endpoint: its own URL and an slc_ token that opens only this route. No model is ever involved again.',
    lives: (cloud) => (cloud ? 'A checked module in S3' : 'A checked module in the endpoint’s data folder'),
    tokens: 'None',
  },
};

const ACTOR: Record<Transition['actor'], string> = { agent: 'your agent', automatic: 'automatic', operator: 'you' };
const LIST_LIMIT = 5;

const isTier = (id: StageId): id is Tier => id !== 'connected';
const ms = (n: number | null) => (n === null ? '—' : `${n.toFixed(1)} ms`);

function defaultSelection(stages: Stage[]): Selection {
  const now = stages.find((s) => s.state === 'now');
  return { kind: 'stage', id: (now ?? stages[stages.length - 1]!).id };
}

export function LifecycleDiagram({
  stages,
  transitions,
  rows,
  stats,
  recent,
  total,
  firstAt,
  status,
  cloud,
}: {
  stages: Stage[];
  transitions: Transition[];
  rows: HandlerRow[];
  /** Per tier, over the recent feed (`recent` requests). */
  stats: Record<Tier, TierStats>;
  recent: number;
  total: number;
  firstAt?: string;
  status: string;
  cloud: boolean;
}) {
  const [picked, setPicked] = useState<Selection | null>(null);
  const selected = picked ?? defaultSelection(stages);
  const isOn = (s: Selection) => s.kind === selected.kind && s.id === selected.id;
  const pick = (s: Selection) => setPicked(s);

  return (
    <section className="card lc-card lc-life" aria-labelledby="lc-life-h">
      <div className="lc-life-head">
        <h2 className="lc-h" id="lc-life-h">Lifecycle</h2>
        <span className="muted small">Select a stage or an arrow</span>
      </div>
      <div className="lc-life-body">
        <ol className="lc-flow" aria-label="Stages">
          {stages.map((s, i) => {
            const edge = transitions[i];
            return (
              <li key={s.id}>
                <button
                  type="button"
                  data-stage={s.id}
                  className={`lc-node lc-${s.state} lc-t-${s.id}${isOn({ kind: 'stage', id: s.id }) ? ' on' : ''}`}
                  aria-pressed={isOn({ kind: 'stage', id: s.id })}
                  aria-controls="lc-panel"
                  onClick={() => pick({ kind: 'stage', id: s.id })}
                >
                  <span className="lc-dot" aria-hidden="true">{s.state === 'done' ? '✓' : i + 1}</span>
                  <span className="lc-node-text">
                    <b>
                      {s.label}
                      {s.count !== undefined && s.count > 0 && <span className="lc-count">{s.count}</span>}
                    </b>
                    <small>{s.note}</small>
                  </span>
                </button>
                {edge && (
                  <button
                    type="button"
                    className={`lc-edge lc-t-${edge.to}${edge.done ? ' lc-edge-done' : ''}${isOn({ kind: 'edge', id: edge.id }) ? ' on' : ''}`}
                    aria-pressed={isOn({ kind: 'edge', id: edge.id })}
                    aria-controls="lc-panel"
                    aria-label={`${labelOf(stages, edge.from)} to ${labelOf(stages, edge.to)}: ${edge.rule}`}
                    onClick={() => pick({ kind: 'edge', id: edge.id })}
                  >
                    <span className="lc-edge-line" aria-hidden="true" />
                    <span className="lc-edge-text">
                      {edge.short} · {ACTOR[edge.actor]}
                      {edge.ready > 0 && <span className="lc-edge-ready">{edge.ready} ready</span>}
                    </span>
                  </button>
                )}
              </li>
            );
          })}
        </ol>
        <aside className="lc-panel" id="lc-panel" aria-live="polite" data-testid="lifecycle-panel">
          {selected.kind === 'stage' ? (
            <StagePanel
              stage={stages.find((s) => s.id === selected.id)!}
              next={transitions.find((t) => t.from === selected.id)}
              rows={rows}
              stats={stats}
              recent={recent}
              total={total}
              firstAt={firstAt}
              status={status}
              cloud={cloud}
            />
          ) : (
            <EdgePanel edge={transitions.find((t) => t.id === selected.id)!} stages={stages} rows={rows} />
          )}
        </aside>
      </div>
    </section>
  );
}

const labelOf = (stages: Stage[], id: StageId) => stages.find((s) => s.id === id)?.label ?? id;

function StateChip({ state }: { state: Stage['state'] }) {
  const text = state === 'done' ? 'reached' : state === 'now' ? 'up next' : 'not yet';
  return <span className={`lc-chip lc-chip-${state}`}>{text}</span>;
}

function StagePanel({
  stage,
  next,
  rows,
  stats: allStats,
  recent,
  total,
  firstAt,
  status,
  cloud,
}: {
  stage: Stage;
  next?: Transition;
  rows: HandlerRow[];
  stats: Record<Tier, TierStats>;
  recent: number;
  total: number;
  firstAt?: string;
  status: string;
  cloud: boolean;
}) {
  const copy = STAGE_COPY[stage.id];
  const tier = isTier(stage.id) ? stage.id : null;
  const stats = tier ? allStats[tier] : null;
  const mine = tier ? rows.filter((r) => r.tier === tier) : [];

  return (
    <>
      <header className={`lc-panel-head lc-t-${stage.id}`}>
        <span className="lc-swatch" aria-hidden="true" />
        <h3>{stage.label}</h3>
        <StateChip state={stage.state} />
      </header>
      <p className="lc-panel-summary">{copy.summary}</p>

      <dl className="lc-stats">
        {tier && stats ? (
          <>
            <div><dt>Handlers now</dt><dd>{stage.count ?? 0}</dd></div>
            <div><dt>Recent requests</dt><dd>{stats.requests}<small> of last {recent}</small></dd></div>
            <div><dt>Avg engine time</dt><dd>{ms(stats.avgMs)}</dd></div>
          </>
        ) : (
          <>
            <div><dt>Status</dt><dd>{status}</dd></div>
            <div><dt>Requests</dt><dd>{total}</dd></div>
            <div><dt>Since</dt><dd>{firstAt ? new Date(firstAt).toLocaleTimeString('en-GB') : '—'}</dd></div>
          </>
        )}
      </dl>

      <dl className="lc-facts">
        <div><dt>Code lives</dt><dd>{copy.lives(cloud)}</dd></div>
        <div><dt>Model tokens</dt><dd>{copy.tokens}</dd></div>
        <div>
          <dt>Next</dt>
          <dd>{next ? <>{next.rule} <span className="muted">({ACTOR[next.actor]})</span></> : 'Final stage. A Crystal is never picked again.'}</dd>
        </div>
      </dl>

      {tier && <HandlerList title={`Handlers in ${stage.label}`} rows={mine} empty={`No ${stage.label} handlers right now.`} />}
    </>
  );
}

function EdgePanel({ edge, stages, rows }: { edge: Transition; stages: Stage[]; rows: HandlerRow[] }) {
  const from = labelOf(stages, edge.from);
  const to = labelOf(stages, edge.to);
  const onTheWay = isTier(edge.from) ? rows.filter((r) => r.tier === edge.from && !r.stale) : [];
  return (
    <>
      <header className={`lc-panel-head lc-t-${edge.to}`}>
        <span className="lc-swatch" aria-hidden="true" />
        <h3>
          {from} → {to}
        </h3>
        <span className={`lc-chip lc-chip-${edge.done ? 'done' : 'todo'}`}>{edge.done ? 'crossed' : 'not yet'}</span>
      </header>
      <p className="lc-panel-summary">{edge.rule}</p>
      <dl className="lc-stats">
        <div><dt>Moved by</dt><dd className="lc-cap">{ACTOR[edge.actor]}</dd></div>
        {edge.id !== 'connected-gas' && (
          <>
            <div><dt>On the way</dt><dd>{edge.onTheWay}</dd></div>
            <div><dt>{edge.actor === 'operator' ? 'Ready to crystallize' : 'In review'}</dt><dd>{edge.ready}</dd></div>
          </>
        )}
      </dl>
      {edge.id === 'liquid-crystal' && edge.ready > 0 && (
        <p className="lc-panel-hint">Crystallize sits on each ready row in Requests below.</p>
      )}
      {edge.id !== 'connected-gas' && <HandlerList title={`On the way to ${to}`} rows={onTheWay} empty={`No ${from} handlers on the way.`} />}
    </>
  );
}

function HandlerList({ title, rows, empty }: { title: string; rows: HandlerRow[]; empty: string }) {
  return (
    <div className="lc-plist">
      <h4>{title}</h4>
      {rows.length === 0 ? (
        <p className="muted small">{empty}</p>
      ) : (
        <ul>
          {rows.slice(0, LIST_LIMIT).map((r) => (
            <li key={r.key}>
              <a href={`#h-${r.key}`} title={r.intent}>
                <span className="mono lc-hash">#{r.shortKey}</span>
                <span className="lc-plist-intent">{r.intent}</span>
                <span className="lc-bar" aria-hidden="true">
                  <i className={`lc-fill-${r.canCrystallize ? 'crystal' : r.tier}`} style={{ width: `${r.progressPct}%` }} />
                </span>
                <span className="lc-plist-label">{r.progressLabel}</span>
              </a>
            </li>
          ))}
          {rows.length > LIST_LIMIT && <li className="muted small">+{rows.length - LIST_LIMIT} more in Requests</li>}
        </ul>
      )}
    </div>
  );
}
