const FIGMA_API_BASE = "https://api.figma.com/v1";

export class FigmaApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "FigmaApiError";
  }
}

export interface FigmaClientOptions {
  token: string;
  maxRetries?: number;
}

/**
 * Тонкий клиент Figma REST API. Делает точечные запросы (по nodeId, не по
 * всему файлу) и ретраит 429 с уважением к Retry-After — см.
 * memory/rest-api/rate-limits.md.
 */
export class FigmaClient {
  private token: string;
  private maxRetries: number;

  constructor(options: FigmaClientOptions) {
    this.token = options.token;
    this.maxRetries = options.maxRetries ?? 3;
  }

  private async request<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const url = new URL(FIGMA_API_BASE + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }

    let attempt = 0;
    while (true) {
      const res = await fetch(url.toString(), {
        headers: { "X-Figma-Token": this.token },
      });

      if (res.status === 429 && attempt < this.maxRetries) {
        const retryAfter = Number(res.headers.get("Retry-After") ?? "1");
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        attempt++;
        continue;
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new FigmaApiError(
          `Figma API ${res.status} on ${path}: ${body}`,
          res.status,
          res.status === 429 ? Number(res.headers.get("Retry-After") ?? undefined) : undefined
        );
      }

      return (await res.json()) as T;
    }
  }

  /** GET /files/:key/nodes?ids= — дерево конкретной ноды, не всего файла. */
  async getFileNodes(fileKey: string, nodeIds: string[]) {
    return this.request<FigmaNodesResponse>(`/files/${fileKey}/nodes`, {
      ids: nodeIds.join(","),
    });
  }

  /** GET /files/:key/styles — метаданные стилей файла. */
  async getFileStyles(fileKey: string) {
    return this.request<FigmaStylesResponse>(`/files/${fileKey}/styles`);
  }

  /** GET /files/:key/components + /component_sets */
  async getFileComponents(fileKey: string) {
    const [components, componentSets] = await Promise.all([
      this.request<FigmaComponentsResponse>(`/files/${fileKey}/components`),
      this.request<FigmaComponentSetsResponse>(`/files/${fileKey}/component_sets`),
    ]);
    return { components, componentSets };
  }

  /** GET /images/:key?ids=&format=&scale= — временная ссылка на рендер. */
  async exportImage(
    fileKey: string,
    nodeIds: string[],
    format: "png" | "svg" | "jpg" = "png",
    scale: number = 1
  ) {
    return this.request<FigmaImagesResponse>(`/images/${fileKey}`, {
      ids: nodeIds.join(","),
      format,
      scale,
    });
  }
}

// Минимальные типы ответов Figma REST API — только то, что реально используем.
export interface FigmaNodesResponse {
  name: string;
  nodes: Record<
    string,
    {
      document: Record<string, unknown>;
      styles?: Record<string, string>;
      components?: Record<string, unknown>;
    }
  >;
}

export interface FigmaStylesResponse {
  meta: {
    styles: Array<{
      key: string;
      name: string;
      description: string;
      style_type: string;
      node_id: string;
    }>;
  };
}

export interface FigmaComponentsResponse {
  meta: {
    components: Array<{
      key: string;
      name: string;
      description: string;
      node_id: string;
      component_set_id?: string;
    }>;
  };
}

export interface FigmaComponentSetsResponse {
  meta: {
    component_sets: Array<{
      key: string;
      name: string;
      description: string;
      node_id: string;
    }>;
  };
}

export interface FigmaImagesResponse {
  err: string | null;
  images: Record<string, string>;
}
