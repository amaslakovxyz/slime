import { getQuickJS } from "quickjs-emscripten";
import { GuardrailError, type Ctx, type DbApi, type HandlerResult, type Runner } from "./types";

export async function createQuickJsRunner(
  opts: { memoryLimitBytes?: number; deadlineMs?: number } = {},
): Promise<Runner> {
  const QuickJS = await getQuickJS(); // sync variant: host functions may be called re-entrantly
  const { memoryLimitBytes = 32 * 1024 * 1024, deadlineMs = 500 } = opts;

  return {
    run(source: string, input: unknown, db: DbApi, ctx: Ctx): HandlerResult {
      const runtime = QuickJS.newRuntime();
      let hostError: unknown; // GuardrailErrors must cross the VM boundary intact
      try {
        runtime.setMemoryLimit(memoryLimitBytes);
        const deadline = Date.now() + deadlineMs;
        runtime.setInterruptHandler(() => Date.now() > deadline);
        const vm = runtime.newContext();
        try {
          const host = (name: string, impl: (json: string) => string) => {
            const fn = vm.newFunction(name, argH => {
              try { return vm.newString(impl(vm.getString(argH))); }
              catch (e) { hostError = e; throw e; } // surfaces inside the VM as an exception too
            });
            vm.setProp(vm.global, name, fn);
            fn.dispose();
          };
          host("__read", json => JSON.stringify(db.read(JSON.parse(json))));
          host("__emit", json => (db.emit(JSON.parse(json)), "null"));

          const body = source.replace(/^\s*export\s+/m, "");
          const program = `
            const ctx = ${JSON.stringify(ctx)};
            // undefined → null so a missing value reaches the kernel instead of silently dropping its key
            // (JSON.stringify drops undefined: where {id: undefined} would become where {} = "every row").
            const keepUndefined = (k, v) => v === undefined ? null : v;
            const db = {
              read: q => JSON.parse(__read(JSON.stringify(q, keepUndefined))),
              emit: e => { __emit(JSON.stringify(e, keepUndefined)); },
            };
            ${body}
            JSON.stringify(handler(${JSON.stringify(input)}, db, ctx))
          `;
          // Global script mode: the program's value is its last expression (module mode would return exports).
          const result = vm.evalCode(program, "handler.js", { type: "global" });
          if (result.error) {
            const detail = JSON.stringify(vm.dump(result.error));
            result.error.dispose();
            if (hostError instanceof GuardrailError) throw hostError;
            if (Date.now() > deadline) throw new GuardrailError("SANDBOX_TIMEOUT", `exceeded ${deadlineMs}ms`);
            if (/out of memory/i.test(detail)) throw new GuardrailError("SANDBOX_MEMORY", detail);
            throw new GuardrailError("HANDLER_ERROR", detail);
          }
          const json = vm.getString(result.value);
          result.value.dispose();
          return JSON.parse(json) as HandlerResult;
        } finally {
          vm.dispose();
        }
      } finally {
        runtime.dispose();
      }
    },
  };
}
