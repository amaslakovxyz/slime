import type { Ctx, DbApi, HandlerResult, Runner } from "./types";

// Test double: no isolation. Real sandbox is the QuickJS runner.
export class FnRunner implements Runner {
  run(source: string, input: unknown, db: DbApi, ctx: Ctx): HandlerResult {
    const body = source.replace(/^\s*export\s+/m, "");
    const fn = new Function(`${body}; return handler;`)() as
      (i: unknown, d: DbApi, c: Ctx) => HandlerResult;
    return fn(input, db, ctx);
  }
}
