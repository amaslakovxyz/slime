'use client';

// The lifecycle diagram: Connected -> Gas -> Liquid -> Crystal as a vertical flow
// of stages and the arrows between them, with a side panel for the selection.
// Icon-led on purpose: each fact is an icon and a number or a word, and the full
// sentence lives in its tooltip (data-tip) and its accessible name, so the card
// reads at a glance. Until the operator picks something the panel follows the
// current stage, so a live poll that moves the endpoint on moves it too.
import { useState } from 'react';
// Types only: lib/lifecycle also holds server reads (the secret store), which must stay out of the client bundle.
import type { HandlerRow, Stage, StageId, Tier, TierStats, Transition } from '@/lib/lifecycle';
import { Icon, type IconName } from './icons';

type Selection = { kind: 'stage'; id: StageId } | { kind: 'edge'; id: Transition['id'] };
/** `label` is the slightly longer word a step shows in the transition panel. */
type Fact = { icon: IconName; text: string; tip: string; label?: string };

const STAGE_ICON: Record<StageId, IconName> = { connected: 'plug', gas: 'gas', liquid: 'liquid', crystal: 'crystal' };

/** Verified against core/src/config/defaults.ts and docs/product/atlas-demo-cheatsheet.md (2026-11-22). */
const STAGE_COPY: Record<StageId, { tagline: string; facts: (cloud: boolean) => Fact[] }> = {
  connected: {
    tagline: 'Your database, read-only',
    facts: () => [
      { icon: 'lock', text: 'read-only', tip: 'A read-only role; the endpoint refuses one that can write' },
      { icon: 'coin', text: '0', tip: 'No model tokens until a request arrives' },
    ],
  },
  gas: {
    tagline: 'Generated · answering · not reviewed',
    facts: (cloud) => [
      { icon: 'memory', text: 'memory', tip: cloud ? 'Memory of one runtime instance; gone when the 1 h window ends' : 'Memory of the runtime process; a restart drops it' },
      { icon: 'coin', text: 'once', tip: 'Model tokens once, to write the handler; repeats run the cached code' },
    ],
  },
  liquid: {
    tagline: 'Reviewed · saved · any input',
    facts: () => [
      { icon: 'db', text: 'saved', tip: 'The saved-handlers table; survives restarts' },
      { icon: 'coin', text: '0', tip: 'No model tokens per call' },
    ],
  },
  crystal: {
    tagline: 'Own route · no model',
    facts: (cloud) => [
      { icon: 'module', text: 'module', tip: cloud ? 'A checked module in S3' : 'A checked module in the endpoint’s data folder' },
      { icon: 'key', text: 'own token', tip: 'An slc_ token that opens only this route' },
      { icon: 'coin', text: '0', tip: 'No model, ever' },
    ],
  },
};

const ACTOR: Record<Transition['actor'], Fact> = {
  agent: { icon: 'agent', text: 'agent', tip: 'Your agent’s first request', label: '1st request' },
  automatic: { icon: 'auto', text: 'auto', tip: 'Automatic: no action needed', label: 'automatic' },
  operator: { icon: 'you', text: 'you', tip: 'You press Crystallize', label: 'you click' },
};

/** The steps of an arrow, as icon chips: runs, review, who moves it. */
function stepsOf(edge: Transition): Fact[] {
  const steps: Fact[] = [];
  if (edge.runs !== undefined) steps.push({ icon: 'repeat', text: `${edge.runs}`, tip: `${edge.runs} successful runs`, label: `${edge.runs} runs` });
  if (edge.id === 'gas-liquid') steps.push({ icon: 'review', text: 'review', tip: 'A second model reviews the code' });
  steps.push(ACTOR[edge.actor]);
  return steps;
}

