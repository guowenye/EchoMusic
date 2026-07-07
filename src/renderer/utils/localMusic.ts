import type { LocalTrack } from '../../shared/localMusic';
import type { Song } from '@/models/song';
import { registerSongContextMenuExtension } from '@/components/music/songContextMenuExtensions';

/** 将本地绝对路径转换为可用于 <img> 的 file:// URL */
export const toLocalFileUrl = (filePath: string): string => {
  const normalized = String(filePath ?? '').trim();
  if (!normalized) return '';
  let unixLike = normalized.replace(/\\/g, '/');
  if (!unixLike.startsWith('/')) unixLike = `/${unixLike}`;
  return `file://${encodeURI(unixLike).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
};

/** 本地歌曲映射为播放器通用 Song 模型 */
export const mapLocalTrackToSong = (track: LocalTrack): Song => {
  const artists = (track.artists ?? []).map((name) => ({ name }));
  return {
    id: track.id,
    title: track.title,
    name: track.title,
    artist: track.artist,
    artists: artists.length > 0 ? artists : [{ name: track.artist }],
    album: track.album,
    albumName: track.album,
    duration: track.duration,
    coverUrl: toLocalFileUrl(track.coverPath),
    audioUrl: track.path,
    // 使用本地稳定 ID 充当 hash，满足播放队列的可播判定与去重比较
    hash: track.id,
    mixSongId: 0,
    source: 'local',
    filePath: track.path,
  };
};

export const mapLocalTracksToSongs = (tracks: LocalTrack[]): Song[] =>
  tracks.map(mapLocalTrackToSong);

/** 音频规格描述（如 FLAC · 24bit/96kHz 简化为 FLAC · 320kbps） */
export const describeLocalTrackQuality = (track: LocalTrack): string => {
  const parts: string[] = [];
  if (track.format) parts.push(track.format.toUpperCase());
  if (track.bitrate > 0) parts.push(`${Math.round(track.bitrate / 1000)}kbps`);
  else if (track.sampleRate > 0) parts.push(`${(track.sampleRate / 1000).toFixed(1)}kHz`);
  return parts.join(' · ');
};

let contextMenuRegistered = false;

/** 为本地歌曲注册「在文件夹中显示」右键菜单项（全局一次） */
export const registerLocalMusicContextMenu = (): void => {
  if (contextMenuRegistered) return;
  contextMenuRegistered = true;
  registerSongContextMenuExtension({
    id: 'local-music:reveal',
    label: '在文件夹中显示',
    order: 900,
    visible: (song) => song.source === 'local' && Boolean(song.filePath),
    onSelect: async (song) => {
      const filePath = String(song.filePath ?? '').trim();
      if (filePath) await window.electron?.localMusic?.reveal(filePath);
    },
  });
};
