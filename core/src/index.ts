// The public entry. Deep imports are not part of the API; adapters have their own subpaths (C7).

export { createSlime, type CreateSlimeOptions } from './create-slime.js';
export { DEFAULT_STORE_DIR, fileStore } from './stores/file-store.js';
export { memoryStore } from './stores/memory-store.js';
export type {
  CacheOutcome,
  HandlerRecord,
  HandlerSummary,
  QueryMeta,
  QueryResult,
  QueryTimings,
  ReviewStatus,
  Slime,
  SlimeStats,
  StoredTier,
  Tier,
} from './engine/types.js';
export type { CrystalHandler, ShapeFunction } from './engine/crystal/types.js';
export { changedProvenance, handlerKeyFor, type HandlerProvenance } from './request/key.js';
export type { ParamTypes } from './request/params.js';

export {
  SlimeConfig,
  DEFAULT_LIMITS,
  DEFAULT_TIERS,
  type CrystalRegistry,
  type ErrorEvent,
  type GeneratedEvent,
  type LimitOptions,
  type PromotedEvent,
  type ReviewedEvent,
  type SlimeEvent,
  type SlimeMode,
  type SlimeOptionOverrides,
  type SlimeOptions,
  type TierOptions,
  type WarningEvent,
} from './config/slime-config.js';
export { SlimeConfigError, SlimeError, type ErrorCode, type SlimeErrorBody, type SlimeErrorOptions } from './shared/errors.js';
export type {
  ColumnInfo,
  Connector,
  ForeignKey,
  QueryLimits,
  QueryPlan,
  RunResult,
  SafetyReport,
  SchemaInfo,
  TableInfo,
} from './connectors/types.js';
export type {
  Artifact,
  GenerationRequest,
  GenerationResult,
  Generator,
  ModelCallOptions,
  ModelUsage,
  OptimizeRequest,
  OptimizeResult,
  OptimizedCode,
  Optimizer,
  ParamTypesForModel,
  ReviewRequest,
  ReviewResult,
  Reviewer,
} from './models/types.js';
export type { SandboxLimits, SandboxRunner, ShapeJob } from './sandbox/types.js';
export { QuickJSRunner } from './sandbox/quickjs/quickjs-runner.js';
export type { InputScalar, InputValue, InputValues, SlimeRequest } from './request/parse.js';
export type { ParamType } from './request/params.js';
export type { LeafType, ObjectShape, Shape } from './request/shape.js';
export { SourceError, type SourceErrorOptions } from './sources/source-error.js';
export { defineApiSource } from './sources/api/define-api-source.js';
export type { ApiColumnDeclaration, ApiOperationDeclaration, ApiParamDeclaration, ApiRow, ApiRunContext, ApiSourceDeclaration } from './sources/api/declaration.js';
export type { HttpClient, HttpRequestOptions } from './sources/api/http-client.js';
export type { ApiSchema, ApiSource, CallOptions, OperationInfo, ParamInfo, Source, SourceCallOptions } from './sources/types.js';
export type { SlimeStore, StoreEntry } from './stores/types.js';
