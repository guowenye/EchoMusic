/** 本地音乐目录 */
export interface LocalMusicFolder {
  /** 目录绝对路径 */
  path: string;
  /** 添加时间（毫秒时间戳） */
  addedAt: number;
}

/** 扫描出的本地歌曲 */
export interface LocalTrack {
  /** 稳定唯一 ID（依据文件路径计算的哈希） */
  id: string;
  /** 文件绝对路径 */
  path: string;
  /** 所属根目录（LocalMusicFolder.path） */
  rootPath: string;
  /** 文件名（不含扩展名） */
  fileName: string;
  /** 标题（标签缺失时回退文件名） */
  title: string;
  /** 歌手（多歌手以 、 连接；缺失时为 未知歌手） */
  artist: string;
  /** 歌手列表 */
  artists: string[];
  /** 专辑（缺失时为空字符串） */
  album: string;
  /** 专辑歌手 */
  albumArtist: string;
  /** 时长（秒） */
  duration: number;
  /** 内嵌封面提取后的缓存文件绝对路径（无则为空） */
  coverPath: string;
  /** 文件大小（字节） */
  size: number;
  /** 文件修改时间（毫秒时间戳） */
  mtimeMs: number;
  /** 音频格式（扩展名小写，如 mp3 / flac） */
  format: string;
  /** 比特率（bps，未知为 0） */
  bitrate: number;
  /** 采样率（Hz，未知为 0） */
  sampleRate: number;
  /** 是否存在内嵌歌词标签 */
  hasEmbeddedLyric: boolean;
}

/** 本地歌单（来源于目录中的 .m3u / .m3u8 文件） */
export interface LocalPlaylist {
  /** 歌单文件绝对路径 */
  path: string;
  /** 歌单名（文件名去扩展名） */
  name: string;
  /** 命中的本地歌曲 ID 列表（按歌单顺序） */
  trackIds: string[];
}

/** 主进程推送给渲染进程的完整状态快照 */
export interface LocalMusicState {
  folders: LocalMusicFolder[];
  tracks: LocalTrack[];
  playlists: LocalPlaylist[];
  scanning: boolean;
}

/** 扫描进度事件 */
export interface LocalMusicScanProgress {
  scanning: boolean;
  /** 已处理文件数 */
  processed: number;
  /** 总文件数（0 表示仍在枚举） */
  total: number;
  /** 当前处理的文件路径 */
  current?: string;
}

/** 添加目录结果 */
export interface LocalMusicAddFolderResult {
  canceled: boolean;
  /** 是否与已有目录重复/嵌套冲突 */
  duplicated?: boolean;
  folder?: LocalMusicFolder;
}

/** 支持扫描的音频扩展名（小写，不含点） */
export const LOCAL_AUDIO_EXTENSIONS = [
  'mp3',
  'flac',
  'wav',
  'ogg',
  'oga',
  'opus',
  'm4a',
  'mp4',
  'aac',
  'wma',
  'ape',
  'wv',
  'aif',
  'aiff',
  'dsf',
  'dff',
  'mka',
  'webm',
] as const;

/** 本地歌单扩展名 */
export const LOCAL_PLAYLIST_EXTENSIONS = ['m3u', 'm3u8'] as const;
