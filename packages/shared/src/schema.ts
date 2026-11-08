/**
 * Schema inference and argument validation.
 *
 * Discovery never stores payload *values*. The page tap reports structural
 * shapes only (`{type:'object', properties:{title:{type:'string'}}}`), and this
 * module turns those shapes into JSON Schema, merges repeated observations, and
 * validates arguments before anything is sent to a website.
 */
import { LIMITS } from './limits.ts';

export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  enum?: unknown[];
  format?: string;
  description?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  [key: string]: unknown;
};

/** The structural node emitted by the page tap. Values are never included. */
export interface ShapeNode {
  type: string;
  properties?: Record<string, ShapeNode>;
  items?: ShapeNode;
  format?: string;
}

export function isShapeNode(value: unknown): value is ShapeNode {
  if (!value || typeof value !== 'object') return false;
  const node = value as ShapeNode;
  return typeof node.type === 'string';
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

export function shapeToJsonSchema(node: ShapeNode | undefined, depth = 0): JsonSchema {
  if (!node || depth > LIMITS.maxSchemaDepth) return {};
  switch (node.type) {
    case 'string': {
      const schema: JsonSchema = { type: 'string' };
      if (node.format === 'date-time') schema.format = 'date-time';
      return schema;
    }
    case 'number':
      return { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'null':
      return { type: 'null' };
    case 'array':
      return { type: 'array', items: shapeToJsonSchema(node.items, depth + 1) };
    case 'object': {
      const properties: Record<string, JsonSchema> = {};
      const entries = Object.entries(node.properties ?? {}).slice(0, LIMITS.maxSchemaProperties);
      for (const [key, child] of entries) properties[key] = shapeToJsonSchema(child, depth + 1);
      return { type: 'object', properties, additionalProperties: true };
    }
    default:
      return {};
  }
}

function typeSet(schema: JsonSchema): string[] {
  if (!schema.type) return [];
  return Array.isArray(schema.type) ? schema.type : [schema.type];
}

/** Merge two observations of the same schema into one, widening types on conflict. */
export function mergeJsonSchema(a: JsonSchema | undefined, b: JsonSchema | undefined): JsonSchema {
  if (!a || Object.keys(a).length === 0) return b ?? {};
  if (!b || Object.keys(b).length === 0) return a;

  const typesA = typeSet(a);
  const typesB = typeSet(b);
  const union = Array.from(new Set([...typesA, ...typesB]));

  if (typesA.length && typesB.length && (typesA.length !== typesB.length || typesA.some((t) => !typesB.includes(t)))) {
    const merged: JsonSchema = union.length === 1 ? { type: union[0] } : { type: union };
    return merged;
  }

  const same = union[0];
  if (same === 'object') {
    const properties: Record<string, JsonSchema> = { ...(a.properties ?? {}) };
    for (const [key, child] of Object.entries(b.properties ?? {})) {
      properties[key] = properties[key] ? mergeJsonSchema(properties[key], child) : child;
    }
    const merged: JsonSchema = { type: 'object', properties };
    if (a.additionalProperties !== undefined || b.additionalProperties !== undefined) {
      merged.additionalProperties = a.additionalProperties ?? b.additionalProperties;
    }
    const required = (a.required ?? []).filter((name) => (b.required ?? []).includes(name));
    if (required.length) merged.required = required;
    return merged;
  }
  if (same === 'array') {
    const merged: JsonSchema = { type: 'array', items: mergeJsonSchema(a.items, b.items) };
    return merged;
  }
  const merged: JsonSchema = { type: same };
  if (a.format && a.format === b.format) merged.format = a.format;
  return merged;
}

// ---------------------------------------------------------------------------
// Path templating
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_RE = /^\d+$/;
const HEX_ID_RE = /^[0-9a-f]{16,}$/i;

export function isIdentifierSegment(segment: string): boolean {
  if (!segment) return false;
  if (NUMERIC_RE.test(segment)) return true;
  if (UUID_RE.test(segment)) return true;
  if (HEX_ID_RE.test(segment)) return true;
  return false;
}

export interface PathTemplateResult {
  template: string;
  params: string[];
}

/**
 * `/api/tasks/42/comments/7` -> `/api/tasks/{id}/comments/{id2}`.
 * Identifier-looking segments become parameters; everything else is kept
 * verbatim so two different resources never collapse into one endpoint.
 */
export function inferPathTemplate(pathname: string): PathTemplateResult {
  const clean = pathname.split('?')[0] ?? '/';
  const segments = clean.split('/');
  const params: string[] = [];
  const used = new Map<string, number>();

  const templated = segments.map((segment) => {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      /* keep raw */
    }
    if (!isIdentifierSegment(decoded)) return segment;
    const base = 'id';
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    const name = count === 1 ? base : `${base}${count}`;
    params.push(name);
    return `{${name}}`;
  });

  return { template: templated.join('/') || '/', params };
}

export function pathParamNames(template: string): string[] {
  const names: string[] = [];
  for (const match of template.matchAll(/\{([A-Za-z0-9_]+)\}/g)) names.push(match[1]);
  return names;
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

const NOISE_SEGMENTS = new Set(['api', 'v1', 'v2', 'v3', 'rest', 'internal', 'public', 'graphql']);

function singular(word: string): string {
  if (!word) return word;
  if (word.endsWith('ies') && word.length > 3) return `${word.slice(0, -3)}y`;
  if (word.endsWith('ses') && word.length > 3) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 1) return word.slice(0, -1);
  return word;
}

function pluralize(word: string): string {
  if (!word) return word;
  if (word.endsWith('s')) return word;
  if (word.endsWith('y') && word.length > 1) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

export function sanitizeName(input: string): string {
  let name = String(input)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_');
  if (!name || /^[0-9]/.test(name)) name = `tool_${name}`.replace(/_+$/g, '');
  return name.slice(0, 60);
}

export function suggestToolName(method: string, pathTemplate: string): string {
  const verb = String(method || 'GET').toUpperCase();
  const segments = pathTemplate
    .split('/')
    .filter(Boolean)
    .filter((segment) => !(segment.startsWith('{') && segment.endsWith('}')))
    .filter((segment) => !NOISE_SEGMENTS.has(segment.toLowerCase()));

  const resource = segments.length ? segments[segments.length - 1] : 'root';
  const hasParam = /\{[A-Za-z0-9_]+\}/.test(pathTemplate);

  let action: string;
  switch (verb) {
    case 'GET':
    case 'HEAD':
      // A path with a parameter addresses one item; a bare path lists a collection.
      action = hasParam ? 'get' : 'list';
      break;
    case 'POST':
      action = 'create';
      break;
    case 'PUT':
      action = 'replace';
      break;
    case 'PATCH':
      action = 'update';
      break;
    case 'DELETE':
      action = 'delete';
      break;
    default:
      action = verb.toLowerCase();
  }
  return sanitizeName(`${action}_${action === 'list' ? pluralize(resource) : singular(resource)}`);
}

const VERB_PHRASE: Record<string, string> = {
  list: 'List',
  get: 'Get',
  create: 'Create',
  update: 'Update',
  replace: 'Replace',
  delete: 'Delete',
};

export function describeEndpoint(method: string, pathTemplate: string, domain: string, samples: number): string {
  const verb = String(method || 'GET').toUpperCase();
  const name = suggestToolName(verb, pathTemplate);
  const head = VERB_PHRASE[name.split('_')[0]] ?? verb;
  const subject = name.split('_').slice(1).join(' ').replace(/_/g, ' ') || 'resource';
  return `${head} ${subject} on ${domain} via ${verb} ${pathTemplate}. Observed ${samples} time${samples === 1 ? '' : 's'} while discovery was running.`;
}

// ---------------------------------------------------------------------------
// Input schema construction
// ---------------------------------------------------------------------------

export type ParamLocation = 'path' | 'query' | 'body';

export interface InputBuildInput {
  method: string;
  pathTemplate: string;
  queryKeys: string[];
  bodySchema?: JsonSchema;
  querySchema?: JsonSchema;
}

export interface BuiltInputs {
  schema: JsonSchema;
  paramLocations: Record<string, ParamLocation>;
  requiredBody: boolean;
}

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

export function buildInputSchema(input: InputBuildInput): BuiltInputs {
  const { method, pathTemplate, queryKeys, bodySchema, querySchema } = input;
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const paramLocations: Record<string, ParamLocation> = {};

  for (const name of pathParamNames(pathTemplate)) {
    properties[name] = { type: 'string', description: `Path parameter {${name}}.` };
    required.push(name);
    paramLocations[name] = 'path';
  }

  for (const key of queryKeys.slice(0, LIMITS.maxSchemaProperties)) {
    if (paramLocations[key]) continue;
    const typed = querySchema?.properties?.[key];
    properties[key] = typed ? { ...typed, description: `Query parameter "${key}".` } : { type: 'string', description: `Query parameter "${key}".` };
    paramLocations[key] = 'query';
  }

  let requiredBody = false;
  if (bodySchema && bodySchema.properties) {
    for (const [key, schema] of Object.entries(bodySchema.properties)) {
      if (paramLocations[key]) {
        // A body field colliding with a path/query name keeps the path/query
        // binding and moves the body under `body` to avoid ambiguity.
        continue;
      }
      properties[key] = schema;
      paramLocations[key] = 'body';
    }
    requiredBody = BODY_METHODS.has(String(method).toUpperCase()) && Object.keys(bodySchema.properties).length > 0;
  } else if (bodySchema && Object.keys(bodySchema).length > 0) {
    properties.body = { ...bodySchema, description: 'Request body.' };
    paramLocations.body = 'body';
    requiredBody = BODY_METHODS.has(String(method).toUpperCase());
    if (requiredBody) required.push('body');
  }

  const schema: JsonSchema = {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };

  return { schema, paramLocations, requiredBody };
}

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  value: Record<string, unknown>;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return !!value && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function coerceScalar(value: unknown, type: string): unknown {
  if (typeof value !== 'string') return value;
  if (type === 'number' || type === 'integer') {
    if (!/^-?\d+(\.\d+)?$/.test(value)) return value;
    const num = Number(value);
    return type === 'integer' ? Math.trunc(num) : num;
  }
  if (type === 'boolean') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return value;
}

/**
 * Validate tool arguments against the generated input schema.
 *
 * Unknown top-level keys are rejected (not silently dropped) so a caller cannot
 * smuggle extra fields into a request. Path/query scalars are coerced from
 * strings because that is how HTTP represents them.
 */
export function validateArguments(
  schema: JsonSchema,
  args: unknown,
  paramLocations: Record<string, ParamLocation> = {},
): ValidationResult {
  const errors: string[] = [];
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, errors: ['Arguments must be a JSON object.'], value: {} };
  }
  const input = args as Record<string, unknown>;
  const properties = schema.properties ?? {};
  const allowExtra = schema.additionalProperties === true;
  const value: Record<string, unknown> = {};

  for (const key of Object.keys(input)) {
    if (!properties[key] && !allowExtra) {
      errors.push(`Unknown parameter "${key}".`);
    }
  }

  for (const [key, propertySchema] of Object.entries(properties)) {
    const present = Object.prototype.hasOwnProperty.call(input, key);
    if (!present) {
      if ((schema.required ?? []).includes(key)) errors.push(`Missing required parameter "${key}".`);
      continue;
    }
    let current: unknown = input[key];
    const types = typeSet(propertySchema);
    const location = paramLocations[key];

    if (types.length && (location === 'path' || location === 'query')) {
      // URL components are always text: coerce scalars in both directions so a
      // caller can pass `limit: 10` for a query parameter without failing.
      if (typeof current === 'string') {
        const coerced = coerceScalar(current, types[0]);
        if (coerced !== current) current = coerced;
      } else if ((typeof current === 'number' || typeof current === 'boolean') && types.includes('string')) {
        current = String(current);
      }
    }

    if (types.length && !types.some((type) => matchesType(current, type))) {
      errors.push(`Parameter "${key}" must be of type ${types.join(' | ')}.`);
      continue;
    }
    if (typeof current === 'string') {
      if (propertySchema.maxLength && current.length > propertySchema.maxLength) {
        errors.push(`Parameter "${key}" exceeds maxLength ${propertySchema.maxLength}.`);
        continue;
      }
      if (propertySchema.minLength && current.length < propertySchema.minLength) {
        errors.push(`Parameter "${key}" is shorter than minLength ${propertySchema.minLength}.`);
        continue;
      }
    }
    if (typeof current === 'number') {
      if (typeof propertySchema.minimum === 'number' && current < propertySchema.minimum) {
        errors.push(`Parameter "${key}" is below minimum ${propertySchema.minimum}.`);
        continue;
      }
      if (typeof propertySchema.maximum === 'number' && current > propertySchema.maximum) {
        errors.push(`Parameter "${key}" is above maximum ${propertySchema.maximum}.`);
        continue;
      }
    }
    value[key] = current;
  }

  return { ok: errors.length === 0, errors, value };
}

