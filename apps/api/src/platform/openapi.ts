import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { parse } from 'yaml';

/**
 * Loads openapi/domesday.yaml and turns each operation into the JSON Schemas
 * Fastify validates requests with. The specification is the single source of
 * truth: there are no hand-written request schemas anywhere else.
 */

export const SPEC_PATH = fileURLToPath(new URL('../../openapi/domesday.yaml', import.meta.url));

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonSchema = { [key: string]: Json };

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
const METHODS: readonly HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete'];
const WRITE_METHODS: readonly HttpMethod[] = ['post', 'put', 'patch', 'delete'];

/** An object a route must be allowed to see before its handler runs (x-domesday-objects). */
export interface ObjectRef {
  readonly in: 'path' | 'query' | 'body';
  /** A parameter name, or a dotted path into the body such as "scope.siteId". */
  readonly name: string;
  readonly type: string;
  readonly many?: boolean;
}

export interface OperationSpec {
  readonly operationId: string;
  readonly method: HttpMethod;
  /** As written in the specification: /clips/{clipId}/confirm */
  readonly path: string;
  /** As Fastify routes it, without the server prefix: /clips/:clipId/confirm */
  readonly routePath: string;
  /** The owning module (the operation's tag). */
  readonly module: string;
  readonly isPublic: boolean;
  readonly isWrite: boolean;
  readonly permission: string | null;
  readonly objects: readonly ObjectRef[];
  readonly schemas: {
    readonly params?: JsonSchema;
    readonly querystring?: JsonSchema;
    readonly headers?: JsonSchema;
    readonly body?: JsonSchema;
  };
  /** Response schemas by status code, for tests that check responses against the contract. */
  readonly responses: Readonly<Record<string, JsonSchema | undefined>>;
}

export interface LoadedSpec {
  readonly document: JsonSchema;
  readonly basePath: string;
  readonly operations: readonly OperationSpec[];
  /** components.schemas as one JSON Schema document, for Ajv. */
  readonly schemaDocument: JsonSchema;
}

export const SCHEMA_DOCUMENT_ID = 'urn:domesday:schemas';
const COMPONENT_REF = '#/components/schemas/';

function isObject(value: unknown): value is { [key: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Point component references at the shared schema document, either from outside it or within it. */
function rewriteRefs(value: Json, prefix: string): Json {
  if (Array.isArray(value)) return value.map((v) => rewriteRefs(v, prefix));
  if (!isObject(value)) return value;
  const out: { [key: string]: Json } = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '$ref' && typeof child === 'string' && child.startsWith(COMPONENT_REF)) {
      out[key] = `${prefix}${child.slice(COMPONENT_REF.length)}`;
    } else {
      out[key] = rewriteRefs(child, prefix);
    }
  }
  return out;
}

const external = (schema: Json): JsonSchema => rewriteRefs(schema, `${SCHEMA_DOCUMENT_ID}#/$defs/`) as JsonSchema;

function resolveParameter(document: JsonSchema, parameter: Json): JsonSchema {
  if (isObject(parameter) && typeof parameter.$ref === 'string') {
    const name = parameter.$ref.replace('#/components/parameters/', '');
    const components = document.components as { [k: string]: Json } | undefined;
    const resolved = (components?.parameters as { [k: string]: Json } | undefined)?.[name];
    if (!isObject(resolved)) throw new Error(`unknown parameter reference ${parameter.$ref}`);
    return resolved;
  }
  if (!isObject(parameter)) throw new Error('parameter must be an object');
  return parameter;
}

