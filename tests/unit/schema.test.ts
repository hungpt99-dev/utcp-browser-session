import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInputSchema,
  buildRequest,
  inferPathTemplate,
  mergeJsonSchema,
  pathParamNames,
  sanitizeName,
  shapeToJsonSchema,
  suggestToolName,
  validateArguments,
  type ShapeNode,
} from '../../packages/shared/src/schema.ts';

describe('inferPathTemplate', () => {
  it('templates numeric, uuid and hex identifiers', () => {
    assert.deepEqual(inferPathTemplate('/api/tasks/42'), { template: '/api/tasks/{id}', params: ['id'] });
    assert.deepEqual(inferPathTemplate('/api/tasks/42/comments/7'), {
      template: '/api/tasks/{id}/comments/{id2}',
      params: ['id', 'id2'],
    });
    assert.deepEqual(inferPathTemplate('/api/tasks/3f7a9b2c-1111-2222-3333-444455556666'), {
      template: '/api/tasks/{id}',
      params: ['id'],
    });
  });

  it('leaves static paths alone', () => {
    assert.deepEqual(inferPathTemplate('/api/tasks'), { template: '/api/tasks', params: [] });
    assert.deepEqual(inferPathTemplate('/api/v1/health'), { template: '/api/v1/health', params: [] });
  });

  it('strips the query before templating', () => {
    assert.equal(inferPathTemplate('/api/tasks/9?status=open').template, '/api/tasks/{id}');
  });
});

describe('suggestToolName', () => {
  it('derives stable snake_case names', () => {
    assert.equal(suggestToolName('GET', '/api/tasks'), 'list_tasks');
    assert.equal(suggestToolName('GET', '/api/tasks/{id}'), 'get_task');
    assert.equal(suggestToolName('POST', '/api/tasks'), 'create_task');
    assert.equal(suggestToolName('PATCH', '/api/tasks/{id}'), 'update_task');
    assert.equal(suggestToolName('DELETE', '/api/tasks/{id}'), 'delete_task');
    assert.equal(suggestToolName('GET', '/api/projects/{id}/summary'), 'get_summary');
  });

  it('sanitizes awkward names', () => {
    assert.equal(sanitizeName('Create Issue!'), 'create_issue');
    assert.equal(sanitizeName('123 go'), 'tool_123_go');
  });
});

describe('shapeToJsonSchema / mergeJsonSchema', () => {
  it('converts a tap shape into JSON Schema', () => {
    const shape: ShapeNode = {
      type: 'object',
      properties: {
        title: { type: 'string' },
        priority: { type: 'number' },
        done: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string' } },
        createdAt: { type: 'string', format: 'date-time' },
        nested: { type: 'object', properties: { a: { type: 'number' } } },
        nothing: { type: 'null' },
      },
    };
    const schema = shapeToJsonSchema(shape);
    assert.equal(schema.type, 'object');
    assert.equal(schema.properties?.title.type, 'string');
    assert.equal(schema.properties?.tags.items?.type, 'string');
    assert.equal(schema.properties?.createdAt.format, 'date-time');
    assert.equal(schema.properties?.nested.type, 'object');
    assert.equal(schema.additionalProperties, true);
  });

  it('merges repeated observations without losing fields', () => {
    const a = shapeToJsonSchema({ type: 'object', properties: { id: { type: 'number' } } });
    const b = shapeToJsonSchema({ type: 'object', properties: { id: { type: 'number' }, name: { type: 'string' } } });
    const merged = mergeJsonSchema(a, b);
    assert.deepEqual(Object.keys(merged.properties ?? {}).sort(), ['id', 'name']);
  });

  it('widens conflicting types instead of dropping one', () => {
    const merged = mergeJsonSchema({ type: 'string' }, { type: 'number' });
    assert.deepEqual(merged.type, ['string', 'number']);
  });
});

describe('buildInputSchema', () => {
  it('binds path params as required strings and query params as optional', () => {
    const built = buildInputSchema({
      method: 'GET',
      pathTemplate: '/api/tasks/{id}',
      queryKeys: ['status', 'limit'],
      bodySchema: undefined,
    });
    assert.deepEqual(built.schema.required, ['id']);
    assert.equal(built.paramLocations.id, 'path');
    assert.equal(built.paramLocations.status, 'query');
    assert.equal(built.schema.properties?.status.type, 'string');
    assert.equal(built.schema.additionalProperties, false);
  });

  it('inlines body properties for write methods', () => {
    const built = buildInputSchema({
      method: 'POST',
      pathTemplate: '/api/tasks',
      queryKeys: [],
      bodySchema: shapeToJsonSchema({ type: 'object', properties: { title: { type: 'string' } } }),
    });
    assert.equal(built.paramLocations.title, 'body');
    assert.equal(built.requiredBody, true);
    assert.equal(built.schema.properties?.title.type, 'string');
  });
});

describe('validateArguments', () => {
  const schema = buildInputSchema({
    method: 'POST',
    pathTemplate: '/api/tasks/{id}',
    queryKeys: ['limit'],
    bodySchema: shapeToJsonSchema({ type: 'object', properties: { title: { type: 'string' }, priority: { type: 'number' } } }),
  });

  it('accepts matching arguments and coerces URL scalars', () => {
    const result = validateArguments(schema.schema, { id: 4, limit: 10, title: 'x', priority: 2 }, schema.paramLocations);
    assert.equal(result.ok, true);
    assert.equal(result.value.id, '4');
    assert.equal(result.value.limit, '10');
    assert.equal(result.value.priority, 2);
  });

  it('rejects unknown parameters instead of passing them through', () => {
    const result = validateArguments(schema.schema, { id: '1', title: 'x', evil: true }, schema.paramLocations);
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /Unknown parameter "evil"/);
  });

  it('rejects missing required and wrong types', () => {
    const missing = validateArguments(schema.schema, { title: 'x' }, schema.paramLocations);
    assert.equal(missing.ok, false);
    const wrong = validateArguments(schema.schema, { id: '1', priority: 'high' }, schema.paramLocations);
    assert.equal(wrong.ok, false);
    assert.match(wrong.errors.join(' '), /must be of type number/);
  });

  it('rejects non-object arguments', () => {
    assert.equal(validateArguments(schema.schema, 'nope').ok, false);
    assert.equal(validateArguments(schema.schema, []).ok, false);
  });
});

describe('buildRequest', () => {
  it('builds path, query and body from recorded locations', () => {
    const built = buildRequest(
      {
        pathTemplate: '/api/tasks/{id}',
        method: 'PATCH',
        paramLocations: { id: 'path', limit: 'query', title: 'body' },
      },
      { id: 'a b', limit: '5', title: 'hello' },
    );
    assert.equal(built.path, '/api/tasks/a%20b');
    assert.equal(built.query, 'limit=5');
    assert.deepEqual(built.body, { title: 'hello' });
  });

  it('leaves an unsupplied template slot visible rather than silently dropping it', () => {
    const built = buildRequest({ pathTemplate: '/api/{id}', method: 'GET', paramLocations: {} }, {});
    assert.equal(built.path, '/api/{id}');
  });

  it('never puts body fields into the query string', () => {
    const built = buildRequest({ pathTemplate: '/api/x', method: 'POST', paramLocations: { a: 'body' } }, { a: 'v' });
    assert.equal(built.query, '');
    assert.deepEqual(built.body, { a: 'v' });
  });
});

describe('pathParamNames', () => {
  it('extracts names in order', () => {
    assert.deepEqual(pathParamNames('/a/{x}/b/{y2}'), ['x', 'y2']);
  });
});
