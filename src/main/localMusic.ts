import { app, type BrowserWindow } from 'electron';
import { createHash } from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import log from 'electron-log';
import {
  LOCAL_AUDIO_EXTENSIONS,
  LOCAL_PLAYLIST_EXTENSIONS,
  type LocalMusicFolder,
  type LocalMusicScanProgress,
  type LocalMusicState,
  type LocalPlaylist,
  type LocalTrack,
} from '../shared/localMusic';

/**
 * 本地音乐库：目录扫描、标签解析、封面缓存、m3u 歌单解析与目录实时监听。
 * 索引以 JSON 形式持久化在 userData/local-music 下，避免依赖原生存储模块。
 */

const AUDIO_EXTENSION_SET = new Set<string>(LOCAL_AUDIO_EXTENSIONS);
const PLAYLIST_EXTENSION_SET = new Set<string>(LOCAL_PLAYLIST_EXTENSIONS);

/** 目录中作为专辑封面的候选文件名（按优先级） */
const FOLDER_COVER_CANDIDATES = ['cover', 'folder', 'front', 'album'];
const FOLDER_COVER_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];

/** 扫描并发数：标签解析属 IO + CPU 混合负载，过高会拖慢主进程 */
const SCAN_CONCURRENCY = 4;

/** 文件系统事件防抖窗口（毫秒），归拢连续的增删改 */
const WATCH_DEBOUNCE_MS = 1200;

/** 忽略的目录名 */
const IGNORED_DIRECTORIES = new Set(['node_modules', '$recycle.bin', 'system volume information']);

interface LocalMusicIndexFile {
  version: number;
  tracks: LocalTrack[];
}

type UpdatedListener = (state: LocalMusicState) => void;
type ProgressListener = (progress: LocalMusicScanProgress) => void;

const normalizePath = (value: string): string => path.normalize(String(value ?? '').trim());

