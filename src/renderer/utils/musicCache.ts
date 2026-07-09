import type { Song } from '@/models/song';
import type { TrackLoudness } from '@/utils/player';
import { normalizeCoverUrl } from '@/utils/cover';
import type { AudioQualityValue } from '../types';
import type { MusicCacheConfig, MusicCacheStoreRequest } from '../../shared/musicCache';
import { MUSIC_CACHE_DEFAULT_MAX_SIZE_MB } from '../../shared/musicCache';
import logger from '@/utils/logger';

/** 歌曲缓存的渲染进程接入层：构建缓存键、读取设置、包装 IPC 调用 */

export interface MusicCacheSettingLike {
  musicCacheEnabled?: boolean;
  musicCacheDir?: string;
  musicCacheMaxSizeMB?: number;
}

export interface CachedAudioHit {
  filePath: string;
  quality: AudioQualityValue | null;
  loudness: TrackLoudness | null;
  /** 已缓存封面的本地绝对路径（无则为 null） */
  coverPath: string | null;
}

/** 歌词磁盘缓存载荷（与 lyric store 的 CachedLyricResult 同构） */
export interface CachedLyricPayload {
  detail: { decodeContent?: string; lyric?: string };
  currentCandidateKey: string;
}

const getBridge = () => window.electron?.musicCache;

export const getMusicCacheConfig = (setting: MusicCacheSettingLike): MusicCacheConfig => ({
  dir: String(setting.musicCacheDir ?? '').trim(),
  maxSizeMB: Number(setting.musicCacheMaxSizeMB) || MUSIC_CACHE_DEFAULT_MAX_SIZE_MB,
});

export const isMusicCacheAvailable = (): boolean => Boolean(getBridge());

/**
 * 构建缓存键：来源 | 歌曲 hash | 请求音质。
 * 音质参与键值，保证不同音质档位各自缓存；音效（伴唱/环绕等）不缓存。
 */
export const buildMusicCacheKey = (track: Song, quality: AudioQualityValue | null): string => {
  const hash = String(track.hash ?? '').trim();
  if (!hash) return '';
  const source = String(track.source ?? 'kugou').trim() || 'kugou';
  return `${source}|${hash}|${quality ?? 'default'}`;
};

/** 只缓存 http(s) 直链，mpv-mkv:// 等代理协议与本地路径不缓存 */
export const isCacheableAudioUrl = (url: string): boolean => /^https?:\/\//i.test(String(url ?? ''));

/** 查询缓存，命中返回本地文件路径与缓存时记录的音质/响度 */
export const lookupCachedAudio = async (
  config: MusicCacheConfig,
  key: string,
): Promise<CachedAudioHit | null> => {
  const bridge = getBridge();
  if (!bridge || !key) return null;
  try {
    const result = await bridge.lookup(config, key);
    if (!result?.hit || !result.filePath) return null;
    return {
      filePath: result.filePath,
      quality: (result.quality ?? null) as AudioQualityValue | null,
      loudness: (result.loudness ?? null) as TrackLoudness | null,
      coverPath: result.coverPath ?? null,
    };
  } catch (error) {
    logger.warn('MusicCache', 'Lookup cached audio failed:', error);
    return null;
  }
};

/**
 * 音频落盘前（歌词先于音频就绪）暂存的歌词，音频缓存完成后补写。
 * 上限 16 首，超出淘汰最早的。
 */
const pendingLyricPersists = new Map<string, string>();
const PENDING_LYRIC_LIMIT = 16;

const stashPendingLyric = (hash: string, content: string): void => {
  if (pendingLyricPersists.has(hash)) pendingLyricPersists.delete(hash);
  pendingLyricPersists.set(hash, content);
  while (pendingLyricPersists.size > PENDING_LYRIC_LIMIT) {
    const oldest = pendingLyricPersists.keys().next().value;
    if (oldest === undefined) break;
    pendingLyricPersists.delete(oldest);
  }
};

