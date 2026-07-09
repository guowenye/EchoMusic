import type { Song } from '@/models/song';
import type { TrackLoudness } from '@/utils/player';
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
    };
  } catch (error) {
    logger.warn('MusicCache', 'Lookup cached audio failed:', error);
    return null;
  }
};

/** 后台缓存一首歌（不阻塞播放） */
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
  void bridge.store(config, request).catch((error) => {
    logger.warn('MusicCache', 'Cache store request failed:', error);
  });
};

/** 移除某个缓存记录（如命中的缓存文件无法播放时） */
export const removeCachedAudio = (config: MusicCacheConfig, key: string): void => {
  const bridge = getBridge();
  if (!bridge || !key) return;
  void bridge.remove(config, key).catch(() => undefined);
};
