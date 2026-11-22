// What a model must return, checked before anything runs.
import { z } from 'zod';

// Every object is closed: Claude's structured output accepts only closed objects (MS4, P0.3).
const SqlStepSchema = z.strictObject({ name: z.string(), source: z.string(), sql: z.string(), params: z.array(z.string()) });
const ApiArgSchema = z.strictObject({ param: z.string(), input: z.string().nullable(), value: z.union([z.string(), z.number(), z.boolean()]).nullable() });
const ApiStepSchema = z.strictObject({ name: z.string(), source: z.string(), operation: z.string(), args: z.array(ApiArgSchema) });

export const ArtifactSchema = z.strictObject({
  version: z.literal(2),
  unsatisfiable: z.string().nullable(),
  steps: z.array(z.union([SqlStepSchema, ApiStepSchema])),
  shapeJs: z.string().nullable(),
  assumptions: z.array(z.string()),
});

export const OptimizedCodeSchema = z.object({
  sql: z.string(),
  params: z.array(z.string()),
  shape: z.string().nullable(),
  notes: z.array(z.string()),
});

export const ReviewVerdictSchema = z.object({
  verdict: z.enum(['approve', 'reject']),
  problems: z.array(z.string()),
});
