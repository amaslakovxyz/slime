// The public entry. Deep imports are not part of the API; adapters have their own subpaths (C7).

export { createSlime, type CreateSlimeOptions } from './create-slime.js';
export { DEFAULT_STORE_DIR, fileStore } from './stores/file-store.js';
export { memoryStore } from './stores/memory-store.js';
export type { CacheOutcome, HandlerSummary, QueryMeta, QueryResult, QueryTimings, Slime, SlimeStats } from './engine/types.js';
export type { HandlerRecord, ReviewStatus, StoredTier, Tier } from './handler/record.js';
export type { CrystalHandler, ShapeFunction } from './handler/crystal.js';
export { crystalService, type CrystalService, type CrystalServiceOptions } from './engine/crystal/service.js';
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
  type SlimeOptionOverrides,
  type SlimeOptions,
  type TierOptions,
  type WarningEvent,
} from './config/slime-config.js';
export { SlimeConfigError, SlimeError, type ErrorCode, type SlimeErrorBody, type SlimeErrorOptions } from './shared/errors.js';
export type { ColumnInfo, RunResult, SafetyReport, Source } from './sources/types.js';
export type { Connector, ForeignKey, QueryLimits, QueryPlan, SchemaInfo, TableInfo } from './sources/sql/types.js';
export type { ApiArg, ApiStep, Artifact, LegacyArtifact, SqlStep, Step } from './artifact/artifact.js';
export type {
  GenerationRequest,
  GenerationResult,
  Generator,
  ModelCallOptions,
  ModelUsage,
  OptimizeRequest,
  OptimizeResult,
  OptimizedCode,
  Optimizer,
  ReviewRequest,
  ReviewResult,
  Reviewer,
} from './models/types.js';
export type { SandboxLimits, SandboxRunner, ShapeJob } from './sandbox/types.js';
export { QuickJSRunner } from './sandbox/quickjs/quickjs-runner.js';
export type { InputScalar, InputValue, InputValues, SlimeRequest } from './request/parse.js';
export type { ParamType, ParamTypesForModel } from './request/params.js';
export type { LeafType, ObjectShape, Shape } from './request/shape.js';
export { SourceError, type SourceErrorOptions } from './sources/api/source-error.js';
export { defineApiSource } from './sources/api/define-api-source.js';
export type { ApiColumnDeclaration, ApiOperationDeclaration, ApiParamDeclaration, ApiRow, ApiRunContext, ApiSourceDeclaration } from './sources/api/declaration.js';
export type { HttpClient, HttpRequestOptions } from './sources/api/http/http-client.js';
export type { ApiSchema, ApiSource, CallOptions, OperationInfo, ParamInfo, SourceCallOptions } from './sources/api/types.js';
export type { SlimeStore, StoreEntry } from './stores/types.js';
