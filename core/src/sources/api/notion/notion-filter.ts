// Call arguments → a Notion query filter. Null arguments add no condition (R5).
import type { PropertyMapping } from './notion-schema.js';

type Condition = Record<string, unknown>;

export interface NotionFilter {
  and: Condition[];
}

const TIMESTAMP_TYPES = new Set(['created_time', 'last_edited_time']);

export function filterFromArgs(properties: readonly PropertyMapping[], args: Readonly<Record<string, unknown>>): NotionFilter | undefined {
  const conditions = properties.flatMap((property) => conditionsFor(property, args));
  return conditions.length > 0 ? { and: conditions } : undefined;
}

function conditionsFor(property: PropertyMapping, args: Readonly<Record<string, unknown>>): Condition[] {
  const conditions: Condition[] = [];
  const equals = property.equalsParam === undefined ? null : (args[property.equalsParam] ?? null);
  if (equals !== null) conditions.push({ property: property.propertyName, [property.propertyType]: { equals } });
  const from = property.fromParam === undefined ? null : (args[property.fromParam] ?? null);
  const to = property.toParam === undefined ? null : (args[property.toParam] ?? null);
  if (from !== null) conditions.push(dateCondition(property, { on_or_after: from }));
  if (to !== null) conditions.push(dateCondition(property, { on_or_before: to }));
  return conditions;
}

// Created and edited times are filtered as timestamps, not as properties.
function dateCondition({ propertyName, propertyType }: PropertyMapping, bound: Condition): Condition {
  if (TIMESTAMP_TYPES.has(propertyType)) return { timestamp: propertyType, [propertyType]: bound };
  return { property: propertyName, date: bound };
}
