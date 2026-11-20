import { dispatchIntent } from "./request-path";
import type { Ctx, RequestDeps } from "./types";

// v0 has no auth; ctx never comes from the payload.
export const devSession = (): Ctx => ({ tenantId: 1, userId: 42, role: "user", now: new Date().toISOString() });

export function createFetchHandler(deps: RequestDeps, session: () => Ctx): (req: Request) => Promise<Response> {
  return async req => {
    if (req.method !== "POST" || new URL(req.url).pathname !== "/dispatch")
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });

    let body: unknown;
    try { body = await req.json(); }
    catch { return Response.json({ error: "BAD_REQUEST", detail: "body must be JSON" }, { status: 400 }); }
    const { intent, payload = {} } = (typeof body === "object" && body !== null ? body : {}) as { intent?: unknown; payload?: unknown };
    if (typeof intent !== "string")
      return Response.json({ error: "BAD_REQUEST", detail: "intent must be a string" }, { status: 400 });

    try {
      const r = await dispatchIntent(deps, intent, payload, session());
      switch (r.kind) {
        case "served":
          return Response.json({ intent: r.intent, tier: r.tier, handlerHash: r.handlerHash, response: r.response, effectsApplied: r.effectsApplied });
        case "rejected":
          return Response.json(
            { intent: r.intent, tier: r.tier, handlerHash: r.handlerHash, stage: r.stage, reason: r.reason, detail: r.detail },
            { status: r.stage === "role" ? 403 : 422 });
        case "unknown_intent":
          return Response.json({ error: "UNKNOWN_INTENT", intent: r.intent }, { status: 404 });
        case "generation_failed":
          return Response.json({ error: "GENERATION_FAILED", intent: r.intent, detail: r.detail }, { status: 502 });
      }
    } catch (err) {
      // Corrupt lee.lock, tampered handler bytes, missing API key, …: loud, never a silent fallback.
      return Response.json({ error: "INTERNAL", detail: String(err) }, { status: 500 });
    }
  };
}
