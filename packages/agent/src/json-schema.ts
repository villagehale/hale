import type { z } from 'zod';

/**
 * Zod → JSON Schema, for the wire.
 *
 * Every tool already carries a precise Zod schema that `invokeTool` enforces, but
 * none of it used to reach the model: the loop sent `{type:'object',
 * additionalProperties:true}` for every tool, so the model invented argument names
 * blind and paid a guess-and-retry round trip on a latency-bound SMS turn. This
 * converts the schema the tool already declares into the JSON Schema the model
 * should have been reading all along.
 *
 * The output is deliberately restricted to the subset Anthropic's grammar compiler
 * accepts for `strict: true` (docs: structured-outputs → JSON Schema limitations).
 * That subset matters because an unsupported keyword is a 400 at request time, not
 * a quiet degradation — `minimum`, `maximum`, `multipleOf`, `minLength`,
 * `maxLength`, `maxItems`, `uniqueItems` and `additionalProperties: true` all fail
 * the request. So they are never emitted.
 *
 * They are not silently dropped either. A stripped bound is restated in the
 * property's `description`, which the model reads, while Zod keeps enforcing it at
 * the boundary — the same split the official SDKs make. `pattern` is stripped for
 * the same reason with less margin: the compiler supports only a regex subset (no
 * lookaround, backreferences or word boundaries), and a 400 on the coach's hot path
 * is a worse trade than prose.
 *
 * An unknown Zod type THROWS rather than degrading to a permissive node — a tool
 * whose schema this cannot express is a schema to fix, and the sweep test over the
 * real registries turns that into a build-time failure instead of a prod one.
 */

/** One JSON Schema node. Untyped by design: it is a wire payload, not a domain type. */
export type JsonSchemaNode = Record<string, unknown>;

/** The root schema a tool's `input_schema` must be: a sealed object. */
export interface ToolInputSchema extends JsonSchemaNode {
  type: 'object';
  properties: Record<string, JsonSchemaNode>;
  required: string[];
  additionalProperties: false;
}

export interface CompiledToolSchema {
  schema: ToolInputSchema;
  /**
   * True iff every node was expressible in the strict subset — i.e. whether a
   * grammar can be compiled from it. False means the tool must ship its schema
   * WITHOUT `strict`, because the alternative is a 400. The flag is returned
   * rather than assumed so the decision is made from the schema itself and a new
   * offender surfaces in the sweep test, not in production.
   */
  strictSafe: boolean;
}

/**
 * Zod's runtime type tag. Read via `_def.typeName` rather than `instanceof`
 * because the tool registries live in apps/web and this converter in
 * packages/agent: under pnpm those can resolve to different `zod` copies, and
 * `instanceof` across copies is false for identical types. The string tag is
 * copy-agnostic.
 */
// biome-ignore lint/suspicious/noExplicitAny: reading Zod's internal _def, which is untyped across the version range.
type ZodDef = any;

function defOf(schema: z.ZodTypeAny): ZodDef {
  return (schema as unknown as { _def: ZodDef })._def;
}

function typeNameOf(schema: z.ZodTypeAny): string {
  return String(defOf(schema).typeName);
}

/** Join a `.describe()` note with the prose restatement of any stripped bound. */
function withDescription(node: JsonSchemaNode, parts: string[]): JsonSchemaNode {
  const text = parts.filter((p) => p.length > 0).join(' ');
  return text.length > 0 ? { ...node, description: text } : node;
}

/**
 * String bounds the grammar cannot express, restated for the model. `.uuid()` is
 * the exception: `format: 'uuid'` IS in the supported set, so it stays on the wire
 * where it actually constrains sampling.
 */
function stringNode(schema: z.ZodTypeAny): JsonSchemaNode {
  const node: JsonSchemaNode = { type: 'string' };
  const notes: string[] = [];

  for (const check of (defOf(schema).checks ?? []) as ZodDef[]) {
    switch (check.kind) {
      case 'uuid':
        node.format = 'uuid';
        break;
      case 'email':
        node.format = 'email';
        break;
      case 'url':
        node.format = 'uri';
        break;
      case 'datetime':
        node.format = 'date-time';
        break;
      case 'min':
        notes.push(`At least ${check.value} characters.`);
        break;
      case 'max':
        notes.push(`At most ${check.value} characters.`);
        break;
      case 'regex':
        notes.push(check.message ?? `Must match ${String(check.regex)}.`);
        break;
      default:
        notes.push(check.message ?? '');
        break;
    }
  }

  return withDescription(node, notes);
}

