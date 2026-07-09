import { app, net } from 'electron';
import { createHash } from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import log from './logger';
import {
  MUSIC_CACHE_DEFAULT_MAX_SIZE_MB,
  MUSIC_CACHE_MAX_MAX_SIZE_MB,
  MUSIC_CACHE_MIN_MAX_SIZE_MB,
  type MusicCacheClearResult,
  type MusicCacheConfig,
  type MusicCacheEntry,
  type MusicCacheLookupResult,
  type MusicCacheStats,
  type MusicCacheStoreRequest,
} from '../shared/musicCache';

/**
 * 歌曲本地缓存：在线歌曲播放时后台下载到缓存目录，再次播放直接读本地文件。
 * 索引以 JSON 形式保存在缓存目录下，按 lastAccessAt 做 LRU 容量淘汰。
 * 配置（目录/容量上限）由渲染进程设置驱动，随每次调用传入，主进程无独立状态。
 */

const INDEX_FILE_NAME = 'index.json';
const INDEX_VERSION = 1;
/** 缓存音频文件名形如 <md5(key)>.<ext>，删除时只认这个形态，避免误删用户自选目录中的无关文件 */
const CACHE_FILE_PATTERN = /^[0-9a-f]{32}\.[0-9a-z]{1,8}$/i;
/** 同时进行的缓存下载数上限 */
const DOWNLOAD_CONCURRENCY = 2;
/** 下载失败后的重试冷却（毫秒） */
const FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
/** 单次下载超时（毫秒） */
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
/** lastAccessAt 更新的持久化防抖（毫秒） */
const ACCESS_PERSIST_DEBOUNCE_MS = 5000;

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'application/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/x-matroska': 'mkv',
  'video/x-matroska': 'mkv',
};

const URL_EXTENSION_WHITELIST = new Set([
  'mp3',
  'flac',
  'm4a',
  'mp4',
  'aac',
  'ogg',
  'wav',
  'mkv',
  'ape',
  'wma',
  'dff',
  'dsf',
]);

interface MusicCacheIndexFile {
  version: number;
  entries: MusicCacheEntry[];
}

interface DirState {
  /** 目录绝对路径 */
  dir: string;
  entries: Map<string, MusicCacheEntry>;
  loaded: boolean;
  accessPersistTimer: NodeJS.Timeout | null;
}

const md5 = (input: string): string => createHash('md5').update(input).digest('hex');

const toDirKey = (dir: string): string => {
  const normalized = path.normalize(String(dir ?? '').trim());
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

const clampMaxSizeMB = (value: number): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return MUSIC_CACHE_DEFAULT_MAX_SIZE_MB;
  return Math.min(MUSIC_CACHE_MAX_MAX_SIZE_MB, Math.max(MUSIC_CACHE_MIN_MAX_SIZE_MB, numeric));
};

/** 从 URL 路径推断音频扩展名 */
const extensionFromUrl = (url: string): string => {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname).replace(/^\./, '').toLowerCase();
    if (URL_EXTENSION_WHITELIST.has(ext)) return ext;
  } catch {
    /* 非法 URL 忽略 */
  }
  return '';
};