/** 后台缓存封面（仅 http(s) 封面；主进程会校验歌曲音频已缓存） */
export const requestCoverCache = (config: MusicCacheConfig, track: Song): void => {
  const bridge = getBridge();
  const hash = String(track.hash ?? '').trim();
  if (!bridge || !hash) return;
  const coverUrl = normalizeCoverUrl(track.coverUrl, 480);
  if (!/^https?:\/\//i.test(coverUrl)) return;
  void bridge.storeCover(config, hash, coverUrl).catch(() => undefined);
};

/** 后台缓存一首歌（不阻塞播放）；音频就绪后接续补写歌词与封面 */
export const requestCacheStore = (
  config: MusicCacheConfig,
  key: string,
  track: Song,
  resolved: { url: string; quality: AudioQualityValue | null; loudness: TrackLoudness | null },
): void => {
  const bridge = getBridge();
  if (!bridge || !key || !isCacheableAudioUrl(resolved.url)) return;
  const request: MusicCacheStoreRequest = {
    key,
    url: resolved.url,
    quality: resolved.quality,
    loudness: resolved.loudness,
    songName: String(track.title ?? track.name ?? ''),
    singerName: String(track.artist ?? ''),
  };
  void bridge
    .store(config, request)
    .then((stored) => {
      if (!stored) return;
      // 音频已就绪：补写此前因音频未落盘而暂存的歌词，并缓存封面
      const hash = String(track.hash ?? '').trim();
      const pendingLyric = hash ? pendingLyricPersists.get(hash) : undefined;
      if (hash && pendingLyric) {
        pendingLyricPersists.delete(hash);
        void bridge.storeLyric(config, hash, pendingLyric).catch(() => undefined);
      }
      requestCoverCache(config, track);
    })
    .catch((error) => {
      logger.warn('MusicCache', 'Cache store request failed:', error);
    });
};

/**
 * 持久化歌词到歌曲缓存。主进程仅在该歌曲音频已缓存时写入；
 * 音频尚未就绪时先暂存，待音频缓存完成后由 requestCacheStore 补写。
 */
export const persistLyricToCache = (
  setting: MusicCacheSettingLike,
  hash: string,
  payload: CachedLyricPayload,
): void => {
  const bridge = getBridge();
  const songHash = String(hash ?? '').trim();
  if (!bridge || !songHash || setting.musicCacheEnabled === false) return;

  let content = '';
  try {
    content = JSON.stringify(payload);
  } catch {
    return;
  }
  if (!content) return;

  const config = getMusicCacheConfig(setting);
  void bridge
    .storeLyric(config, songHash, content)
    .then((stored) => {
      if (!stored) stashPendingLyric(songHash, content);
    })
    .catch(() => stashPendingLyric(songHash, content));
};

/** 读取歌曲缓存中的歌词副本（仅音频已缓存的歌曲存在） */
export const fetchCachedLyricResult = async (
  setting: MusicCacheSettingLike,
  hash: string,
): Promise<CachedLyricPayload | null> => {
  const bridge = getBridge();
  const songHash = String(hash ?? '').trim();
  if (!bridge || !songHash || setting.musicCacheEnabled === false) return null;

  try {
    const raw = await bridge.getLyric(getMusicCacheConfig(setting), songHash);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedLyricPayload;
    if (!parsed || typeof parsed !== 'object' || !parsed.detail) return null;
    return {
      detail: parsed.detail,
      currentCandidateKey: String(parsed.currentCandidateKey ?? ''),
    };
  } catch {
    return null;
  }
};

/** 移除某个缓存记录（如命中的缓存文件无法播放时） */
export const removeCachedAudio = (config: MusicCacheConfig, key: string): void => {
  const bridge = getBridge();
  if (!bridge || !key) return;
  void bridge.remove(config, key).catch(() => undefined);
};
