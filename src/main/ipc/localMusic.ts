import { dialog, shell } from 'electron';
import type { OpenDialogOptions } from 'electron';
import { ipcRegistry } from './registry';
import type { IpcContext } from './types';
import { bridgeLocalMusicEvents, getLocalMusicService } from '../localMusic';
import type { LocalMusicAddFolderResult } from '../../shared/localMusic';

export const registerLocalMusicHandlers = (context: IpcContext): void => {
  const service = getLocalMusicService();
  void service.init();
  bridgeLocalMusicEvents(context.getMainWindow);

  ipcRegistry.registerHandler('local-music:get-state', () => service.getState());

  ipcRegistry.registerHandler(
    'local-music:add-folder',
    async (): Promise<LocalMusicAddFolderResult> => {
      const win = context.getMainWindow();
      const options: OpenDialogOptions = {
        title: '选择本地音乐文件夹',
        properties: ['openDirectory'],
        buttonLabel: '添加',
      };
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);

      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true };
      }

      const folderPath = result.filePaths[0];
      const outcome = await service.addFolder(folderPath);
      if (outcome === 'duplicated') {
        return { canceled: false, duplicated: true };
      }
      return {
        canceled: false,
        folder: service.getState().folders.find((folder) => folder.path === folderPath) ?? {
          path: folderPath,
          addedAt: Date.now(),
        },
      };
    },
  );

  ipcRegistry.registerHandler('local-music:remove-folder', async (_event, folderPath: string) => {
    await service.removeFolder(String(folderPath ?? ''));
    return service.getState();
  });

  ipcRegistry.registerHandler('local-music:rescan', async () => {
    void service.rescanAll();
    return { ok: true };
  });

  ipcRegistry.registerHandler('local-music:get-lyric', (_event, filePath: string) =>
    service.getLyric(String(filePath ?? '')),
  );

  ipcRegistry.registerHandler('local-music:reveal', async (_event, filePath: string) => {
    const target = String(filePath ?? '').trim();
    if (!target) return false;
    shell.showItemInFolder(target);
    return true;
  });
};