function numberNode(schema: z.ZodTypeAny): JsonSchemaNode {
  const checks = (defOf(schema).checks ?? []) as ZodDef[];
  const isInt = checks.some((c) => c.kind === 'int');
  const node: JsonSchemaNode = { type: isInt ? 'integer' : 'number' };
  const notes: string[] = [];

  for (const check of checks) {
    if (check.kind === 'min') notes.push(`At least ${check.value}.`);
    if (check.kind === 'max') notes.push(`At most ${check.value}.`);
  }

  return withDescription(node, notes);
}

/**
 * `minItems` is supported only for the values 0 and 1; anything else is a 400, so
 * a larger floor is restated in prose like the other stripped bounds.
 */
function arrayNode(schema: z.ZodTypeAny, path: string, state: { strictSafe: boolean }): JsonSchemaNode {
  const def = defOf(schema);
  const node: JsonSchemaNode = {
    type: 'array',
    items: compileNode(def.type, `${path}[]`, state),
  };
  const notes: string[] = [];

  const min = def.minLength?.value as number | undefined;
  if (min === 0 || min === 1) node.minItems = min;
  else if (typeof min === 'number') notes.push(`At least ${min} items.`);

  const max = def.maxLength?.value as number | undefined;
  if (typeof max === 'number') notes.push(`At most ${max} items.`);

  return withDescription(node, notes);
}

/** Add `'null'` to a node's type so a nullable value is expressible in the grammar. */
function asNullable(node: JsonSchemaNode): JsonSchemaNode {
  const current = node.type;
  if (Array.isArray(current)) {
    return current.includes('null') ? node : { ...node, type: [...current, 'null'] };
  }
  if (typeof current === 'string') {
    return { ...node, type: [current, 'null'] };
  }
  // No `type` to widen (an unconstrained node) — null is already permitted.
  return node;
}

function compileNode(
  schema: z.ZodTypeAny,
  path: string,
  state: { strictSafe: boolean },
): JsonSchemaNode {
  const typeName = typeNameOf(schema);
  const described = schema.description ?? '';

  const decorate = (node: JsonSchemaNode): JsonSchemaNode =>
    described.length > 0
      ? withDescription(node, [described, String(node.description ?? '')])
      : node;

  switch (typeName) {
    case 'ZodOptional':
      return compileNode(defOf(schema).innerType, path, state);
    case 'ZodNullable':
      return asNullable(compileNode(defOf(schema).innerType, path, state));
    case 'ZodDefault':
      return {
        ...compileNode(defOf(schema).innerType, path, state),
        default: defOf(schema).defaultValue(),
      };
    case 'ZodString':
      return decorate(stringNode(schema));
    case 'ZodNumber':
      return decorate(numberNode(schema));
    case 'ZodBoolean':
      return decorate({ type: 'boolean' });
    case 'ZodEnum':
      return decorate({ type: 'string', enum: [...(defOf(schema).values as string[])] });
    case 'ZodLiteral':
      return decorate({ const: defOf(schema).value });
    case 'ZodArray':
      return decorate(arrayNode(schema, path, state));
    case 'ZodObject':
      return decorate(compileObject(schema, path, state));
    case 'ZodUnion':
      return decorate({
        anyOf: (defOf(schema).options as z.ZodTypeAny[]).map((option, i) =>
          compileNode(option, `${path}|${i}`, state),
        ),
      });
    case 'ZodUnknown':
    case 'ZodAny':
      // "Any JSON" has no grammar. Emit an unconstrained node so the property is
      // still named on the wire, and disqualify the tool from `strict` so the
      // request is valid rather than a 400.
      state.strictSafe = false;
      return decorate({});
    default:
      throw new Error(
        `compileToolSchema: ${typeName} at '${path}' has no strict-mode JSON Schema form. Express the tool input with a supported type, or the model would be sent a schema it cannot satisfy.`,
      );
  }
}

function compileObject(
  schema: z.ZodTypeAny,
  path: string,
  state: { strictSafe: boolean },
): ToolInputSchema {
  const shape = defOf(schema).shape() as Record<string, z.ZodTypeAny>;
  const properties: Record<string, JsonSchemaNode> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    properties[key] = compileNode(value, path.length > 0 ? `${path}.${key}` : key, state);
    if (!value.isOptional()) required.push(key);
  }

  return { type: 'object', properties, required, additionalProperties: false };
}

/**
 * Compile a tool's Zod input schema into the JSON Schema sent as `input_schema`,
 * plus whether `strict: true` may accompany it.
 */
export function compileToolSchema(schema: z.ZodTypeAny): CompiledToolSchema {
  if (typeNameOf(schema) !== 'ZodObject') {
    throw new Error(
      `compileToolSchema: a tool's input schema must be a z.object(), got ${typeNameOf(schema)}.`,
    );
  }
  const state = { strictSafe: true };
  return { schema: compileObject(schema, '', state), strictSafe: state.strictSafe };
}
