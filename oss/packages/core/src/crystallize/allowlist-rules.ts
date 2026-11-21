// What a Crystal shape function may use. Crystal runs in the app's process with
// no sandbox, so the allowlist is the boundary (C10).

export const ANY_MEMBER = 'any member';

/** Globals the shape function may use, and the static members it may read or call on each. */
export const ALLOWED_GLOBALS: Readonly<Record<string, ReadonlySet<string> | typeof ANY_MEMBER>> = {
  Math: ANY_MEMBER,
  Object: new Set(['keys', 'values', 'entries', 'fromEntries']),
  Array: new Set(['isArray', 'from', 'of']),
  JSON: new Set(['stringify', 'parse']),
  Number: new Set(['isInteger', 'isFinite', 'isNaN', 'parseFloat', 'parseInt', 'MAX_SAFE_INTEGER', 'MIN_SAFE_INTEGER', 'EPSILON']),
  String: new Set(['fromCharCode']),
  Date: new Set(['UTC', 'parse']),
  Intl: new Set(['NumberFormat', 'DateTimeFormat', 'PluralRules', 'Collator', 'ListFormat', 'RelativeTimeFormat']),
  Boolean: new Set(),
  Map: new Set(),
  Set: new Set(),
  parseInt: new Set(),
  parseFloat: new Set(),
  isNaN: new Set(),
  isFinite: new Set(),
};

export const VALUE_GLOBALS: ReadonlySet<string> = new Set(['undefined', 'NaN', 'Infinity']);

/** Property names that lead out of plain data: to constructors (and from there to Function), prototypes, or global mutation. */
export const BANNED_PROPERTIES: ReadonlySet<string> = new Set([
  'constructor',
  'prototype',
  '__proto__',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  'defineProperty',
  'defineProperties',
  'setPrototypeOf',
  'getPrototypeOf',
  'getOwnPropertyDescriptor',
  'getOwnPropertyDescriptors',
  'caller',
  'callee',
  'arguments',
]);

/** Syntax that is refused outright, by AST node type, with the name used in the error. */
export const BANNED_NODE_TYPES: Readonly<Record<string, string>> = {
  ThisExpression: '`this`',
  MetaProperty: '`new.target` / `import.meta`',
  ImportExpression: 'dynamic `import()`',
  AwaitExpression: '`await`',
  YieldExpression: 'generators',
  ClassDeclaration: 'classes',
  ClassExpression: 'classes',
  WithStatement: '`with`',
  DebuggerStatement: '`debugger`',
  WhileStatement: '`while` loops (use for...of or array methods)',
  DoWhileStatement: '`do...while` loops (use for...of or array methods)',
  ForStatement: '`for(;;)` loops (use for...of or array methods)',
  ForInStatement: '`for...in` (use Object.keys/entries)',
  LabeledStatement: 'labels',
};
