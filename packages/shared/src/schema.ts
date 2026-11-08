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

// ---------------------------------------------------------------------------
// Multi-observation accumulation
// ---------------------------------------------------------------------------

/**
 * A single observation is weak evidence: a field can be missing, null, or a
 * different type in the next response. Merging finished schemas loses that
 * information, so observations are folded into an accumulator that keeps a
 * presence count per node and the JSON Schema is derived from it.
 *
 * A field only becomes `required` when it appeared in *every* observation and
 * there were at least two observations. With one sample nothing is required, so
 * a generated tool never rejects a valid call on weak evidence.
 */
export interface SchemaAccum {
  /** Observations that contained this node. */
  n: number;
  types: string[];
  props?: Record<string, SchemaAccum>;
  items?: SchemaAccum;
  /** Small closed value set, only for enum-sampled scalar fields. */
  enums?: Array<string | number>;
}

export function newAccum(): SchemaAccum {
  return { n: 0, types: [] };
}

export function accumShape(
  prev: SchemaAccum | null | undefined,
  node: ShapeNode | undefined,
  /** Sampled value sets, keyed by field name (only at the top level). */
  enums?: Record<string, string[]>,
  depth = 0,
): SchemaAccum {
  const accum: SchemaAccum = prev
    ? {
        n: prev.n,
        types: [...prev.types],
        props: prev.props ? { ...prev.props } : undefined,
        items: prev.items,
        enums: prev.enums ? [...prev.enums] : undefined,
      }
    : newAccum();

  if (depth > LIMITS.maxSchemaDepth) return accum;

  if (!node) {
    accum.n += 1;
    if (!accum.types.includes('null')) accum.types.push('null');
    return accum;
  }

  accum.n += 1;
  const type = node.type === 'null' ? 'null' : node.type;
  if (!accum.types.includes(type)) accum.types.push(type);

  if (node.properties) {
    const props: Record<string, SchemaAccum> = accum.props ? { ...accum.props } : {};
    for (const [key, child] of Object.entries(node.properties).slice(0, LIMITS.maxSchemaProperties)) {
      const sampled = depth === 0 ? enums?.[key] : undefined;
      props[key] = accumShape(props[key], child, undefined, depth + 1);
      if (sampled && sampled.length > 0) {
        const merged = new Set<string | number>(props[key].enums ?? []);
        for (const value of sampled.slice(0, 8)) merged.add(value);
        props[key].enums = merged.size <= 8 ? [...merged] : undefined;
      }
    }
    accum.props = props;
  }

  if (node.items) accum.items = accumShape(accum.items, node.items, undefined, depth + 1);

  return accum;
}

/** Merge two accumulators (state restore, or combining two collection sources). */
export function mergeAccum(a: SchemaAccum | null | undefined, b: SchemaAccum | null | undefined): SchemaAccum | null {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  const out: SchemaAccum = { n: a.n + b.n, types: [...a.types] };
  for (const type of b.types) if (!out.types.includes(type)) out.types.push(type);
  if (a.props || b.props) {
    const props: Record<string, SchemaAccum> = { ...(a.props ?? {}) };
    for (const [key, child] of Object.entries(b.props ?? {})) {
      const merged = mergeAccum(props[key], child);
      if (merged) props[key] = merged;
    }
    out.props = props;
  }
  if (a.items || b.items) {
    const merged = mergeAccum(a.items, b.items);
    if (merged) out.items = merged;
  }
  if (a.enums || b.enums) {
    const merged = new Set<string | number>([...(a.enums ?? []), ...(b.enums ?? [])]);
    if (merged.size <= 8) out.enums = [...merged];
  }
  return out;
}

/** Derive a JSON Schema from an accumulator. */
export function accumToSchema(accum: SchemaAccum, depth = 0): JsonSchema {
  if (depth > LIMITS.maxSchemaDepth) return {};
  const nonNull = accum.types.filter((type) => type !== 'null');
  const isNullable = accum.types.includes('null');

  if (nonNull.length === 0) return isNullable ? { type: 'null', nullable: true } : {};

  // `type` stays a standard JSON Schema union so clients that ignore the
  // OpenAPI-style `nullable` flag still see null as a possibility.
  const types = isNullable ? [...nonNull, 'null'] : nonNull;
  const schema: JsonSchema = { type: types.length === 1 ? types[0] : types };

  if (accum.props && nonNull.includes('object')) {
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [key, child] of Object.entries(accum.props)) {
      properties[key] = accumToSchema(child, depth + 1);
      if (accum.n >= 2 && child.n === accum.n) required.push(key);
    }
    schema.properties = properties;
    schema.additionalProperties = false;
    if (required.length > 0) schema.required = required.sort();
  }

  if (accum.items && nonNull.includes('array')) schema.items = accumToSchema(accum.items, depth + 1);

  if (accum.enums && accum.enums.length > 0) {
    const allStrings = accum.enums.every((value) => typeof value === 'string');
    const allNumbers = accum.enums.every((value) => typeof value === 'number');
    if (allStrings || allNumbers) {
      schema.enum = [...accum.enums].sort() as unknown[];
      schema.type = allStrings ? 'string' : 'number';
    }
  }

  if (isNullable) schema.nullable = true;
  return schema;
}

/** How much evidence supports an accumulator, 0..1. */
export function accumConfidence(accum: SchemaAccum | null | undefined): number {
  if (!accum || accum.n === 0) return 0;
  const sampleScore = Math.min(accum.n, 3) / 3;
  const shapeScore = accum.props && Object.keys(accum.props).length > 0 ? 1 : accum.items ? 0.8 : 0.6;
  const stableTypes = accum.types.length === 1 || (accum.types.length === 2 && accum.types.includes('null'));
  return Math.round((0.5 * sampleScore + 0.3 * shapeScore + 0.2 * (stableTypes ? 1 : 0.6)) * 100) / 100;
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
  /** Pagination the page used, so the tool exposes the right paging params. */
  pagination?: { style: 'page' | 'offset' | 'cursor'; param: string; hasTotal: boolean; nextField: string | null } | null;
  /** GraphQL operation name, when the endpoint is a GraphQL operation. */
  graphqlOperation?: string | null;
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

  // Pagination: expose the paging controls the page actually used, so an agent
  // can walk results instead of guessing parameter names.
  if (input.pagination) {
    const { style, param } = input.pagination;
    const pagingParams: Array<[string, JsonSchema]> = [
      [param, style === 'cursor' ? { type: 'string', description: `Pagination cursor (${style}).` } : { type: 'integer', minimum: 1, description: `Page selector (${style}).` }],
    ];
    if (style !== 'cursor') pagingParams.push(['limit', { type: 'integer', minimum: 1, description: 'Maximum items to return.' }]);
    for (const [name, schema] of pagingParams) {
      if (properties[name] || paramLocations[name]) continue;
      properties[name] = schema;
      paramLocations[name] = 'query';
    }
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
