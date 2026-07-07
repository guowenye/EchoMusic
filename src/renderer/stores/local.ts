import { defineStore } from 'pinia';
import type {
  LocalMusicFolder,
  LocalMusicScanProgress,
  LocalMusicState,
  LocalPlaylist,
  LocalTrack,
} from '../../shared/localMusic';
import type { Song } from '@/models/song';
import { mapLocalTrackToSong, toLocalFileUrl } from '@/utils/localMusic';
import logger from '@/utils/logger';

export interface LocalArtistGroup {
  name: string;
  coverUrl: string;
  songs: Song[];
}

export interface LocalAlbumGroup {
  /** 分组键：专辑名 + 专辑歌手 */
  key: string;
  name: string;
  artist: string;
  coverUrl: string;
  songs: Song[];
}

export interface LocalFolderGroup {
  /** 文件所在目录绝对路径 */
  path: string;
  /** 目录名 */
  name: string;
  /** 相对根目录的展示路径 */
  displayPath: string;
  songs: Song[];
}

export interface LocalPlaylistGroup {
  path: string;
  name: string;
  coverUrl: string;
  songs: Song[];
}

const getDirName = (filePath: string): string => {
  const normalized = filePath.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? filePath.slice(0, index) : filePath;
};

const getBaseName = (dirPath: string): string => {
  const normalized = dirPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  const base = index >= 0 ? normalized.slice(index + 1) : normalized;
  return base || normalized;
};

const compareByName = (left: string, right: string) =>
  left.localeCompare(right, 'zh-Hans-CN', { numeric: true });

let listenersBound = false;

export const useLocalMusicStore = defineStore('localMusic', {
  state: () => ({
    folders: [] as LocalMusicFolder[],
    tracks: [] as LocalTrack[],
    playlists: [] as LocalPlaylist[],
    scanning: false,
    scanProgress: null as LocalMusicScanProgress | null,
    hydrated: false,
  }),
  getters: {
    /** 全部本地歌曲（Song 模型，标题排序） */
    songs(state): Song[] {
      return state.tracks
        .slice()
        .sort(
          (left, right) =>
            compareByName(left.title, right.title) || compareByName(left.path, right.path),
        )
        .map(mapLocalTrackToSong);
    },
    songById(): Map<string, Song> {
      const map = new Map<string, Song>();
      for (const song of this.songs) map.set(String(song.id), song);
      return map;
    },
    /** 按歌手分组（多歌手歌曲会归入每位歌手名下） */
    artistGroups(): LocalArtistGroup[] {
      const groups = new Map<string, LocalArtistGroup>();
      for (const track of this.tracks) {
        const song = this.songById.get(track.id);
        if (!song) continue;
        const names = track.artists.length > 0 ? track.artists : [track.artist || '未知歌手'];
        for (const rawName of names) {
          const name = rawName.trim() || '未知歌手';
          let group = groups.get(name);
          if (!group) {
            group = { name, coverUrl: '', songs: [] };
            groups.set(name, group);
          }
          group.songs.push(song);
          if (!group.coverUrl && song.coverUrl) group.coverUrl = song.coverUrl;
        }
      }
      return Array.from(groups.values()).sort((left, right) =>
        compareByName(left.name, right.name),
      );
    },
    /** 按专辑分组（专辑名 + 专辑歌手/歌手 联合去重） */
    albumGroups(): LocalAlbumGroup[] {
      const groups = new Map<string, LocalAlbumGroup>();
      for (const track of this.tracks) {
        const song = this.songById.get(track.id);
        if (!song) continue;
        const albumName = track.album.trim() || '未知专辑';
        const albumArtist = (track.albumArtist || track.artist || '').trim();
        const key = `${albumName}::${albumArtist}`;
        let group = groups.get(key);
        if (!group) {
          group = { key, name: albumName, artist: albumArtist, coverUrl: '', songs: [] };
          groups.set(key, group);
        }
        group.songs.push(song);
        if (!group.coverUrl && song.coverUrl) group.coverUrl = song.coverUrl;
      }
      return Array.from(groups.values()).sort((left, right) =>
        compareByName(left.name, right.name),
      );
    },
    /** 按歌曲所在目录分组 */
    folderGroups(): LocalFolderGroup[] {
      const groups = new Map<string, LocalFolderGroup>();
      for (const track of this.tracks) {
        const song = this.songById.get(track.id);
        if (!song) continue;
        const dirPath = getDirName(track.path);
        let group = groups.get(dirPath);
        if (!group) {
          const rootParent = getDirName(track.rootPath);
          const relative = dirPath.startsWith(rootParent)
            ? dirPath.slice(rootParent.length).replace(/^[\\/]+/, '')
            : dirPath;
          group = {
            path: dirPath,
            name: getBaseName(dirPath),
            displayPath: relative || dirPath,
            songs: [],
          };
          groups.set(dirPath, group);
        }
        group.songs.push(song);
      }
      return Array.from(groups.values()).sort((left, right) =>
        compareByName(left.displayPath, right.displayPath),
      );
    },
    /** 本地歌单（m3u / m3u8） */
    playlistGroups(): LocalPlaylistGroup[] {
      return this.playlists.map((playlist: LocalPlaylist) => {
        const songs = playlist.trackIds
          .map((id) => this.songById.get(id))
          .filter((song): song is Song => Boolean(song));
        return {
          path: playlist.path,
          name: playlist.name,
          coverUrl: songs.find((song) => song.coverUrl)?.coverUrl ?? '',
          songs,
        };
      });
    },
    totalCount(state): number {
      return state.tracks.length;
    },
  },
  actions: {
    applyState(state: LocalMusicState) {
      this.folders = state.folders ?? [];
      this.tracks = state.tracks ?? [];
      this.playlists = state.playlists ?? [];
      this.scanning = Boolean(state.scanning);
      this.hydrated = true;
    },
    bindListeners() {
      if (listenersBound || !window.electron?.localMusic) return;
      listenersBound = true;
      window.electron.localMusic.onUpdated((state) => {
        this.applyState(state);
      });
      window.electron.localMusic.onScanProgress((progress) => {
        this.scanProgress = progress;
        this.scanning = Boolean(progress?.scanning);
      });
    },
    async hydrate(force = false) {
      if (!window.electron?.localMusic) return;
      this.bindListeners();
      if (this.hydrated && !force) return;
      try {
        const state = await window.electron.localMusic.getState();
        this.applyState(state);
      } catch (error) {
        logger.error('LocalMusicStore', 'Hydrate failed', error);
      }
    },
    async addFolder(): Promise<'ok' | 'canceled' | 'duplicated' | 'unavailable'> {
      if (!window.electron?.localMusic) return 'unavailable';
      this.bindListeners();
      const result = await window.electron.localMusic.addFolder();
      if (result.canceled) return 'canceled';
      if (result.duplicated) return 'duplicated';
      return 'ok';
    },
    async removeFolder(folderPath: string) {
      if (!window.electron?.localMusic) return;
      const state = await window.electron.localMusic.removeFolder(folderPath);
      this.applyState(state);
    },
    async rescan() {
      if (!window.electron?.localMusic) return;
      this.scanning = true;
      await window.electron.localMusic.rescan();
    },
    async revealTrack(song: Song) {
      const filePath = String(song.filePath ?? '').trim();
      if (!filePath || !window.electron?.localMusic) return;
      await window.electron.localMusic.reveal(filePath);
    },
    getCoverUrlForPath(coverPath: string): string {
      return toLocalFileUrl(coverPath);
    },
  },
});
