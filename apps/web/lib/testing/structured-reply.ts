/**
 * A fake model reply in the shape the structured seam asked for (packages/agent
 * structured.ts): a JSON output in a text block, or — when the request went out as a tool
 * because its schema has no grammar — the tool call. Request MECHANICS only; what the model
 * says is the cached eval's job (rule #8).
 */
interface StructuredRequestShape {
  tools?: { name?: string }[];
  output_config?: { format?: { schema?: { properties?: Record<string, unknown> } } };
}

export function structuredReply(
  request: unknown,
  toolName: string,
  input: unknown,
  usage: Record<string, number | null> = { input_tokens: 10, output_tokens: 5 },
) {
  const asTool = (request as StructuredRequestShape | undefined)?.tools?.some(
    (tool) => tool.name === toolName,
  );
  return asTool
    ? {
        content: [{ type: 'tool_use', id: `tu_${toolName}`, name: toolName, input }],
        stop_reason: 'tool_use',
        usage,
      }
    : { content: [{ type: 'text', text: JSON.stringify(input) }], stop_reason: 'end_turn', usage };
}

/**
 * Which structured stage a request is: the tool's name, or the JSON output's field names
 * (a JSON-output request names no tool). How a fake that answers two stages tells them apart.
 */
export function structuredFields(request: unknown): string[] {
  const shape = request as StructuredRequestShape | undefined;
  const tool = shape?.tools?.find((t) => t.name);
  if (tool?.name) return [tool.name];
  return Object.keys(shape?.output_config?.format?.schema?.properties ?? {});
}

/**
 * Whether a request is the structured stage `toolName`: that tool, or a JSON output whose
 * schema carries `field`.
 */
export function isStage(request: unknown, toolName: string, field: string): boolean {
  const fields = structuredFields(request);
  return fields.includes(toolName) || fields.includes(field);
}
