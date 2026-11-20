# SLIME RUNTIME
> **Master Specification: Vision Pitch & Technical Architecture**<br>
> *Version 2.0.0 | Zero-Endpoint Dynamic Runtime*

---

# PART I: THE VISION PITCH

## 👁️ Manifest: The Death of Static Endpoints

Look at any modern server. What do you see? A mausoleum of dead files. Hard-coded routes like `/api/v1/users`, controllers, DTOs, and rigid validators. It is petrified clay. The server clings to its endpoints like a blind person to crutches because it fears the unknown.

**Slime is the complete erasure of endpoints, routing, and manual API deployment.**

In our system, there is **not a single registered URL endpoint**. The backend is an absolute, formless void, held in equilibrium only by business invariants. It does not know what request will arrive a second from now—and it doesn't care.

---

## 🌀 How the Slime Runtime Breathes

```
  [ Raw Request / Intention ]
               │
               ▼
   ┌──────────────────────┐
   │   1. VOID RECEIVER   │ (No routes. Pure semantic intent capture)
   └───────────┬───────────┘
               │
               ▼
   ┌──────────────────────┐
   │ 2. GAS SYNTHESIS     │ (On-the-fly synthesis of Wasm logic in ~150ms)
   └───────────┬───────────┘
               │
               ▼
   ┌──────────────────────┐
   │ 3. EPHEMERAL SPARK   │ (Execution in V8/Wasm isolate & evaporation)
   └───────────┬───────────┘
               │
               ▼
   ┌──────────────────────┐
   │ 4. CRYSTALLIZATION   │ (Hot paths crystallize into native binaries)
   └──────────────────────┘
```

### The Phase Transitions of Logic:

* **Gas ($\text{Tier 0}$):** A rare or novel request. Synthesized once on the fly, verified through Property-Based Fuzzing, executed in an isolate, and dissolved without leaving state artifacts.
* **Liquid ($\text{Tier 1}$):** A recurring request pattern. Compiled logic is cached in Redis as a Wasm/V8 bundle, resolving in $2 - 5\text{ ms}$.
* **Crystal ($\text{Tier 2}$):** A route executed $>10,000$ times. The runtime "tires of thinking," petrifying the execution path into an AOT native binary in the core engine.

> *«We no longer build backends. We create an intelligent plasma that wraps around any shape of data, fulfills the intent, and returns to pure potentiality.»*

---

# PART II: TECHNICAL ARCHITECTURE & DATA PIPELINE

## 1. System Topology

The Slime runtime consists of a static core runner housing dynamic sandbox isolates, linked to a pluggable connector bus for zero-trust data access.

```
[ Raw Request / UI Intent ]
          │
          ▼
┌────────────────────────────────────────────────────────┐
│ 1. Intent & Invariant Extraction                       │
│    - Compute SHA256 Semantic Fingerprint               │
│    - Load Target Security & Tenant Policies            │
└─────────────────────────┬──────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────┐
│ 2. Execution Tier Selection                            │
│    ├─► [Tier 2: Crystal / Native Wasm] (Hot Path: < 1ms)│
│    ├─► [Tier 1: Liquid / Redis Code Cache] (2-5ms)     │
│    └─► [Tier 0: Gas / Synthesis] (150-300ms)           │
└─────────────────────────┬──────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────┐
│ 3. Ephemeral Sandbox Execution                         │
│    - Spawn V8 Isolate / Wasm Instance                  │
│    - Inject ConnectorHub (Universal Query AST)         │
│    - Enforce Strict Memory & CPU Budgets               │
└─────────────────────────┬──────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────┐
│ 4. Effect Verification & Execution                     │
│    - Validate AST / Write Effects via Gatekeeper       │
│    - Execute Transactional Mutations / Read Assembly   │
└────────────────────────────────────────────────────────┘
```

---

# PART III: UNIVERSAL DATA CONNECTORS & QUERY AST

Generated functions do **not** receive direct SQL handles, ORM instances, or raw network sockets. Instead, the runtime injects a `ConnectorHub` that accepts a **Universal Query AST**.

```
                  ┌─────────────────────────────────────────┐
                  │    Ephemeral Sandbox (V8 / Wasm)        │
                  │   Synthesized Pure Function Logic       │
                  └────────────────────┬────────────────────┘
                                       │ UniversalQueryAST
                                       ▼
                  ┌─────────────────────────────────────────┐
                  │              ConnectorHub               │
                  └──────┬─────────────┬─────────────┬──────┘
                         │             │             │
                         ▼             ▼             ▼
                 ┌──────────────┐┌────────────┐┌────────────┐
                 │ PostgresSafe ││ RestApi    ││ ClickHouse │
                 │ Connector    ││ Connector  ││ Connector  │
                 └──────┬───────┘└─────┬──────┘└─────┬──────┘
                        │              │             │
                        ▼              ▼             ▼
                    [Postgres]     [Ext API]    [ClickHouse]
```

### 1. Universal Query AST Types

```typescript
export type FilterOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'like';

export interface FilterCondition {
  field: string;
  op: FilterOperator;
  value: string | number | boolean | Array<string | number>;
}

export interface UniversalQueryAST {
  resource: string; // Target table, collection, or endpoint
  select: string[]; // Allowed column projection
  filters?: FilterCondition[];
  sort?: { field: string; direction: 'asc' | 'desc' }[];
  limit?: number;
  offset?: number;
}

export interface SecurityContext {
  tenantId: string;
  userId: string;
  role: 'admin' | 'member' | 'viewer';
}

export interface DataConnector<TResult = Record<string, unknown>> {
  readonly name: string;
  executeRead(ast: UniversalQueryAST, ctx: SecurityContext): Promise<TResult[]>;
}
```

