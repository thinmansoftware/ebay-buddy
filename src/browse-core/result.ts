export function toolOk(data: Record<string, unknown>, resourceUri?: string, maxBytes?: number) {
  if (maxBytes && Buffer.byteLength(JSON.stringify(data)) > maxBytes)
    return toolError(new Error("Response too large"), true);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
    ...(resourceUri ? { _meta: { ui: { resourceUri } } } : {}),
  };
}

export function toolError(error: unknown, safe = false) {
  const message = safe
    ? "eBay request could not be completed. Check server configuration, provider access, or request limits."
    : error instanceof Error
      ? error.message
      : "Tool failed";
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}