// ---------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------

export interface BuiltRequest {
  path: string;
  query: string;
  body?: unknown;
}

export interface RequestTarget {
  pathTemplate: string;
  method: string;
  paramLocations: Record<string, ParamLocation>;
}

/**
 * Turn validated arguments into a path + query + JSON body, using the
 * parameter locations recorded at discovery time. Nothing is interpolated into
 * the URL except percent-encoded scalars.
 */
export function buildRequest(target: RequestTarget, args: Record<string, unknown>): BuiltRequest {
  let path = target.pathTemplate;
  const query = new URLSearchParams();
  const body: Record<string, unknown> = {};
  let hasBody = false;

  for (const [key, value] of Object.entries(args)) {
    const location = target.paramLocations[key] ?? 'body';
    if (location === 'path') {
      path = path.replace(new RegExp(`\\{${key}\\}`, 'g'), encodeURIComponent(String(value)));
    } else if (location === 'query') {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) query.append(key, String(item));
      } else {
        query.append(key, String(value));
      }
    } else {
      body[key] = value;
      hasBody = true;
    }
  }

  // Any remaining template slot that was not supplied stays literal so the
  // runtime's own URL checks see it rather than silently sending `/{id}`.
  const built: BuiltRequest = { path, query: query.toString() };
  if (hasBody) built.body = body;
  return built;
}

export function looksLikeJsonString(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
}

export function inferFormat(value: string): string | undefined {
  return ISO_DATE_RE.test(value) ? 'date-time' : undefined;
}

/** Byte length of a JSON payload, without building a second copy for large objects. */
export function jsonByteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value) ?? '').length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}
