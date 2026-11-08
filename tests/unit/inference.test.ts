import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  accumConfidence,
  accumShape,
  accumToSchema,
  mergeAccum,
  type SchemaAccum,
} from '../../packages/shared/src/schema.ts';
import {
  detectKind,
  detectPagination,
  scoreConfidence,
  isBlockedPath,
} from '../../packages/shared/src/discovery.ts';

const object = (properties: Record<string, unknown>) => ({ type: 'object', properties }) as never;

describe('schema accumulation', () => {
  it('marks a field required only when every observation had it', () => {
    let accum: SchemaAccum | null = accumShape(null, object({ id: { type: 'number' }, title: { type: 'string' } }));
    accum = accumShape(accum, object({ id: { type: 'number' }, title: { type: 'string' } }));
    accum = accumShape(accum, object({ id: { type: 'number' } }));

    const schema = accumToSchema(accum!);
    assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), ['id', 'title']);
    assert.deepEqual(schema.required, ['id'], 'title was missing once, so it is optional');
    assert.equal(schema.additionalProperties, false);
  });

  it('requires nothing from a single sample', () => {
    const accum = accumShape(null, object({ id: { type: 'number' }, title: { type: 'string' } }));
    const schema = accumToSchema(accum);
    assert.equal(schema.required, undefined, 'one observation is not enough to require a field');
  });

  it('keeps nullable fields visible instead of widening to any', () => {
    let accum = accumShape(null, object({ closedAt: { type: 'string' } }));
    accum = accumShape(accum, object({ closedAt: { type: 'null' } }));
    const schema = accumToSchema(accum);
    const closedAt = schema.properties?.closedAt;
    assert.deepEqual(closedAt?.type, ['string', 'null']);
    assert.equal(closedAt?.nullable, true);
  });

  it('records heterogeneous types as a union', () => {
    let accum = accumShape(null, object({ id: { type: 'number' } }));
    accum = accumShape(accum, object({ id: { type: 'string' } }));
    assert.deepEqual(accumToSchema(accum).properties?.id.type, ['number', 'string']);
  });

  it('handles nested objects and arrays of objects', () => {
    const shape = object({
      items: { type: 'array', items: object({ id: { type: 'number' }, tags: { type: 'array', items: { type: 'string' } } }) },
    });
    const schema = accumToSchema(accumShape(null, shape));
    const items = schema.properties?.items;
    assert.equal(items?.type, 'array');
    assert.equal(items?.items?.type, 'object');
    assert.equal(items?.items?.properties?.tags.type, 'array');
    assert.equal(items?.items?.properties?.tags.items?.type, 'string');
  });

  it('turns a small closed value set into an enum', () => {
    let accum = accumShape(null, object({ status: { type: 'string' } }), { status: ['open'] });
    accum = accumShape(accum, object({ status: { type: 'string' } }), { status: ['done'] });
    const status = accumToSchema(accum).properties?.status;
    assert.deepEqual(status?.enum, ['done', 'open']);
    assert.equal(status?.type, 'string');
  });

  it('drops an enum once the value set is too wide', () => {
    let accum = accumShape(null, object({ status: { type: 'string' } }), { status: ['a'] });
    accum = accumShape(accum, object({ status: { type: 'string' } }), { status: ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] });
    assert.equal(accumToSchema(accum).properties?.status.enum, undefined);
  });

  it('merges accumulators without losing counts', () => {
    const a = accumShape(null, object({ id: { type: 'number' } }));
    const b = accumShape(null, object({ id: { type: 'number' }, extra: { type: 'boolean' } }));
    const merged = mergeAccum(a, b)!;
    assert.equal(merged.n, 2);
    assert.deepEqual(Object.keys(accumToSchema(merged).properties ?? {}).sort(), ['extra', 'id']);
  });

  it('scores confidence from sample count and shape stability', () => {
    const once = accumShape(null, object({ id: { type: 'number' } }));
    let thrice = once;
    for (let index = 0; index < 2; index += 1) thrice = accumShape(thrice, object({ id: { type: 'number' } }));
    assert.ok(accumConfidence(thrice) > accumConfidence(once));
    assert.equal(accumConfidence(null), 0);
  });
});

describe('discovery heuristics', () => {
  it('detects GraphQL from the body envelope', () => {
    const kind = detectKind({
      method: 'POST',
      path: '/api',
      requestShape: object({ query: { type: 'string' }, operationName: { type: 'string' } }),
    });
    assert.equal(kind.kind, 'graphql');
  });

  it('detects uploads, streams and downloads from content type', () => {
    assert.equal(detectKind({ method: 'POST', path: '/f', contentType: 'multipart/form-data; boundary=x' }).kind, 'upload');
    assert.equal(detectKind({ method: 'GET', path: '/e', contentType: 'text/event-stream' }).kind, 'stream');
    assert.equal(detectKind({ method: 'GET', path: '/r', contentType: 'text/csv' }).kind, 'download');
    assert.equal(detectKind({ method: 'GET', path: '/api/x', contentType: 'application/json' }).kind, 'rest');
  });

  it('detects pagination styles from query keys and response fields', () => {
    const page = detectPagination(['page', 'per_page'], object({ items: { type: 'array' }, total: { type: 'number' } }));
    assert.equal(page?.style, 'page');
    assert.equal(page?.hasTotal, true);

    const cursor = detectPagination(['cursor'], object({ items: { type: 'array' }, nextCursor: { type: 'string' } }));
    assert.equal(cursor?.style, 'cursor');
    assert.equal(cursor?.nextField, 'nextCursor');

    const offset = detectPagination(['offset'], object({ items: { type: 'array' } }));
    assert.equal(offset?.style, 'offset');

    assert.equal(detectPagination(['limit'], object({ items: { type: 'array' } })), null, 'a limit alone is not paging');
    assert.equal(detectPagination([], null), null);
  });

  it('scores sparse evidence lower than repeated evidence', () => {
    const sparse = scoreConfidence({
      sampleCount: 1,
      sources: ['webRequest'],
      hasRequestSchema: false,
      hasResponseSchema: false,
      classificationConfident: true,
      statusCodes: [200],
      kind: 'rest',
    });
    const rich = scoreConfidence({
      sampleCount: 4,
      sources: ['webRequest', 'page-tap'],
      hasRequestSchema: true,
      hasResponseSchema: true,
      classificationConfident: true,
      statusCodes: [200],
      kind: 'rest',
    });
    assert.ok(rich > sparse);
    assert.ok(sparse < 0.45, 'a single webRequest sample needs review');
    assert.ok(rich >= 0.8);
  });

  it('matches blocked path prefixes exactly, not by substring', () => {
    assert.equal(isBlockedPath('/admin/users', ['/admin']), true);
    assert.equal(isBlockedPath('/admin', ['/admin']), true);
    assert.equal(isBlockedPath('/administrator', ['/admin']), false);
  });
});
