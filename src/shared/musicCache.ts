/** 歌曲缓存配置（由渲染进程设置驱动，随每次 IPC 调用传递） */
export interface MusicCacheConfig {
  /** 自定义缓存目录；空字符串表示使用默认目录（软件安装目录下 MusicCache） */
  dir: string;
  /** 缓存容量上限（MB） */
  maxSizeMB: number;
}

/** 缓存容量上限默认值与可调范围（MB） */
export const MUSIC_CACHE_DEFAULT_MAX_SIZE_MB = 2048;
export const MUSIC_CACHE_MIN_MAX_SIZE_MB = 256;
export const MUSIC_CACHE_MAX_MAX_SIZE_MB = 51200;

/** 缓存索引中的单条记录 */
export interface MusicCacheEntry {
  /** 缓存键：source|hash|quality */
  key: string;
  /** 音频文件名（相对缓存目录） */
  file: string;
  /** 文件大小（字节） */
  size: number;
  /** 解析出的音质档位（用于命中时还原播放状态） */
  quality: string | null;
  /** 缓存时记录的响度信息（原样透传给播放引擎） */
  loudness: unknown;
  /** 歌曲名（仅用于缓存管理展示） */
  songName?: string;
  /** 歌手名（仅用于缓存管理展示） */
  singerName?: string;
  /** 写入时间（毫秒时间戳） */
  createdAt: number;
  /** 最近命中时间（毫秒时间戳，LRU 淘汰依据） */
  lastAccessAt: number;
}

/** 附属资源（歌词/封面）索引记录，按歌曲 hash 维度共享给同曲不同音质的音频记录 */
export interface MusicCacheAsset {
  /** 歌曲 hash */
  hash: string;
  /** 歌词文件名（相对缓存目录，JSON 内容） */
  lyricFile?: string;
  lyricSize?: number;
  /** 封面图片文件名（相对缓存目录） */
  coverFile?: string;
  coverSize?: number;
  updatedAt: number;
}

/** 缓存命中结果 */
export interface MusicCacheLookupResult {
  hit: boolean;
  /** 命中时的音频文件绝对路径 */
  filePath?: string;
  quality?: string | null;
  loudness?: unknown;
  /** 已缓存封面的绝对路径（无则缺省） */
  coverPath?: string;
}

/** 缓存下载请求 */
export interface MusicCacheStoreRequest {
  key: string;
  url: string;
  quality: string | null;
  loudness: unknown;
  songName?: string;
  singerName?: string;
}

/** 缓存统计信息 */
export interface MusicCacheStats {
  /** 实际生效的缓存目录绝对路径 */
  dir: string;
  /** 默认缓存目录绝对路径 */
  defaultDir: string;
  totalBytes: number;
  count: number;
}

/** 清空缓存结果 */
export interface MusicCacheClearResult {
  removed: number;
  /** 因文件占用等原因未能删除的数量 */
  skipped: number;
}

/** 选择缓存目录结果 */
export interface MusicCacheChooseDirResult {
  canceled: boolean;
  dir?: string;
  /** 所选目录是否可写 */
  writable?: boolean;
}
