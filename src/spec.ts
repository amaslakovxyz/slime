import type { IntentSpec, Effect } from "./types";

const FIELD = /^(roles|reads|writes|rule|try|invariant (\w+)):\s*(.*)$/;

export function parseIntent(markdown: string, name: string): IntentSpec {
  const body = markdown.match(/```([\s\S]*?)```/)?.[1];
  if (!body) throw new Error(`no spec block in intent ${name}`);

  const fields: { key: string; invName?: string; lines: string[] }[] = [];
  for (const raw of body.split("\n")) {
    const m = raw.match(FIELD);
    if (m) fields.push({ key: m[2] ? "invariant" : m[1], invName: m[2], lines: [m[3]] });
    else if (raw.trim() && fields.length) fields.at(-1)!.lines.push(raw.trim());
  }
  const val = (k: string) => fields.find(f => f.key === k)?.lines.join(" ").trim() ?? "";
  const list = (k: string) => val(k).split(",").map(s => s.trim()).filter(Boolean);

  return {
    name,
    roles: list("roles"),
    reads: list("reads"),
    writes: list("writes").map(w => {
      const m = w.match(/^(\w+)\((\w+(?:,\s*\w+)*)\)$/);
      if (!m) throw new Error(`bad writes entry: ${w}`);
      return { table: m[1], ops: m[2].split(",").map(s => s.trim()) as Effect["op"][] };
    }),
    rule: val("rule"),
    invariants: fields.filter(f => f.key === "invariant")
      .map(f => ({ name: f.invName!, sql: f.lines.join(" ") })),
    try: fields.filter(f => f.key === "try")
      .map(f => new Function(`return (${f.lines.join(" ")})`)() as Record<string, unknown>),
  };
}
