/**
 * Discovery heuristics: what kind of operation was observed, whether it paginates,
 * and how much to trust the observation.
 *
 * Everything here is deliberately explainable — each decision also returns the
 * evidence that produced it, so the dashboard can show a reviewer *why* an
 * endpoint is classified the way it is.
 */
import type { PaginationInfo } from './protocol.ts';
import { type JsonSchema, type ShapeNode } from './schema.ts';

export type EndpointKind = 'rest' | 'graphql' | 'upload' | 'download' | 'stream' | 'unknown';

const GRAPHQL_FIELDS = ['query', 'operationName', 'variables'];
const STREAM_TYPES = ['text/event-stream'];
const DOWNLOAD_TYPES = [
  'text/csv',
  'application/pdf',
  'application/zip',
  'application/octet-stream',
  'application/gzip',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument',
];

export function detectKind(input: {
  method: string;
  path: string;
  contentType?: string | null;
  requestShape?: ShapeNode | null;
}): { kind: EndpointKind; reason: string } {
  const contentType = (input.contentType ?? '').toLowerCase();
  const method = input.method.toUpperCase();
  const path = input.path.toLowerCase();

  if (path.endsWith('/graphql') || path.endsWith('/gql')) {
    return { kind: 'graphql', reason: 'Path is a GraphQL endpoint.' };
  }
  const props = input.requestShape?.properties;
  if (props) {
    const matches = GRAPHQL_FIELDS.filter((field) => field in props);
    if (matches.length >= 2) {
      return { kind: 'graphql', reason: `Request body carries GraphQL envelope fields (${matches.join(', ')}).` };
    }
  }
  if (contentType.includes('multipart/form-data')) {
    return { kind: 'upload', reason: 'Multipart form upload.' };
  }
  if (method === 'POST' && contentType.includes('application/octet-stream')) {
    return { kind: 'upload', reason: 'Binary POST body.' };
  }
  if (STREAM_TYPES.some((type) => contentType.includes(type))) {
    return { kind: 'stream', reason: 'Server-sent events.' };
  }
  if (method === 'GET' && DOWNLOAD_TYPES.some((type) => contentType.includes(type))) {
    return { kind: 'download', reason: `Download content type (${contentType.split(';')[0]}).` };
  }
  if (contentType.includes('json') || !contentType) {
    return { kind: 'rest', reason: 'JSON request/response.' };
  }
  return { kind: 'unknown', reason: `Unrecognised content type (${contentType.split(';')[0]}).` };
}

/** Operations we cannot execute faithfully are discovered but never exposed. */
export const UNSUPPORTED_KINDS: ReadonlySet<EndpointKind> = new Set(['upload', 'stream']);

const CURSOR_KEYS = ['cursor', 'after', 'before', 'starting_after', 'ending_before', 'page_token', 'pageToken', 'next'];
const OFFSET_KEYS = ['offset', 'skip', 'start', 'startIndex'];
const PAGE_KEYS = ['page', 'pageNumber', 'page_number', 'p', 'pageIndex'];
const LIMIT_KEYS = ['limit', 'per_page', 'perPage', 'page_size', 'pageSize', 'size', 'count', 'first', 'top'];
const TOTAL_FIELDS = ['total', 'totalCount', 'total_count', 'count', 'totalResults', 'total_results', 'totalItems'];
const NEXT_FIELDS = ['next', 'nextCursor', 'next_cursor', 'nextPage', 'next_page', 'nextPageToken', 'nextLink', 'next_link', 'continuation'];

/**
 * Detect pagination from the query keys the page used and the shape of the
 * response. Only reports a style when the evidence is unambiguous: a `limit`
 * alone is a cap, not proof of paging.
 */
export function detectPagination(queryKeys: string[], responseShape?: ShapeNode | null): PaginationInfo | null {
  const keys = queryKeys ?? [];
  const lower = keys.map((key) => key.toLowerCase());
  const find = (candidates: string[]): string | null => {
    for (const candidate of candidates) {
      const index = lower.indexOf(candidate.toLowerCase());
      if (index >= 0) return keys[index];
    }
    return null;
  };

  const cursor = find(CURSOR_KEYS);
  const offset = find(OFFSET_KEYS);
  const page = find(PAGE_KEYS);
  const limit = find(LIMIT_KEYS);
  if (!cursor && !offset && !page) return null;

  const props = responseShape?.properties ?? {};
  const hasTotal = TOTAL_FIELDS.some((field) => field in props);
  const nextField = NEXT_FIELDS.find((field) => field in props) ?? null;

  const style: PaginationInfo['style'] = cursor ? 'cursor' : offset ? 'offset' : 'page';
  const param = (cursor ?? offset ?? page ?? limit)!;
  return { style, param, hasTotal, nextField };
}

export interface ConfidenceInput {
  sampleCount: number;
  sources: string[];
  hasRequestSchema: boolean;
  hasResponseSchema: boolean;
  classificationConfident: boolean;
  statusCodes: number[];
  kind: EndpointKind;
}

/**
 * Confidence that this endpoint record is complete enough to generate a tool
 * without a human second-guessing the schema. Weighted so that a single
 * page-tap sample cannot reach "high" on its own.
 */
export function scoreConfidence(input: ConfidenceInput): number {
  let score = 0;
  score += Math.min(input.sampleCount, 4) * 0.12; // up to 0.48
  if (input.sources.includes('webRequest')) score += 0.12;
  if (input.sources.includes('page-tap')) score += 0.08;
  if (input.hasRequestSchema) score += 0.1;
  if (input.hasResponseSchema) score += 0.12;
  if (input.classificationConfident) score += 0.1;
  const successOnly = input.statusCodes.length > 0 && input.statusCodes.every((status) => status >= 200 && status < 300);
  if (successOnly) score += 0.06;
  if (input.kind === 'unknown' || input.kind === 'stream' || input.kind === 'upload') score -= 0.15;
  return Math.max(0, Math.min(1, Math.round(score * 100) / 100));
}

/** Threshold below which a generated tool is flagged for mandatory review. */
export const REVIEW_THRESHOLD = 0.45;

export function isBlockedPath(path: string, prefixes: string[]): boolean {
  if (!prefixes || prefixes.length === 0) return false;
  return prefixes.some((prefix) => {
    const clean = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
    return path === clean || path.startsWith(`${clean}/`);
  });
}

/** Pull an enum-like value set out of a shape, for enum sampling. */
export function enumFieldsFromShape(node: ShapeNode | undefined, out: string[] = []): string[] {
  if (!node?.properties) return out;
  for (const [key, child] of Object.entries(node.properties)) {
    if (child.type === 'string' || child.type === 'number') out.push(key);
    else enumFieldsFromShape(child, out);
  }
  return out;
}

/** True when a response schema looks like a list envelope (used by classifiers). */
export function responseIsArray(schema: JsonSchema | null | undefined): boolean {
  if (!schema) return false;
  if (schema.type === 'array') return true;
  if (schema.type === 'object' && schema.properties) {
    return Object.values(schema.properties).some((child) => child.type === 'array');
  }
  return false;
}
