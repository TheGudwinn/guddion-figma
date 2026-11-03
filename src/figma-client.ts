import { DiskCache } from "./disk-cache.js";

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
  /** TTL дискового кэша в мс. 0 — кэш выключен. По умолчанию 5 минут. */
  cacheTtlMs?: number;
  /** Таймаут одного HTTP-запроса в мс — чтобы зависший запрос к Figma не вис бесконечно. По умолчанию 20 секунд. */
  timeoutMs?: number;
}

/**
 * Тонкий клиент Figma REST API. Делает точечные запросы (по nodeId, не по
 * всему файлу) и ретраит 429 с уважением к Retry-After — см.
 * memory/rest-api/rate-limits.md. Повторные GET-запросы кэшируются на диске
 * на время TTL, чтобы не дёргать API лишний раз при повторных вызовах одной
 * и той же ноды/файла.
 */
export class FigmaClient {
  private token: string;
  private maxRetries: number;
  private cache: DiskCache;
  private requestTimestamps: number[] = [];
  private timeoutMs: number;

  constructor(options: FigmaClientOptions) {
    this.token = options.token;
    this.maxRetries = options.maxRetries ?? 3;
    this.cache = new DiskCache(options.cacheTtlMs ?? 5 * 60 * 1000);
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  private async request<T>(
    path: string,
    query?: Record<string, string | number | undefined>,
    opts: { cache?: boolean } = {}
  ): Promise<T> {
    const url = new URL(FIGMA_API_BASE + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    const cacheKey = url.toString();
    const useCache = opts.cache ?? true;

    if (useCache) {
      const cached = this.cache.get<T>(cacheKey);
      if (cached !== undefined) return cached;
    }

    let attempt = 0;
    while (true) {
      this.requestTimestamps.push(Date.now());
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), this.timeoutMs);
      let res: Response;
      try {
        res = await fetch(cacheKey, {
          headers: { "X-Figma-Token": this.token },
          signal: controller.signal,
        });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          throw new FigmaApiError(`REST_TIMEOUT: Figma API не ответил за ${this.timeoutMs}мс на ${path}`, 0);
        }
        throw err;
      } finally {
        clearTimeout(abortTimer);
      }

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

      const json = (await res.json()) as T;
      if (useCache) this.cache.set(cacheKey, json);
      return json;
    }
  }

  /** Сколько запросов ушло к Figma API за последнюю минуту — Figma не публикует точные квоты по эндпоинтам, это просто фактический счётчик. */
  getRequestsLastMinute(): number {
    const cutoff = Date.now() - 60_000;
    this.requestTimestamps = this.requestTimestamps.filter((t) => t > cutoff);
    return this.requestTimestamps.length;
  }

  /** GET /v1/me — кто владелец токена и валиден ли он. */
  async getMe() {
    return this.request<{ email?: string; handle?: string }>(`/me`, undefined, { cache: false });
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

  /** GET /images/:key?ids=&format=&scale= — временная ссылка на рендер. Не кэшируется: каждый вызов должен отражать текущее состояние файла. */
  async exportImage(
    fileKey: string,
    nodeIds: string[],
    format: "png" | "svg" | "jpg" = "png",
    scale: number = 1
  ) {
    return this.request<FigmaImagesResponse>(
      `/images/${fileKey}`,
      { ids: nodeIds.join(","), format, scale },
      { cache: false }
    );
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
