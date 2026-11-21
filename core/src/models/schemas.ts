// What a model must return, checked before anything runs.
import { z } from 'zod';

export const ArtifactSchema = z.object({
  unsatisfiable: z.string().nullable(),
  sql: z.string(),
  params: z.array(z.string()),
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