### 2. Postgres Safe Connector Implementation

The connector acts as a compiler from `UniversalQueryAST` to safe, parameterized SQL with enforced Row-Level Security (RLS) and query timeouts:

```typescript
import { Pool } from 'pg';
import { DataConnector, FilterCondition, SecurityContext, UniversalQueryAST } from './connector.types';

export interface TablePolicy {
  allowedColumns: string[];
  tenantColumn?: string;
  maxLimit: number;
}

export class PostgresSafeConnector implements DataConnector {
  readonly name = 'postgres';

  constructor(
    private readonly pool: Pool,
    private readonly policies: Record<string, TablePolicy>
  ) {}

  async executeRead(ast: UniversalQueryAST, ctx: SecurityContext): Promise<Record<string, unknown>[]> {
    const policy = this.policies[ast.resource];
    if (!policy) {
      throw new Error(`[Security] Resource "${ast.resource}" access forbidden.`);
    }

    // 1. Column Projection Validation
    const safeColumns = ast.select.filter((col) => policy.allowedColumns.includes(col));
    if (safeColumns.length === 0) {
      throw new Error(`[Security] No valid columns requested for "${ast.resource}".`);
    }

    // 2. Automated Row-Level Security (Tenant Isolation)
    const values: unknown[] = [];
    const whereClauses: string[] = [];

    if (policy.tenantColumn) {
      values.push(ctx.tenantId);
      whereClauses.push(`"${policy.tenantColumn}" = $${values.length}`);
    }

    for (const filter of ast.filters ?? []) {
      if (!policy.allowedColumns.includes(filter.field)) {
        throw new Error(`[Security] Column "${filter.field}" is not filterable.`);
      }
      whereClauses.push(this.compileCondition(filter, values));
    }

    // 3. Hard Limit Enforcer & Query Assembly
    const selectClause = safeColumns.map((c) => `"${c}"`).join(', ');
    const whereSQL = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const safeLimit = Math.min(ast.limit ?? 50, policy.maxLimit);
    values.push(safeLimit);

    const queryText = `
      SELECT ${selectClause}
      FROM "${ast.resource}"
      ${whereSQL}
      LIMIT $${values.length}
    `.trim();

    const client = await this.pool.connect();
    try {
      await client.query('SET LOCAL statement_timeout = 500'); // Max 500ms execution
      const res = await client.query(queryText, values);
      return res.rows;
    } finally {
      client.release();
    }
  }

  private compileCondition(cond: FilterCondition, values: unknown[]): string {
    const col = `"${cond.field}"`;
    if (cond.op === 'in') {
      if (!Array.isArray(cond.value)) throw new Error('Operator "in" requires array');
      values.push(cond.value);
      return `${col} = ANY($${values.length})`;
    }
    const opMap = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'ILIKE' };
    values.push(cond.value);
    return `${col} ${opMap[cond.op]} $${values.length}`;
  }
}
```

---

# PART IV: ISOLATION & WRITE SAFETY (EFFECT SINKS)

For CRUD state changes, synthesized code operates as a pure transformer: it reads input and returns an array of **declarative effects**. It does not perform mutations directly.

```typescript
export interface Effect {
  op: 'CREATE' | 'UPDATE' | 'DELETE';
  table: string;
  where?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

export interface ExecutionResult {
  status: 'SUCCESS' | 'FAILED';
  effects: Effect[];
  responseData: unknown;
}
```

### The Gatekeeper Pipeline:
1. **Allowlist Inspection:** Confirms the target table and modified columns are editable by the current role.
2. **Context Enforcer:** Injects `WHERE tenant_id = ctx.tenantId` into all update/delete predicates.
3. **Idempotency Guard:** Verifies mutation keys to prevent duplicate execution during retries.

---

# PART V: DEPLOYMENT & HOT-SWAP LIFECYCLE

Deployment is split into two distinct layers: static core engine updates (via standard CI/CD) and dynamic, zero-downtime logic hot-swapping.

```
 +-------------------------------------------------------------------------+
 |                           STATIC CORE ENGINE (CI/CD)                    |
 |  [ Catch-All Listener ] + [ V8 Isolate Runner ] + [ ConnectorHub ]     |
 +-------------------------------------------------------------------------+
                                      ▲
                                      │ Fetch Cached Logic
                                      ▼
 +-------------------------------------------------------------------------+
 |                           REDIS LOGIC STORE                             |
 |  Key: fn:{schemaHash}:v1 ──► [ JS Bundle / Compiled Wasm Module ]       |
 +-------------------------------------------------------------------------+
                                      ▲
                                      │ Promotion (Cron PR)
                                      ▼
 +-------------------------------------------------------------------------+
 |                        GITHUB CODE REPOSITORY                           |
 |  /src/crystallized/*.ts (AOT compiled into native binary on release)    |
 +-------------------------------------------------------------------------+
```

### Operational Execution Spectrum

| Parameter | Tier 0: Gas (Synthesis) | Tier 1: Liquid (Redis Cache) | Tier 2: Crystal (Native AOT) |
| :--- | :--- | :--- | :--- |
| **Cold Start** | $150 - 300\text{ ms}$ | $2 - 5\text{ ms}$ | $< 1\text{ ms}$ |
| **Environment** | Ephemeral V8 Isolate | In-Memory V8 Isolate | Native Compiled Assembly |
| **Data Fetch** | `UniversalQueryAST` | `UniversalQueryAST` | Direct Index-Optimized SQL |
| **Memory Allocation** | $\sim 16\text{ MB}$ | $\sim 2\text{ MB}$ | $< 512\text{ KB}$ |
| **Safety Assurance** | Property Fuzzing & Zod | AST Gatekeeper + RLS | AOT Verified Lean 4 Proofs |