export function loadSpec(path: string = SPEC_PATH): LoadedSpec {
  const document = parse(readFileSync(path, 'utf8')) as JsonSchema;
  const servers = document.servers as { url: string }[] | undefined;
  const basePath = servers?.[0]?.url ?? '';
  const paths = (document.paths ?? {}) as { [path: string]: { [method: string]: Json } };
  const globalSecurity = document.security as Json[] | undefined;
  const operations: OperationSpec[] = [];

  for (const [path, item] of Object.entries(paths)) {
    for (const method of METHODS) {
      const op = item[method];
      if (!isObject(op)) continue;
      const operationId = String(op.operationId);
      const tags = (op.tags as string[] | undefined) ?? [];
      const security = (op.security as Json[] | undefined) ?? globalSecurity ?? [];
      const parameters = [...((item.parameters as Json[] | undefined) ?? []), ...((op.parameters as Json[] | undefined) ?? [])].map((p) =>
        resolveParameter(document, p),
      );

      const group = (where: string) => {
        const list = parameters.filter((p) => p.in === where);
        if (list.length === 0) return undefined;
        const properties: { [k: string]: Json } = {};
        const required: string[] = [];
        for (const p of list) {
          const name = where === 'header' ? String(p.name).toLowerCase() : String(p.name);
          properties[name] = external(p.schema ?? {});
          if (p.required === true) required.push(name);
        }
        return { type: 'object', properties, required, additionalProperties: where === 'header' } as JsonSchema;
      };

      const requestBody = op.requestBody as { content?: { [type: string]: { schema?: Json } } } | undefined;
      const bodySchema = requestBody?.content?.['application/json']?.schema;
      const responses: Record<string, JsonSchema | undefined> = {};
      for (const [status, response] of Object.entries((op.responses ?? {}) as { [k: string]: Json })) {
        let r = response;
        if (isObject(r) && typeof r.$ref === 'string') {
          const name = r.$ref.replace('#/components/responses/', '');
          r = ((document.components as { [k: string]: Json }).responses as { [k: string]: Json })[name] ?? null;
        }
        const content = isObject(r) ? (r.content as { [type: string]: { schema?: Json } } | undefined) : undefined;
        const schema = content?.['application/json']?.schema ?? content?.['application/problem+json']?.schema;
        responses[status] = schema === undefined ? undefined : external(schema);
      }

      operations.push({
        operationId,
        method,
        path,
        routePath: path.replace(/\{([^}]+)\}/g, ':$1'),
        module: tags[0] ?? '',
        isPublic: security.length === 0,
        isWrite: WRITE_METHODS.includes(method),
        permission: typeof op['x-domesday-permission'] === 'string' ? op['x-domesday-permission'] : null,
        objects: ((op['x-domesday-objects'] as unknown as ObjectRef[] | undefined) ?? []).map((o) => ({ ...o })),
        schemas: {
          params: group('path'),
          querystring: group('query'),
          headers: group('header'),
          body: bodySchema === undefined ? undefined : external(bodySchema),
        },
        responses,
      });
    }
  }

  const components = (document.components as { schemas?: { [k: string]: Json } } | undefined)?.schemas ?? {};
  const schemaDocument = {
    $id: SCHEMA_DOCUMENT_ID,
    $defs: rewriteRefs(components, '#/$defs/'),
  } as JsonSchema;
  return { document, basePath, operations, schemaDocument };
}

// ajv-formats is published as CommonJS; take the callable from either export shape.
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as (ajv: Ajv2020) => Ajv2020;

/** OpenAPI keywords that are annotations only. */
const OPENAPI_ANNOTATIONS = ['example', 'discriminator', 'xml', 'externalDocs'];

function createAjv(spec: LoadedSpec, coerceTypes: false | 'array'): Ajv2020 {
  const ajv = new Ajv2020({
    strict: true,
    strictTypes: false,
    // if/then may require a property declared outside the then block; that is valid JSON Schema.
    strictRequired: false,
    allowUnionTypes: true,
    allErrors: false,
    coerceTypes,
    useDefaults: true,
  });
  addFormats(ajv);
  for (const keyword of OPENAPI_ANNOTATIONS) ajv.addKeyword(keyword);
  ajv.addSchema(spec.schemaDocument);
  return ajv;
}

export interface Validators {
  /** For JSON bodies: no type coercion. */
  readonly body: Ajv2020;
  /** For path, query and header values, which arrive as text. */
  readonly text: Ajv2020;
}

export function createValidators(spec: LoadedSpec): Validators {
  return { body: createAjv(spec, false), text: createAjv(spec, 'array') };
}

/** Validates a response body against the specification. Used by tests to hold responses to the contract. */
export function compileResponseValidator(validators: Validators, schema: JsonSchema): ValidateFunction {
  return validators.body.compile(schema);
}
