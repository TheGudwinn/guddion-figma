export interface ResolvedFigmaLink {
  fileKey: string;
  nodeId?: string;
}

/**
 * Разбирает ссылку Figma вида:
 *   https://www.figma.com/design/<fileKey>/<name>?node-id=123-456
 *   https://www.figma.com/file/<fileKey>/<name>?node-id=123-456
 * node-id в ссылке использует "-", в REST API нужен ":" — см.
 * memory/rest-api/endpoints.md.
 */
export function resolveFigmaLink(url: string): ResolvedFigmaLink {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Невалидный URL: ${url}`);
  }

  const match = parsed.pathname.match(/\/(?:design|file|proto)\/([a-zA-Z0-9]+)/);
  if (!match) {
    throw new Error(
      `Не удалось найти fileKey в ссылке. Ожидался путь вида /design/<fileKey>/... или /file/<fileKey>/...: ${url}`
    );
  }
  const fileKey = match[1];

  const rawNodeId = parsed.searchParams.get("node-id");
  const nodeId = rawNodeId ? rawNodeId.replace("-", ":") : undefined;

  return { fileKey, nodeId };
}