const STATE_TIP: Record<Stage['state'], string> = { done: 'Reached', now: 'Up next', todo: 'Not yet' };
const LIST_LIMIT = 5;
const isTier = (id: StageId): id is Tier => id !== 'connected';
const ms = (n: number | null) => (n === null ? '—' : n.toFixed(1));

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
  cloud,
}: {
  stages: Stage[];
  transitions: Transition[];
  rows: HandlerRow[];
  /** Per tier, over the recent feed (`recent` requests). */
  stats: Record<Tier, TierStats>;
  recent: number;
  cloud: boolean;
}) {
  const [picked, setPicked] = useState<Selection | null>(null);
  const selected = picked ?? defaultSelection(stages);
  const isOn = (s: Selection) => s.kind === selected.kind && s.id === selected.id;
  const labelOf = (id: StageId) => stages.find((s) => s.id === id)?.label ?? id;

  return (
    <section className="card lc-card lc-life" aria-label="Lifecycle">
      <div className="lc-life-body">
        <ol className="lc-flow" aria-label="Stages">
          {stages.map((s) => {
            const edge = transitions.find((t) => t.from === s.id);
            return (
              <li key={s.id}>
                <button
                  type="button"
                  data-stage={s.id}
                  className={`lc-node lc-${s.state} lc-t-${s.id}${isOn({ kind: 'stage', id: s.id }) ? ' on' : ''}`}
                  aria-pressed={isOn({ kind: 'stage', id: s.id })}
                  aria-controls="lc-panel"
                  aria-label={`${s.label}: ${STATE_TIP[s.state]}${s.count ? `, ${s.count} handlers` : ''}`}
                  onClick={() => setPicked({ kind: 'stage', id: s.id })}
                >
                  <span className="lc-dot">
                    <Icon name={STAGE_ICON[s.id]} size={15} />
                  </span>
                  <b>{s.label}</b>
                  {s.count !== undefined && s.count > 0 && <span className="lc-count">{s.count}</span>}
                  <span className="lc-chev"><Icon name="chevron" size={14} /></span>
                </button>
                {edge && (
                  <button
                    type="button"
                    className={`lc-edge lc-t-${edge.to}${edge.done ? ' lc-edge-done' : ''}${isOn({ kind: 'edge', id: edge.id }) ? ' on' : ''}`}
                    aria-pressed={isOn({ kind: 'edge', id: edge.id })}
                    aria-controls="lc-panel"
                    aria-label={`${labelOf(edge.from)} to ${labelOf(edge.to)}: ${edge.rule}${edge.ready ? ` ${edge.ready} ready.` : ''}`}
                    onClick={() => setPicked({ kind: 'edge', id: edge.id })}
                  >
                    <span className="lc-edge-line" />
                    <span className="lc-steps">
                      {stepsOf(edge).map((f) => <Chip key={f.icon} fact={f} bare />)}
                      {edge.ready > 0 && (
                        <span className="lc-ready" data-tip={edge.actor === 'operator' ? `${edge.ready} ready to crystallize` : `${edge.ready} in review`}>
                          <Icon name={edge.actor === 'operator' ? 'crystal' : 'review'} size={12} />{edge.ready}
                        </span>
                      )}
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
              rows={rows}
              stats={isTier(selected.id) ? stats[selected.id] : null}
              recent={recent}
              cloud={cloud}
            />
          ) : (
            <EdgePanel edge={transitions.find((t) => t.id === selected.id)!} rows={rows} labelOf={labelOf} />
          )}
        </aside>
      </div>
    </section>
  );
}

function Chip({ fact, bare = false }: { fact: Fact; bare?: boolean }) {
  return (
    <span className={bare ? 'lc-step' : 'lc-fact'} data-tip={fact.tip}>
      <Icon name={fact.icon} size={bare ? 13 : 14} />
      {fact.text}
    </span>
  );
}

function Metric({ icon, value, unit, label, tip }: { icon: IconName; value: string | number; unit?: string; label: string; tip: string }) {
  return (
    <div className="lc-metric" data-tip={tip}>
      <span className="lc-metric-v">
        <b>{value}</b>
        {unit && <small>{unit}</small>}
      </span>
      <span className="lc-metric-l"><Icon name={icon} size={12} />{label}</span>
      <span className="sr-only">{tip}</span>
    </div>
  );
}

function StagePanel({
  stage,
  rows,
  stats,
  recent,
  cloud,
}: {
  stage: Stage;
  rows: HandlerRow[];
  stats: TierStats | null;
  recent: number;
  cloud: boolean;
}) {
  const copy = STAGE_COPY[stage.id];
  const mine = isTier(stage.id) ? rows.filter((r) => r.tier === stage.id) : [];

  return (
    <>
      <header className={`lc-panel-head lc-t-${stage.id}`}>
        <span className="lc-badge-ico"><Icon name={STAGE_ICON[stage.id]} size={18} /></span>
        <div>
          <h3>{stage.label}</h3>
          <p>{copy.tagline}</p>
        </div>
      </header>

      <div className="lc-facts">{copy.facts(cloud).map((f) => <Chip key={f.icon} fact={f} />)}</div>

      {stats && (
        <div className="lc-metrics">
          <Metric icon="layers" value={stage.count ?? 0} label="handlers" tip="Handlers in this stage now" />
          <Metric icon="activity" value={stats.requests} label="recent" tip={`Requests it answered, of the last ${recent}`} />
          <Metric icon="clock" value={ms(stats.avgMs)} unit={stats.avgMs === null ? undefined : 'ms'} label="avg" tip="Mean engine time" />
        </div>
      )}

      {isTier(stage.id) && <HandlerList rows={mine} />}
    </>
  );
}

function EdgePanel({ edge, rows, labelOf }: { edge: Transition; rows: HandlerRow[]; labelOf: (id: StageId) => string }) {
  const onTheWay = isTier(edge.from) ? rows.filter((r) => r.tier === edge.from && !r.stale) : [];
  const firstReady = onTheWay.find((r) => r.canCrystallize);
  return (
    <>
      <header className={`lc-panel-head lc-t-${edge.to}`}>
        <span className="lc-route-icons">
          <Icon name={STAGE_ICON[edge.from]} size={16} />
          <Icon name="arrow" size={14} />
          <span className="lc-badge-ico"><Icon name={STAGE_ICON[edge.to]} size={18} /></span>
        </span>
        <div>
          <h3>{labelOf(edge.from)} → {labelOf(edge.to)}</h3>
          <p className="sr-only">{edge.rule}</p>
          <span className="lc-steps" aria-hidden="true">{stepsOf(edge).map((f) => <Chip key={f.icon} fact={{ ...f, text: f.label ?? f.text }} bare />)}</span>
        </div>
      </header>

      {edge.id !== 'connected-gas' && (
        <div className="lc-metrics lc-metrics-2">
          <Metric icon="layers" value={edge.onTheWay} label="on the way" tip={`${labelOf(edge.from)} handlers on the way`} />
          <Metric icon={edge.actor === 'operator' ? 'crystal' : 'review'} value={edge.ready} label={edge.actor === 'operator' ? 'ready' : 'in review'} tip={edge.actor === 'operator' ? 'Ready to crystallize' : 'Met the runs, waiting for the review'} />
        </div>
      )}

      {firstReady && (
        <a className="btn btn-sm lc-btn-crystal lc-jump" href={`#h-${firstReady.key}`}>
          <Icon name="crystal" size={14} /> Crystallize <Icon name="down" size={14} />
        </a>
      )}

      {edge.id !== 'connected-gas' && <HandlerList rows={onTheWay} />}
    </>
  );
}

function HandlerList({ rows }: { rows: HandlerRow[] }) {
  // The handlers metric already says 0; an empty list adds nothing.
  if (rows.length === 0) return null;
  return (
    <ul className="lc-plist">
      {rows.slice(0, LIST_LIMIT).map((r) => (
        <li key={r.key}>
          <a href={`#h-${r.key}`} title={`${r.intent} · ${r.progressLabel}`}>
            <span className="mono lc-hash">#{r.shortKey}</span>
            <span className="lc-plist-intent">{r.intent}</span>
            <span className="lc-bar" aria-hidden="true">
              <i className={`lc-fill-${r.canCrystallize ? 'crystal' : r.tier}`} style={{ width: `${r.progressPct}%` }} />
            </span>
            <span className={`lc-mark lc-mark-${r.progressShort}`}>
              {r.progressShort === 'ready' ? <Icon name="crystal" size={13} /> : r.progressShort === 'live' ? <Icon name="key" size={13} /> : r.progressShort}
              <span className="sr-only">{r.progressLabel}</span>
            </span>
          </a>
        </li>
      ))}
      {rows.length > LIST_LIMIT && <li className="lc-more">+{rows.length - LIST_LIMIT}</li>}
    </ul>
  );
}
