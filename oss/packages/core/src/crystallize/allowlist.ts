import { parse, type AnyNode, type FunctionDeclaration, type Identifier, type MemberExpression, type Node, type Pattern, type Program } from 'acorn';
import { fullAncestor } from 'acorn-walk';
import { ALLOWED_GLOBALS, ANY_MEMBER, BANNED_NODE_TYPES, BANNED_PROPERTIES, VALUE_GLOBALS } from './allowlist-rules.js';

export class CrystalCodeError extends Error {}

const ECMA_VERSION = 2022;
const SHAPE_FUNCTION_NAME = 'shape';

export function parseModuleSource(source: string): Program {
  try {
    return parse(source, { ecmaVersion: ECMA_VERSION, sourceType: 'module' });
  } catch (error) {
    throw new CrystalCodeError(`not valid JavaScript: ${(error as Error).message}`);
  }
}

/** The source must be exactly one `function shape(rows, input) { ... }` that passes the allowlist. */
export function checkShapeSource(source: string): void {
  const { body } = parseModuleSource(source);
  const [declaration] = body;
  if (body.length !== 1 || declaration?.type !== 'FunctionDeclaration' || declaration.id.name !== SHAPE_FUNCTION_NAME) {
    throw new CrystalCodeError('must be a single `function shape(rows, input) { ... }`');
  }
  checkShapeFunction(declaration);
}

export function checkShapeFunction(shapeFunction: FunctionDeclaration): void {
  if (shapeFunction.async || shapeFunction.generator) throw new CrystalCodeError('shape must be a plain synchronous function');
  const declaredNames = declaredNamesIn(shapeFunction);
  // Banned syntax first: the walker visits children first, so a class would otherwise be reported as its unknown name.
  fullAncestor(shapeFunction, (node) => checkSyntax(node as AnyNode));
  fullAncestor(shapeFunction, (node, _state, ancestors) => checkAccess(node as AnyNode, ancestors.at(-2) as AnyNode | undefined, declaredNames));
}

function refuse(node: Node, what: string): never {
  throw new CrystalCodeError(`${what} is not allowed in Crystal code (at offset ${node.start})`);
}

function checkSyntax(node: AnyNode): void {
  const bannedName = BANNED_NODE_TYPES[node.type];
  if (bannedName) refuse(node, bannedName);
  const isFunctionNode = node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression' || node.type === 'FunctionDeclaration';
  if (isFunctionNode && (node.async || node.generator)) refuse(node, 'async functions and generators');
}

function checkAccess(node: AnyNode, parent: AnyNode | undefined, declaredNames: ReadonlySet<string>): void {
  if (node.type === 'MemberExpression') checkMemberAccess(node, parent, declaredNames);
  else if (node.type === 'Identifier' && isReference(node, parent)) checkIdentifier(node, parent, declaredNames);
}

function checkMemberAccess(node: MemberExpression, parent: AnyNode | undefined, declaredNames: ReadonlySet<string>): void {
  const propertyName = memberName(node);
  // obj[key] with a variable key can reach `constructor` at run time, so only literal keys are allowed.
  if (propertyName === undefined) refuse(node, 'computed property access with a variable key (use a Map)');
  if (BANNED_PROPERTIES.has(propertyName)) refuse(node, node.computed ? 'computed property access with a variable key (use a Map)' : `\`.${propertyName}\``);

  const globalName = node.object.type === 'Identifier' && !declaredNames.has(node.object.name) ? node.object.name : undefined;
  const allowedMembers = globalName ? ALLOWED_GLOBALS[globalName] : undefined;
  if (allowedMembers && allowedMembers !== ANY_MEMBER && !allowedMembers.has(propertyName)) refuse(node, `\`${globalName}.${propertyName}\``);

  const root = rootIdentifier(node);
  if (isWriteTarget(node, parent) && root && !declaredNames.has(root)) refuse(node, 'changing a global');
}

function checkIdentifier(node: Identifier, parent: AnyNode | undefined, declaredNames: ReadonlySet<string>): void {
  const { name } = node;
  if (declaredNames.has(name) || VALUE_GLOBALS.has(name)) return;
  if (!ALLOWED_GLOBALS[name]) refuse(node, `\`${name}\``);
  // A global may be called, constructed or have a member read, never passed around (Object.assign(Math, ...)).
  const isCalled = (parent?.type === 'CallExpression' || parent?.type === 'NewExpression') && parent.callee === node;
  const isMemberRead = parent?.type === 'MemberExpression' && parent.object === node;
  if (!isCalled && !isMemberRead) refuse(node, `using \`${name}\` as a value`);
}

/** The property name, or undefined for a computed key that isn't a number or string literal. */
function memberName({ computed, property }: MemberExpression): string | undefined {
  if (!computed) return property.type === 'Identifier' ? property.name : undefined;
  if (property.type === 'Literal' && (typeof property.value === 'number' || typeof property.value === 'string')) return String(property.value);
  return undefined;
}

function isWriteTarget(node: Node, parent: AnyNode | undefined): boolean {
  if (parent?.type === 'AssignmentExpression') return parent.left === node;
  if (parent?.type === 'UpdateExpression') return parent.argument === node;
  return parent?.type === 'UnaryExpression' && parent.operator === 'delete' && parent.argument === node;
}

function rootIdentifier(node: MemberExpression): string | undefined {
  let current: AnyNode = node;
  while (current.type === 'MemberExpression') current = current.object as AnyNode;
  return current.type === 'Identifier' ? current.name : undefined;
}

/** True when an Identifier is read as a variable, not used as a property name or label. */
function isReference(node: Identifier, parent: AnyNode | undefined): boolean {
  if (!parent) return true;
  if (parent.type === 'MemberExpression') return parent.computed || parent.property !== node;
  // `{ a: 1 }`'s key is a name; `{ a }` shorthand reads the variable `a`.
  if (parent.type === 'Property') return parent.computed || parent.shorthand || parent.key !== node;
  if (parent.type === 'MethodDefinition') return parent.computed || parent.key !== node;
  if (parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') return parent.label !== node;
  return true;
}

/** Every name the function declares: parameters, variables, inner functions and catch parameters. */
function declaredNamesIn(shapeFunction: FunctionDeclaration): Set<string> {
  const names = new Set<string>();
  const addPattern = (pattern: Pattern | null | undefined): void => {
    if (!pattern) return;
    if (pattern.type === 'Identifier') names.add(pattern.name);
    else if (pattern.type === 'ObjectPattern') pattern.properties.forEach((property) => addPattern(property.type === 'RestElement' ? property.argument : property.value));
    else if (pattern.type === 'ArrayPattern') pattern.elements.forEach(addPattern);
    else if (pattern.type === 'AssignmentPattern') addPattern(pattern.left);
    else if (pattern.type === 'RestElement') addPattern(pattern.argument);
  };
  fullAncestor(shapeFunction, (walked) => {
    const node = walked as AnyNode;
    if (node.type === 'VariableDeclarator') addPattern(node.id);
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      if (node.id) names.add(node.id.name);
      node.params.forEach(addPattern);
    }
    if (node.type === 'CatchClause') addPattern(node.param);
  });
  return names;
}
