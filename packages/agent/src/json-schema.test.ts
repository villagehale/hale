import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { compileToolSchema } from './json-schema.js';

/**
 * The converter's contract is the STRICT-MODE JSON Schema subset Anthropic's
 * grammar compiler accepts, so the expected values here are derived from that
 * published subset — not from what the code happens to emit:
 *
 *   supported   type / properties / required / additionalProperties:false /
 *               enum / const / items / anyOf / default / description /
 *               format (date-time,time,date,duration,email,hostname,uri,
 *               ipv4,ipv6,uuid) / minItems (0 or 1 only)
 *   UNSUPPORTED minimum, maximum, multipleOf, minLength, maxLength,
 *               maxItems, uniqueItems, additionalProperties:true, recursion
 *
 * An unsupported keyword is a 400 at request time, not a degradation, so the
 * converter must never emit one — and the constraint must not be silently lost
 * either: it is carried into `description`, which the model does read, while
 * the tool's Zod schema keeps enforcing it at `invokeTool`.
 */

describe('compileToolSchema', () => {
  it('emits properties, required and additionalProperties:false for a multi-arg tool', () => {
    const { schema } = compileToolSchema(
      z.object({
        title: z.string(),
        date: z.string(),
        location: z.string().optional(),
      }),
    );

    expect(schema).toEqual({
      type: 'object',
      properties: {
        title: { type: 'string' },
        date: { type: 'string' },
        location: { type: 'string' },
      },
      required: ['title', 'date'],
      additionalProperties: false,
    });
  });

  it('emits an empty required array rather than omitting it for a no-arg tool', () => {
    const { schema } = compileToolSchema(z.object({}));

    expect(schema).toEqual({
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    });
  });

  it('maps enum, boolean, integer and array shapes onto their JSON Schema types', () => {
    const { schema } = compileToolSchema(
      z.object({
        kind: z.enum(['medical', 'routine']),
        flag: z.boolean(),
        count: z.number().int(),
        ratio: z.number(),
        ids: z.array(z.string()),
      }),
    );

    expect(schema.properties).toEqual({
      kind: { type: 'string', enum: ['medical', 'routine'] },
      flag: { type: 'boolean' },
      count: { type: 'integer' },
      ratio: { type: 'number' },
      ids: { type: 'array', items: { type: 'string' } },
    });
  });

  it('emits format:uuid, which the strict compiler supports', () => {
    const { schema } = compileToolSchema(z.object({ childId: z.string().uuid() }));

    expect(schema.properties.childId).toEqual({ type: 'string', format: 'uuid' });
  });

  it('strips minLength/maxLength/pattern from the wire and states them in the description', () => {
    const { schema } = compileToolSchema(
      z.object({
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD in the family’s own calendar')
          .max(10),
      }),
    );

    const date = schema.properties.date as Record<string, unknown>;
    expect(date.type).toBe('string');
    expect(date).not.toHaveProperty('pattern');
    expect(date).not.toHaveProperty('minLength');
    expect(date).not.toHaveProperty('maxLength');
    expect(date.description).toContain('date must be YYYY-MM-DD in the family’s own calendar');
    expect(date.description).toContain('10');
  });

  it('strips minimum/maximum from the wire and states them in the description', () => {
    const { schema } = compileToolSchema(
      z.object({ confidence: z.number().min(0).max(1) }),
    );

    const confidence = schema.properties.confidence as Record<string, unknown>;
    expect(confidence).toEqual({
      type: 'number',
      description: 'At least 0. At most 1.',
    });
  });

  it('keeps a .describe() note and appends the stripped constraint after it', () => {
    const { schema } = compileToolSchema(
      z.object({ weekOffset: z.number().int().min(0).max(1).describe('0 = this week.') }),
    );

    expect(schema.properties.weekOffset).toEqual({
      type: 'integer',
      description: '0 = this week. At least 0. At most 1.',
    });
  });

  it('treats .optional() as absent-from-required and .nullable() as a null-able type', () => {
    const { schema } = compileToolSchema(
      z.object({
        a: z.string().optional(),
        b: z.string().nullable(),
        c: z.string().nullish(),
      }),
    );

    expect(schema.required).toEqual(['b']);
    expect(schema.properties.a).toEqual({ type: 'string' });
    expect(schema.properties.b).toEqual({ type: ['string', 'null'] });
    expect(schema.properties.c).toEqual({ type: ['string', 'null'] });
  });

  it('recurses into nested objects, sealing each level', () => {
    const { schema } = compileToolSchema(
      z.object({ window: z.object({ start: z.string(), end: z.string().optional() }) }),
    );

    expect(schema.properties.window).toEqual({
      type: 'object',
      properties: { start: { type: 'string' }, end: { type: 'string' } },
      required: ['start'],
      additionalProperties: false,
    });
  });

  it('reports strictSafe for a fully expressible schema', () => {
    const { strictSafe } = compileToolSchema(
      z.object({ query: z.string(), factType: z.enum(['a', 'b']).optional() }),
    );

    expect(strictSafe).toBe(true);
  });

  it('reports NOT strictSafe for an unconstrained value, and still emits the rest', () => {
    const { schema, strictSafe } = compileToolSchema(
      z.object({ factKey: z.string(), factValue: z.unknown() }),
    );

    // A grammar cannot be compiled for "any JSON", so this tool must ship its
    // schema without `strict` rather than 400 at request time.
    expect(strictSafe).toBe(false);
    expect(schema.properties.factValue).toEqual({});
    expect(schema.properties.factKey).toEqual({ type: 'string' });
    // z.unknown() is optional in Zod, so it is not a required property.
    expect(schema.required).toEqual(['factKey']);
  });

  it('throws on a Zod type it cannot express rather than emitting a wrong schema', () => {
    expect(() => compileToolSchema(z.object({ bag: z.record(z.string()) }))).toThrow(
      /ZodRecord/,
    );
  });

  it('throws when the tool root is not an object', () => {
    expect(() => compileToolSchema(z.string())).toThrow(/object/i);
  });
});