const extensionFromContentType = (contentType: string): string => {
  const normalized = String(contentType ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  return CONTENT_TYPE_EXTENSIONS[normalized] ?? '';
};

class MusicCacheService {
  private dirStates = new Map<string, DirState>();
  private pendingDownloads = new Map<string, Promise<void>>();
  private failedAt = new Map<string, number>();
  private activeDownloads = 0;
  private downloadQueue: Array<() => void> = [];

  // ── 目录解析 ──

  getDefaultDir(): string {
    // 打包后使用安装目录（exe 所在目录），开发模式使用项目根目录
    const base = app.isPackaged ? path.dirname(app.getPath('exe')) : app.getAppPath();
    return path.join(base, 'MusicCache');
  }

  private getFallbackDir(): string {
    return path.join(app.getPath('userData'), 'MusicCache');
  }

  /**
   * 解析实际生效的缓存目录：自定义目录 → 默认目录（安装目录） → userData。
   * 目录不可创建（如 Program Files 无写权限）时逐级回退。
   */
  resolveEffectiveDir(config: MusicCacheConfig): string {
    const candidates: string[] = [];
    const custom = String(config?.dir ?? '').trim();
    if (custom) candidates.push(path.normalize(custom));
    candidates.push(this.getDefaultDir(), this.getFallbackDir());

    for (const candidate of candidates) {
      try {
        fs.mkdirSync(candidate, { recursive: true });
        return candidate;
      } catch (error) {
        log.warn('[MusicCache] Cache dir unavailable, trying next candidate:', candidate, error);
      }
    }
    return this.getFallbackDir();
  }

  /** 校验目录可写（用于目录选择时的即时反馈） */
  async isDirWritable(dir: string): Promise<boolean> {
    try {
      await fsp.mkdir(dir, { recursive: true });
      const probe = path.join(dir, `.echo-cache-probe-${Date.now()}`);
      await fsp.writeFile(probe, 'ok');
      await fsp.unlink(probe);
      return true;
    } catch {
      return false;
    }
  }

  // ── 索引管理 ──

  private getDirState(dir: string): DirState {
    const key = toDirKey(dir);
    let state = this.dirStates.get(key);
    if (!state) {
      state = { dir, entries: new Map(), loaded: false, accessPersistTimer: null };
      this.dirStates.set(key, state);
    }
    return state;
  }

  private indexFilePath(dir: string): string {
    return path.join(dir, INDEX_FILE_NAME);
  }

  /** 首次使用某目录时加载索引，并对账：清掉文件已丢失的记录与残留的 .part 临时文件 */
  private async ensureLoaded(state: DirState): Promise<void> {
    if (state.loaded) return;
    state.loaded = true;

    try {
      const raw = await fsp.readFile(this.indexFilePath(state.dir), 'utf-8');
      const parsed = JSON.parse(raw) as MusicCacheIndexFile;
      const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
      for (const entry of entries) {
        if (!entry?.key || !entry?.file) continue;
        state.entries.set(entry.key, {
          ...entry,
          size: Number(entry.size) || 0,
          createdAt: Number(entry.createdAt) || Date.now(),
          lastAccessAt: Number(entry.lastAccessAt) || Date.now(),
        });
      }
    } catch {
      /* 索引不存在或损坏，视为空缓存 */
    }

    // 对账：索引里记录的文件必须真实存在
    const deadKeys: string[] = [];
    for (const [key, entry] of state.entries) {
      try {
        const stat = await fsp.stat(path.join(state.dir, entry.file));
        if (!stat.isFile()) deadKeys.push(key);
        else if (stat.size !== entry.size) entry.size = stat.size;
      } catch {
        deadKeys.push(key);
      }
    }
    deadKeys.forEach((key) => state.entries.delete(key));

    // 清理上次异常退出残留的下载临时文件
    try {
      const files = await fsp.readdir(state.dir);
      await Promise.all(
        files
          .filter((name) => name.endsWith('.part') && CACHE_FILE_PATTERN.test(name.slice(0, -5)))
          .map((name) => fsp.unlink(path.join(state.dir, name)).catch(() => undefined)),
      );
    } catch {
      /* 目录读取失败忽略 */
    }

    if (deadKeys.length > 0) await this.persistIndex(state);
  }

  private async persistIndex(state: DirState): Promise<void> {
    const payload: MusicCacheIndexFile = {
      version: INDEX_VERSION,
      entries: Array.from(state.entries.values()),
    };
    try {
      await fsp.mkdir(state.dir, { recursive: true });
      const tmpFile = `${this.indexFilePath(state.dir)}.tmp`;
      await fsp.writeFile(tmpFile, JSON.stringify(payload), 'utf-8');
      await fsp.rename(tmpFile, this.indexFilePath(state.dir));
    } catch (error) {
      log.warn('[MusicCache] Persist index failed:', error);
    }
  }

  private schedulePersistAccess(state: DirState): void {
    if (state.accessPersistTimer) return;
    state.accessPersistTimer = setTimeout(() => {
      state.accessPersistTimer = null;
      void this.persistIndex(state);
    }, ACCESS_PERSIST_DEBOUNCE_MS);
  }

  /** 应用退出前落盘所有目录的索引（主要是 lastAccessAt 的防抖更新） */
  flushOnQuit(): void {
    for (const state of this.dirStates.values()) {
      if (!state.accessPersistTimer) continue;
      clearTimeout(state.accessPersistTimer);
      state.accessPersistTimer = null;
      try {
        const payload: MusicCacheIndexFile = {
          version: INDEX_VERSION,
          entries: Array.from(state.entries.values()),
        };
        fs.writeFileSync(this.indexFilePath(state.dir), JSON.stringify(payload), 'utf-8');
      } catch {
        /* 退出路径尽力而为 */
      }
    }
  }

  // ── 查询 ──

  async lookup(config: MusicCacheConfig, key: string): Promise<MusicCacheLookupResult> {
    const cacheKey = String(key ?? '').trim();
    if (!cacheKey) return { hit: false };

    const dir = this.resolveEffectiveDir(config);
    const state = this.getDirState(dir);
    await this.ensureLoaded(state);

    const entry = state.entries.get(cacheKey);
    if (!entry) return { hit: false };

    const filePath = path.join(dir, entry.file);
    try {
      const stat = await fsp.stat(filePath);
      if (!stat.isFile() || stat.size <= 0 || stat.size !== entry.size) throw new Error('mismatch');
    } catch {
      state.entries.delete(cacheKey);
      void this.persistIndex(state);
      return { hit: false };
    }

    entry.lastAccessAt = Date.now();
    this.schedulePersistAccess(state);
    return { hit: true, filePath, quality: entry.quality ?? null, loudness: entry.loudness ?? null };
  }

  /** 删除指定缓存记录（如缓存文件损坏时由播放侧触发） */
  async remove(config: MusicCacheConfig, key: string): Promise<boolean> {
    const cacheKey = String(key ?? '').trim();
    if (!cacheKey) return false;

    const dir = this.resolveEffectiveDir(config);
    const state = this.getDirState(dir);
    await this.ensureLoaded(state);

    const entry = state.entries.get(cacheKey);
    if (!entry) return false;
    state.entries.delete(cacheKey);
    await fsp.unlink(path.join(dir, entry.file)).catch(() => undefined);
    await this.persistIndex(state);
    return true;
  }

  // ── 下载 ──

  private async acquireDownloadSlot(): Promise<void> {
    if (this.activeDownloads < DOWNLOAD_CONCURRENCY) {
      this.activeDownloads += 1;
      return;
    }
    // 名额由释放方直接移交，计数保持不变，避免释放与唤醒间隙的超额准入
    await new Promise<void>((resolve) => this.downloadQueue.push(resolve));
  }

  private releaseDownloadSlot(): void {
    const next = this.downloadQueue.shift();
    if (next) {
      next();
      return;
    }
    this.activeDownloads = Math.max(0, this.activeDownloads - 1);
  }

  /**
   * 后台缓存一首歌：已缓存/下载中/冷却期内直接跳过。
   * 下载写入 .part 临时文件，完成后改名并写索引，最后按容量上限做 LRU 淘汰。
   */
  async store(config: MusicCacheConfig, request: MusicCacheStoreRequest): Promise<void> {
    const cacheKey = String(request?.key ?? '').trim();
    const url = String(request?.url ?? '').trim();
    if (!cacheKey || !/^https?:\/\//i.test(url)) return;

    const dir = this.resolveEffectiveDir(config);
    const state = this.getDirState(dir);
    await this.ensureLoaded(state);

    if (state.entries.has(cacheKey)) return;

    const pendingKey = `${toDirKey(dir)}|${cacheKey}`;
    if (this.pendingDownloads.has(pendingKey)) return;

    const failedTime = this.failedAt.get(cacheKey) ?? 0;
    if (Date.now() - failedTime < FAILURE_COOLDOWN_MS) return;

    const task = this.download(state, config, cacheKey, url, request)
      .catch((error) => {
        this.failedAt.set(cacheKey, Date.now());
        log.warn('[MusicCache] Cache download failed:', {
          key: cacheKey,
          song: request?.songName,
          error: error instanceof Error ? error.message : error,
        });
      })
      .finally(() => {
        this.pendingDownloads.delete(pendingKey);
      });
    this.pendingDownloads.set(pendingKey, task);
    await task;
  }

  private async download(
    state: DirState,
    config: MusicCacheConfig,
    cacheKey: string,
    url: string,
    request: MusicCacheStoreRequest,
  ): Promise<void> {
    await this.acquireDownloadSlot();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    const fileBase = md5(cacheKey);
    const partFile = path.join(state.dir, `${fileBase}.part`);

    try {
      const response = await net.fetch(url, { signal: controller.signal });
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }

      const ext =
        extensionFromUrl(response.url || url) ||
        extensionFromContentType(response.headers.get('content-type') ?? '') ||
        'mp3';
      const fileName = `${fileBase}.${ext}`;
      const filePath = path.join(state.dir, fileName);

      await fsp.mkdir(state.dir, { recursive: true });
      await pipeline(
        Readable.fromWeb(response.body as never),
        fs.createWriteStream(partFile, { flags: 'w' }),
      );

      const stat = await fsp.stat(partFile);
      const expectedLength = Number(response.headers.get('content-length') ?? 0);
      if (stat.size <= 0 || (expectedLength > 0 && stat.size !== expectedLength)) {
        throw new Error(`incomplete download: ${stat.size}/${expectedLength}`);
      }

      const maxBytes = clampMaxSizeMB(config.maxSizeMB) * 1024 * 1024;
      if (stat.size > maxBytes) {
        throw new Error(`file larger than cache limit: ${stat.size} > ${maxBytes}`);
      }

      await fsp.rm(filePath, { force: true }).catch(() => undefined);
      await fsp.rename(partFile, filePath);

      const now = Date.now();
      state.entries.set(cacheKey, {
        key: cacheKey,
        file: fileName,
        size: stat.size,
        quality: request.quality ?? null,
        loudness: request.loudness ?? null,
        songName: request.songName,
        singerName: request.singerName,
        createdAt: now,
        lastAccessAt: now,
      });
      this.failedAt.delete(cacheKey);
      await this.evict(state, maxBytes);
      await this.persistIndex(state);
      log.info('[MusicCache] Cached track:', {
        song: request.songName,
        size: stat.size,
        file: fileName,
      });
    } catch (error) {
      await fsp.unlink(partFile).catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timeout);
      this.releaseDownloadSlot();
    }
  }

  /** LRU 淘汰：按 lastAccessAt 从旧到新删除，直到总量降到上限内；删不掉的（如正被播放占用）跳过 */
  private async evict(state: DirState, maxBytes: number): Promise<void> {
    let totalBytes = 0;
    for (const entry of state.entries.values()) totalBytes += entry.size;
    if (totalBytes <= maxBytes) return;

    const sorted = Array.from(state.entries.values()).sort(
      (a, b) => a.lastAccessAt - b.lastAccessAt,
    );
    for (const entry of sorted) {
      if (totalBytes <= maxBytes) break;
      try {
        await fsp.unlink(path.join(state.dir, entry.file));
        state.entries.delete(entry.key);
        totalBytes -= entry.size;
      } catch (error) {
        // Windows 下正在播放的文件无法删除，留到下轮淘汰
        log.warn('[MusicCache] Evict skipped (file busy?):', entry.file, error);
      }
    }
  }

  // ── 统计与清理 ──

  async stats(config: MusicCacheConfig): Promise<MusicCacheStats> {
    const dir = this.resolveEffectiveDir(config);
    const state = this.getDirState(dir);
    await this.ensureLoaded(state);

    let totalBytes = 0;
    for (const entry of state.entries.values()) totalBytes += entry.size;
    return { dir, defaultDir: this.getDefaultDir(), totalBytes, count: state.entries.size };
  }

  /** 清空缓存：只删除索引内记录的文件与残留临时文件，不动目录里的其他内容 */
  async clear(config: MusicCacheConfig): Promise<MusicCacheClearResult> {
    const dir = this.resolveEffectiveDir(config);
    const state = this.getDirState(dir);
    await this.ensureLoaded(state);

    let removed = 0;
    let skipped = 0;
    for (const entry of Array.from(state.entries.values())) {
      try {
        await fsp.unlink(path.join(dir, entry.file));
        state.entries.delete(entry.key);
        removed += 1;
      } catch {
        skipped += 1;
      }
    }
    await this.persistIndex(state);
    return { removed, skipped };
  }
}

let service: MusicCacheService | null = null;

export const getMusicCacheService = (): MusicCacheService => {
  if (!service) {
    service = new MusicCacheService();
    app.on('before-quit', () => service?.flushOnQuit());
  }
  return service;
};