/** Windows 下路径不区分大小写，统一小写后做比较键 */
const toPathKey = (value: string): string => {
  const normalized = normalizePath(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

const isSubPathOf = (parent: string, child: string): boolean => {
  const relative = path.relative(toPathKey(parent), toPathKey(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const md5 = (input: string | Buffer | Uint8Array): string =>
  createHash('md5').update(input).digest('hex');

const getExtension = (filePath: string): string =>
  path.extname(filePath).replace(/^\./, '').toLowerCase();

/** 解码歌词/歌单等文本文件：优先 UTF-8，出现替换符则回退 GBK（大量中文 lrc 为 GBK 编码） */
const decodeTextBuffer = (buffer: Buffer): string => {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  if (!utf8.includes('�')) return utf8;
  try {
    return new TextDecoder('gbk', { fatal: false }).decode(buffer);
  } catch {
    return utf8;
  }
};

class LocalMusicService {
  private folders: LocalMusicFolder[] = [];
  private tracks = new Map<string, LocalTrack>();
  private playlists: LocalPlaylist[] = [];
  private scanning = false;
  private rescanQueued = false;
  private watchers = new Map<string, fs.FSWatcher>();
  private watchDebounceTimer: NodeJS.Timeout | null = null;
  private updatedListeners = new Set<UpdatedListener>();
  private progressListeners = new Set<ProgressListener>();
  private persistTimer: NodeJS.Timeout | null = null;
  private initialized = false;

  // ── 路径 ──

  private get baseDir(): string {
    return path.join(app.getPath('userData'), 'local-music');
  }

  private get foldersFile(): string {
    return path.join(this.baseDir, 'folders.json');
  }

  private get indexFile(): string {
    return path.join(this.baseDir, 'index.json');
  }

  private get coversDir(): string {
    return path.join(this.baseDir, 'covers');
  }

  // ── 初始化与持久化 ──

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    try {
      await fsp.mkdir(this.coversDir, { recursive: true });
    } catch (error) {
      log.error('[LocalMusic] Create storage dir failed', error);
    }

    this.folders = await this.readJsonFile<LocalMusicFolder[]>(this.foldersFile, []);
    this.folders = this.folders
      .filter((folder) => folder && typeof folder.path === 'string' && folder.path.trim() !== '')
      .map((folder) => ({
        path: normalizePath(folder.path),
        addedAt: Number(folder.addedAt) || Date.now(),
      }));

    const index = await this.readJsonFile<LocalMusicIndexFile>(this.indexFile, {
      version: 1,
      tracks: [],
    });
    for (const track of index.tracks ?? []) {
      if (track && typeof track.path === 'string' && track.path) {
        this.tracks.set(toPathKey(track.path), track);
      }
    }

    this.setupWatchers();
    // 启动时全量对账一次：清理已删除文件、拾取离线期间的新增/修改
    void this.rescanAll({ silentProgress: true });
  }

  private async readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
    try {
      const raw = await fsp.readFile(filePath, 'utf-8');
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistNow();
    }, 800);
  }

  private async persistNow(): Promise<void> {
    try {
      await fsp.mkdir(this.baseDir, { recursive: true });
      const foldersJson = JSON.stringify(this.folders);
      const indexJson = JSON.stringify({
        version: 1,
        tracks: Array.from(this.tracks.values()),
      } satisfies LocalMusicIndexFile);
      await fsp.writeFile(this.foldersFile, foldersJson, 'utf-8');
      await fsp.writeFile(this.indexFile, indexJson, 'utf-8');
    } catch (error) {
      log.error('[LocalMusic] Persist index failed', error);
    }
  }

  // ── 事件 ──

  onUpdated(listener: UpdatedListener): () => void {
    this.updatedListeners.add(listener);
    return () => this.updatedListeners.delete(listener);
  }

  onProgress(listener: ProgressListener): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  private emitUpdated(): void {
    const state = this.getState();
    for (const listener of this.updatedListeners) {
      try {
        listener(state);
      } catch (error) {
        log.warn('[LocalMusic] Updated listener failed', error);
      }
    }
  }

  private emitProgress(progress: LocalMusicScanProgress): void {
    for (const listener of this.progressListeners) {
      try {
        listener(progress);
      } catch {
        // ignore listener errors
      }
    }
  }

  // ── 对外状态 ──

  getState(): LocalMusicState {
    return {
      folders: this.folders.slice(),
      tracks: Array.from(this.tracks.values()),
      playlists: this.playlists.slice(),
      scanning: this.scanning,
    };
  }

  // ── 目录管理 ──

  /** 添加目录；与现有目录相同或互相嵌套时拒绝，避免重复扫描 */
  async addFolder(folderPath: string): Promise<'ok' | 'duplicated'> {
    const normalized = normalizePath(folderPath);
    if (!normalized) return 'duplicated';

    for (const existing of this.folders) {
      if (isSubPathOf(existing.path, normalized) || isSubPathOf(normalized, existing.path)) {
        return 'duplicated';
      }
    }

    this.folders.push({ path: normalized, addedAt: Date.now() });
    this.schedulePersist();
    this.setupWatchers();
    this.emitUpdated();
    void this.rescanAll();
    return 'ok';
  }

  async removeFolder(folderPath: string): Promise<void> {
    const key = toPathKey(folderPath);
    this.folders = this.folders.filter((folder) => toPathKey(folder.path) !== key);

    // 移除该目录下的全部曲目
    for (const [trackKey, track] of this.tracks) {
      if (toPathKey(track.rootPath) === key) {
        this.tracks.delete(trackKey);
      }
    }
    this.playlists = this.playlists.filter((playlist) => !isSubPathOf(folderPath, playlist.path));

    this.schedulePersist();
    this.setupWatchers();
    this.emitUpdated();
    // 歌单可能引用了其他目录的歌曲，重建一次歌单索引
    void this.rescanAll({ silentProgress: true });
  }

  // ── 目录监听（实时同步） ──

  private setupWatchers(): void {
    const nextKeys = new Set(this.folders.map((folder) => toPathKey(folder.path)));

    for (const [key, watcher] of this.watchers) {
      if (!nextKeys.has(key)) {
        try {
          watcher.close();
        } catch {
          // ignore close errors
        }
        this.watchers.delete(key);
      }
    }

    for (const folder of this.folders) {
      const key = toPathKey(folder.path);
      if (this.watchers.has(key)) continue;
      try {
        const watcher = fs.watch(folder.path, { recursive: true }, (_event, fileName) => {
          this.handleWatchEvent(fileName ? String(fileName) : '');
        });
        watcher.on('error', (error) => {
          log.warn('[LocalMusic] Watcher error', { folder: folder.path, error: String(error) });
        });
        this.watchers.set(key, watcher);
      } catch (error) {
        log.warn('[LocalMusic] Watch folder failed', { folder: folder.path, error: String(error) });
      }
    }
  }

  private handleWatchEvent(fileName: string): void {
    // 只关心音频与歌单文件的变化；目录事件（无扩展名）也触发，覆盖移动/重命名场景
    const extension = getExtension(fileName);
    if (
      extension &&
      !AUDIO_EXTENSION_SET.has(extension) &&
      !PLAYLIST_EXTENSION_SET.has(extension)
    ) {
      return;
    }
    if (this.watchDebounceTimer) clearTimeout(this.watchDebounceTimer);
    this.watchDebounceTimer = setTimeout(() => {
      this.watchDebounceTimer = null;
      void this.rescanAll({ silentProgress: true });
    }, WATCH_DEBOUNCE_MS);
  }

  // ── 扫描 ──

  /** 全量对账扫描：枚举全部目录，新文件解析标签，未变化文件复用缓存，消失的文件移除 */
  async rescanAll(options?: { silentProgress?: boolean }): Promise<void> {
    if (this.scanning) {
      this.rescanQueued = true;
      return;
    }
    this.scanning = true;
    const silent = Boolean(options?.silentProgress);
    if (!silent) {
      this.emitProgress({ scanning: true, processed: 0, total: 0 });
    }

    try {
      const audioFiles: Array<{ path: string; rootPath: string }> = [];
      const playlistFiles: Array<{ path: string; rootPath: string }> = [];

      for (const folder of this.folders) {
        await this.collectFiles(folder.path, folder.path, audioFiles, playlistFiles);
      }

      const seenKeys = new Set<string>();
      const pending: Array<{ path: string; rootPath: string }> = [];

      for (const file of audioFiles) {
        const key = toPathKey(file.path);
        seenKeys.add(key);
        const cached = this.tracks.get(key);
        if (!cached) {
          pending.push(file);
          continue;
        }
        try {
          const stat = await fsp.stat(file.path);
          if (
            Math.floor(stat.mtimeMs) !== Math.floor(cached.mtimeMs) ||
            stat.size !== cached.size
          ) {
            pending.push(file);
          } else if (toPathKey(cached.rootPath) !== toPathKey(file.rootPath)) {
            // 根目录归属变化（例如目录被重新添加），仅更新归属
            this.tracks.set(key, { ...cached, rootPath: file.rootPath });
          }
        } catch {
          pending.push(file);
        }
      }

      // 移除磁盘上已不存在的曲目
      let removedCount = 0;
      for (const key of Array.from(this.tracks.keys())) {
        if (!seenKeys.has(key)) {
          this.tracks.delete(key);
          removedCount += 1;
        }
      }

      // 并发解析新增/变更文件
      let processed = 0;
      const total = pending.length;
      let dirtySinceEmit = removedCount > 0;
      let lastEmitAt = 0;

      const emitIncremental = () => {
        const now = Date.now();
        if (!dirtySinceEmit || now - lastEmitAt < 1500) return;
        lastEmitAt = now;
        dirtySinceEmit = false;
        this.emitUpdated();
      };

      const workers = Array.from({ length: Math.min(SCAN_CONCURRENCY, total) }, async () => {
        while (pending.length > 0) {
          const file = pending.shift();
          if (!file) break;
          const track = await this.parseTrack(file.path, file.rootPath);
          processed += 1;
          if (track) {
            this.tracks.set(toPathKey(track.path), track);
            dirtySinceEmit = true;
          }
          if (!silent) {
            this.emitProgress({ scanning: true, processed, total, current: file.path });
          }
          // 大库扫描期间分批推送，让界面尽快出现歌曲
          emitIncremental();
        }
      });
      await Promise.all(workers);

      // 解析歌单文件
      this.playlists = [];
      for (const file of playlistFiles) {
        const playlist = await this.parsePlaylist(file.path);
        if (playlist && playlist.trackIds.length > 0) {
          this.playlists.push(playlist);
        }
      }
      this.playlists.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));

      this.schedulePersist();
    } catch (error) {
      log.error('[LocalMusic] Rescan failed', error);
    } finally {
      this.scanning = false;
      if (!silent) {
        this.emitProgress({ scanning: false, processed: 0, total: 0 });
      }
      this.emitUpdated();
      if (this.rescanQueued) {
        this.rescanQueued = false;
        void this.rescanAll({ silentProgress: true });
      }
    }
  }

  private async collectFiles(
    dir: string,
    rootPath: string,
    audioFiles: Array<{ path: string; rootPath: string }>,
    playlistFiles: Array<{ path: string; rootPath: string }>,
  ): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const name = entry.name;
      if (name.startsWith('.')) continue;
      const fullPath = path.join(dir, name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(name.toLowerCase())) continue;
        await this.collectFiles(fullPath, rootPath, audioFiles, playlistFiles);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = getExtension(name);
      if (AUDIO_EXTENSION_SET.has(extension)) {
        audioFiles.push({ path: fullPath, rootPath });
      } else if (PLAYLIST_EXTENSION_SET.has(extension)) {
        playlistFiles.push({ path: fullPath, rootPath });
      }
    }
  }

  private async parseTrack(filePath: string, rootPath: string): Promise<LocalTrack | null> {
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      return null;
    }

    const fileName = path.basename(filePath, path.extname(filePath));
    const track: LocalTrack = {
      id: `local_${md5(toPathKey(filePath))}`,
      path: filePath,
      rootPath,
      fileName,
      title: fileName,
      artist: '未知歌手',
      artists: [],
      album: '',
      albumArtist: '',
      duration: 0,
      coverPath: '',
      size: stat.size,
      mtimeMs: Math.floor(stat.mtimeMs),
      format: getExtension(filePath),
      bitrate: 0,
      sampleRate: 0,
      hasEmbeddedLyric: false,
    };

    try {
      const { parseFile, selectCover } = await import('music-metadata');
      const metadata = await parseFile(filePath, { duration: false });
      const common = metadata.common ?? {};
      const format = metadata.format ?? {};

      const title = String(common.title ?? '').trim();
      if (title) track.title = title;

      const artists = (common.artists ?? [])
        .map((item) => String(item ?? '').trim())
        .filter(Boolean);
      const singleArtist = String(common.artist ?? '').trim();
      if (artists.length > 0) {
        track.artists = artists;
        track.artist = artists.join('、');
      } else if (singleArtist) {
        track.artists = [singleArtist];
        track.artist = singleArtist;
      }

      track.album = String(common.album ?? '').trim();
      track.albumArtist = String(common.albumartist ?? '').trim();
      track.duration = Math.round(Number(format.duration) || 0);
      track.bitrate = Math.round(Number(format.bitrate) || 0);
      track.sampleRate = Math.round(Number(format.sampleRate) || 0);
      track.hasEmbeddedLyric = Array.isArray(common.lyrics) && common.lyrics.length > 0;

      const cover = selectCover(common.picture);
      if (cover?.data?.length) {
        track.coverPath = await this.saveCover(Buffer.from(cover.data), cover.format);
      }
    } catch (error) {
      log.warn('[LocalMusic] Parse metadata failed', {
        file: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // 无内嵌封面时尝试目录封面（cover.jpg / folder.jpg / ...）
    if (!track.coverPath) {
      track.coverPath = await this.findFolderCover(path.dirname(filePath));
    }

    // 标题缺歌手信息时，尝试从「歌手 - 标题」文件名中拆分
    if (track.artist === '未知歌手' && fileName.includes(' - ')) {
      const [maybeArtist, ...rest] = fileName.split(' - ');
      const remainder = rest.join(' - ').trim();
      if (maybeArtist.trim() && remainder) {
        track.artist = maybeArtist.trim();
        track.artists = [track.artist];
        if (track.title === fileName) track.title = remainder;
      }
    }

    return track;
  }

  /** 将内嵌封面写入缓存目录（按内容 md5 去重），返回缓存文件路径 */
  private async saveCover(data: Buffer, format: string): Promise<string> {
    try {
      const hash = md5(data);
      const extension = /png/i.test(format) ? 'png' : /webp/i.test(format) ? 'webp' : 'jpg';
      const coverPath = path.join(this.coversDir, `${hash}.${extension}`);
      try {
        await fsp.access(coverPath);
      } catch {
        await fsp.writeFile(coverPath, data);
      }
      return coverPath;
    } catch {
      return '';
    }
  }

  private folderCoverCache = new Map<string, string>();

  private async findFolderCover(dir: string): Promise<string> {
    const key = toPathKey(dir);
    const cached = this.folderCoverCache.get(key);
    if (cached !== undefined) return cached;

    let result = '';
    try {
      const entries = await fsp.readdir(dir);
      const lookup = new Map(entries.map((entry) => [entry.toLowerCase(), entry]));
      outer: for (const base of FOLDER_COVER_CANDIDATES) {
        for (const extension of FOLDER_COVER_EXTENSIONS) {
          const match = lookup.get(`${base}.${extension}`);
          if (match) {
            result = path.join(dir, match);
            break outer;
          }
        }
      }
    } catch {
      // ignore unreadable directories
    }
    this.folderCoverCache.set(key, result);
    return result;
  }

  // ── 歌单（m3u / m3u8） ──

  private async parsePlaylist(playlistPath: string): Promise<LocalPlaylist | null> {
    try {
      const buffer = await fsp.readFile(playlistPath);
      const content = decodeTextBuffer(buffer);
      const baseDir = path.dirname(playlistPath);
      const trackIds: string[] = [];
      const seen = new Set<string>();

      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        let candidate = line;
        if (/^file:\/\//i.test(candidate)) {
          try {
            candidate = decodeURIComponent(candidate.replace(/^file:\/\/+/i, ''));
            if (process.platform === 'win32') candidate = candidate.replace(/^\/+/, '');
          } catch {
            continue;
          }
        }
        const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(baseDir, candidate);
        const track = this.tracks.get(toPathKey(absolute));
        if (track && !seen.has(track.id)) {
          seen.add(track.id);
          trackIds.push(track.id);
        }
      }

      return {
        path: playlistPath,
        name: path.basename(playlistPath, path.extname(playlistPath)),
        trackIds,
      };
    } catch {
      return null;
    }
  }

  // ── 歌词 ──

  /** 读取歌曲歌词：同名 .lrc 优先，其次内嵌歌词标签 */
  async getLyric(filePath: string): Promise<string> {
    const normalized = normalizePath(filePath);
    const withoutExtension = normalized.replace(/\.[^./\\]+$/, '');

    for (const extension of ['lrc', 'LRC', 'txt']) {
      try {
        const buffer = await fsp.readFile(`${withoutExtension}.${extension}`);
        const text = decodeTextBuffer(buffer).trim();
        if (text) return text;
      } catch {
        // sidecar 不存在，继续
      }
    }

    try {
      const { parseFile } = await import('music-metadata');
      const metadata = await parseFile(normalized, { duration: false, skipCovers: true });
      const lyrics = metadata.common?.lyrics ?? [];
      for (const entry of lyrics) {
        if (typeof entry === 'string') {
          const text = String(entry).trim();
          if (text) return text;
          continue;
        }
        if (entry && typeof entry === 'object') {
          const record = entry as {
            text?: unknown;
            syncText?: Array<{ timestamp?: number; text?: string }>;
          };
          const text = String(record.text ?? '').trim();
          if (text) return text;
          if (Array.isArray(record.syncText) && record.syncText.length > 0) {
            const lines = record.syncText
              .map((item) => {
                const timestamp = Math.max(0, Number(item?.timestamp) || 0);
                const minutes = Math.floor(timestamp / 60000);
                const seconds = Math.floor((timestamp % 60000) / 1000);
                const centiseconds = Math.floor((timestamp % 1000) / 10);
                const stamp = `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}]`;
                return `${stamp}${String(item?.text ?? '')}`;
              })
              .filter(Boolean);
            if (lines.length > 0) return lines.join('\n');
          }
        }
      }
    } catch {
      // 解析失败视为无歌词
    }

    return '';
  }

  dispose(): void {
    for (const watcher of this.watchers.values()) {
      try {
        watcher.close();
      } catch {
        // ignore
      }
    }
    this.watchers.clear();
    if (this.watchDebounceTimer) clearTimeout(this.watchDebounceTimer);
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
      void this.persistNow();
    }
  }
}

let service: LocalMusicService | null = null;

export const getLocalMusicService = (): LocalMusicService => {
  if (!service) service = new LocalMusicService();
  return service;
};

export const disposeLocalMusicService = (): void => {
  service?.dispose();
};

export type { LocalMusicService };

/** 将服务事件桥接到指定窗口 */
export const bridgeLocalMusicEvents = (getWindow: () => BrowserWindow | null): (() => void) => {
  const instance = getLocalMusicService();
  const offUpdated = instance.onUpdated((state) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('local-music:updated', state);
    }
  });
  const offProgress = instance.onProgress((progress) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('local-music:scan-progress', progress);
    }
  });
  return () => {
    offUpdated();
    offProgress();
  };
};
