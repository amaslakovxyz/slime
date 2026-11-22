// One section per API source, in the same line format as tables (D2, design §3.4).
import type { ApiSchema, OperationInfo, ParamInfo } from '../sources/api/types.js';
import { INDENT, renderColumn, withComment } from './columns.js';

const PARAMS_HEADING = `${INDENT}params (all optional; null = not given):`;
const ROWS_HEADING = `${INDENT}returns rows:`;
const NO_PARAMS = `${INDENT}params: none`;

export function renderApiSource(sourceName: string, schema: ApiSchema): string {
  return [`API source "${sourceName}": ${schema.service}`, ...schema.operations.map(renderOperation)].join('\n');
}

function renderOperation(operation: OperationInfo): string {
  const heading = operation.description ? `Operation ${operation.name}: ${operation.description}` : `Operation ${operation.name}`;
  const params = operation.params.length === 0 ? [NO_PARAMS] : [PARAMS_HEADING, ...operation.params.map((param) => `${INDENT}${INDENT}${renderParam(param)}`)];
  const primaryKey = operation.primaryKey ?? [];
  const columns = operation.columns.map((column) => `${INDENT}${INDENT}${renderColumn(column, { isPrimaryKey: primaryKey.includes(column.name), references: undefined })}`);
  return [heading, ...params, ROWS_HEADING, ...columns].join('\n');
}

function renderParam({ name, type, values, comment }: ParamInfo): string {
  const parts = [name, type];
  if (values?.length) parts.push(`one of: ${values.join(', ')}`);
  return withComment(parts.join(' '), comment);
}
