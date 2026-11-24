// Monogram tiles instead of vendor logos (no external assets, no trademarks).
const MONOGRAM: Record<string, string> = {
  postgres: 'PG',
  supabase: 'SB',
  mysql: 'My',
  clickhouse: 'CH',
  rest: '{ }',
  graphql: 'GQ',
};

export function ConnectorLogo({ type }: { type: string }) {
  return (
    <span className={`logo logo-${type}`} aria-hidden="true">
      {MONOGRAM[type] ?? type.slice(0, 2)}
    </span>
  );
}
