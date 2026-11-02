import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = join(projectRoot, ".cache");

interface CacheEntry<T> {
  storedAt: number;
  value: T;
}

/**
 * Простой дисковый кэш для REST-ответов Figma, ключ — хэш от URL. Снижает
 * число повторных запросов к одному и тому же эндпоинту в пределах TTL —
 * не ради скорости, а чтобы не упираться в rate limit при повторных вызовах
 * одного и того же узла/файла.
 */
export class DiskCache {
  private ttlMs: number;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
    if (ttlMs > 0 && !existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
  }

  private pathFor(key: string): string {
    const hash = createHash("sha1").update(key).digest("hex");
    return join(cacheDir, `${hash}.json`);
  }

  get<T>(key: string): T | undefined {
    if (this.ttlMs <= 0) return undefined;
    const file = this.pathFor(key);
    if (!existsSync(file)) return undefined;

    try {
      const entry = JSON.parse(readFileSync(file, "utf-8")) as CacheEntry<T>;
      if (Date.now() - entry.storedAt > this.ttlMs) return undefined;
      return entry.value;
    } catch {
      return undefined;
    }
  }

  set<T>(key: string, value: T): void {
    if (this.ttlMs <= 0) return;
    const entry: CacheEntry<T> = { storedAt: Date.now(), value };
    try {
      writeFileSync(this.pathFor(key), JSON.stringify(entry));
    } catch {
      // Кэш — не критичный путь, если диск недоступен, просто работаем без него.
    }
  }
}
