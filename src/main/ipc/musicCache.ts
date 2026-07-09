import { dialog, shell } from 'electron';
import type { OpenDialogOptions } from 'electron';
import { ipcRegistry } from './registry';
import type { IpcContext } from './types';
import { getMusicCacheService } from '../musicCache';
import type {
  MusicCacheChooseDirResult,
  MusicCacheConfig,
  MusicCacheStoreRequest,
} from '../../shared/musicCache';

const normalizeConfig = (config: unknown): MusicCacheConfig => {
  const raw = (config ?? {}) as Partial<MusicCacheConfig>;
  return {
    dir: String(raw.dir ?? '').trim(),
    maxSizeMB: Number(raw.maxSizeMB) || 0,
  };
};

export const registerMusicCacheHandlers = (context: IpcContext): void => {
  const service = getMusicCacheService();

  ipcRegistry.registerHandler('music-cache:lookup', (_event, config: unknown, key: string) =>
    service.lookup(normalizeConfig(config), String(key ?? '')),
  );

  ipcRegistry.registerHandler(
    'music-cache:store',
    (_event, config: unknown, request: MusicCacheStoreRequest) =>
      service.store(normalizeConfig(config), request),
  );

  ipcRegistry.registerHandler('music-cache:remove', (_event, config: unknown, key: string) =>
    service.remove(normalizeConfig(config), String(key ?? '')),
  );

  ipcRegistry.registerHandler(
    'music-cache:store-lyric',
    (_event, config: unknown, hash: string, content: string) =>
      service.storeLyric(normalizeConfig(config), String(hash ?? ''), String(content ?? '')),
  );

  ipcRegistry.registerHandler('music-cache:get-lyric', (_event, config: unknown, hash: string) =>
    service.getLyric(normalizeConfig(config), String(hash ?? '')),
  );

  ipcRegistry.registerHandler(
    'music-cache:store-cover',
    (_event, config: unknown, hash: string, url: string) =>
      service.storeCover(normalizeConfig(config), String(hash ?? ''), String(url ?? '')),
  );

  ipcRegistry.registerHandler('music-cache:stats', (_event, config: unknown) =>
    service.stats(normalizeConfig(config)),
  );

  ipcRegistry.registerHandler('music-cache:clear', (_event, config: unknown) =>
    service.clear(normalizeConfig(config)),
  );

  ipcRegistry.registerHandler(
    'music-cache:choose-dir',
    async (): Promise<MusicCacheChooseDirResult> => {
      const win = context.getMainWindow();
      const options: OpenDialogOptions = {
        title: '选择歌曲缓存目录',
        properties: ['openDirectory', 'createDirectory'],
        buttonLabel: '选择',
      };
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);

      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true };
      }
      const dir = result.filePaths[0];
      const writable = await service.isDirWritable(dir);
      return { canceled: false, dir, writable };
    },
  );

  ipcRegistry.registerHandler('music-cache:reveal', async (_event, config: unknown) => {
    const dir = service.resolveEffectiveDir(normalizeConfig(config));
    const error = await shell.openPath(dir);
    return !error;
  });
};
