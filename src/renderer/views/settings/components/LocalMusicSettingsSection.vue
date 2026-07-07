<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Icon } from '@iconify/vue';
import Button from '@/components/ui/Button.vue';
import Dialog from '@/components/ui/Dialog.vue';
import Scrollbar from '@/components/ui/Scrollbar.vue';
import SettingsSectionShell from './SettingsSectionShell.vue';
import { sectionTitles } from '../constants';
import { useLocalMusicStore } from '@/stores/local';
import { useToastStore } from '@/stores/toast';
import { iconFolderOpen, iconFolderPlus, iconTrash } from '@/icons';

const localStore = useLocalMusicStore();
const toastStore = useToastStore();

const showManageDialog = ref(false);
const isAddingFolder = ref(false);
const removingPath = ref('');

const folders = computed(() => localStore.folders);
const scanning = computed(() => localStore.scanning);
const scanProgress = computed(() => localStore.scanProgress);

const summaryText = computed(() => {
  if (folders.value.length === 0) return '尚未添加目录';
  return `${folders.value.length} 个目录 · ${localStore.totalCount} 首歌曲`;
});

const handleAddFolder = async () => {
  if (isAddingFolder.value) return;
  isAddingFolder.value = true;
  try {
    const result = await localStore.addFolder();
    if (result === 'duplicated') {
      toastStore.info('该目录已存在或与现有目录重叠');
    } else if (result === 'ok') {
      toastStore.actionCompleted('已添加目录，开始扫描');
    }
  } catch {
    toastStore.actionFailed('添加目录');
  } finally {
    isAddingFolder.value = false;
  }
};

const handleRemoveFolder = async (folderPath: string) => {
  if (removingPath.value) return;
  removingPath.value = folderPath;
  try {
    await localStore.removeFolder(folderPath);
    toastStore.actionCompleted('已移除目录');
  } catch {
    toastStore.actionFailed('移除目录');
  } finally {
    removingPath.value = '';
  }
};

const handleRescan = async () => {
  if (scanning.value) return;
  try {
    await localStore.rescan();
    toastStore.info('正在重新扫描本地歌曲');
  } catch {
    toastStore.actionFailed('扫描');
  }
};

onMounted(() => {
  void localStore.hydrate();
});
</script>

<template>
  <SettingsSectionShell id="localMusic" :title="sectionTitles.localMusic.label">
    <template #icon>
      <Icon :icon="sectionTitles.localMusic.icon" width="20" height="20" class="text-primary" />
    </template>

    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">本地歌曲目录</h3>
        <p class="text-sm text-text-secondary">可在此增删本地歌曲目录，歌曲增删实时同步</p>
      </div>
      <Button variant="ghost" size="xs" class="settings-button" @click="showManageDialog = true">
        管理目录
      </Button>
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">重新扫描</h3>
        <p class="text-sm text-text-secondary">{{ summaryText }}</p>
      </div>
      <Button
        variant="ghost"
        size="xs"
        class="settings-button"
        :disabled="scanning || folders.length === 0"
        @click="handleRescan"
      >
        {{ scanning ? '扫描中...' : '立即扫描' }}
      </Button>
    </div>
  </SettingsSectionShell>

  <Dialog
    v-model:open="showManageDialog"
    title="目录管理"
    description="请选择本地音乐文件夹，将自动扫描您添加的目录，歌曲增删实时同步"
    contentClass="local-folder-dialog"
    showClose
  >
    <div class="flex flex-col gap-4 pt-1">
      <Scrollbar v-if="folders.length > 0" class="local-folder-scroll">
        <div class="flex flex-col gap-2">
          <div v-for="folder in folders" :key="folder.path" class="local-folder-item">
            <Icon
              :icon="iconFolderOpen"
              width="18"
              height="18"
              class="shrink-0 text-text-main/70"
            />
            <span class="local-folder-path" :title="folder.path">{{ folder.path }}</span>
            <Button
              variant="unstyled"
              size="none"
              class="local-folder-remove"
              title="移除目录"
              :disabled="removingPath === folder.path"
              @click="handleRemoveFolder(folder.path)"
            >
              <Icon :icon="iconTrash" width="15" height="15" />
            </Button>
          </div>
        </div>
      </Scrollbar>

      <div v-else class="local-folder-empty">
        <Icon :icon="iconFolderOpen" width="22" height="22" class="opacity-30" />
        <span>暂无目录，点击下方按钮添加</span>
      </div>

      <div v-if="scanning" class="local-folder-scanning">
        <span class="local-folder-scanning-dot"></span>
        <span>
          正在扫描{{
            scanProgress && scanProgress.total > 0
              ? `（${scanProgress.processed}/${scanProgress.total}）`
              : '...'
          }}
        </span>
      </div>

      <div class="flex justify-center">
        <Button
          variant="secondary"
          size="sm"
          class="local-folder-add-btn"
          :loading="isAddingFolder"
          @click="handleAddFolder"
        >
          <Icon :icon="iconFolderPlus" width="16" height="16" />
          <span>添加文件夹</span>
        </Button>
      </div>
    </div>
  </Dialog>
</template>

<style scoped src="../settingsSection.css"></style>

<style scoped>
@reference "@/style.css";

:deep(.local-folder-dialog) {
  width: min(560px, 92vw);
}

.local-folder-scroll {
  max-height: min(280px, 42vh);
}

.local-folder-item {
  @apply flex items-center gap-3 rounded-xl border px-4 py-3;
  background: var(--control-muted-bg);
  border-color: var(--control-border);
}

.local-folder-path {
  @apply min-w-0 flex-1 truncate text-[13px] font-medium text-text-main;
}

.local-folder-remove {
  @apply h-7 w-7 shrink-0 rounded-lg flex items-center justify-center text-text-main/55 transition-all;
}

.local-folder-remove:hover {
  color: #ef4444;
  background: color-mix(in srgb, #ef4444 10%, transparent);
}

.local-folder-remove:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.local-folder-empty {
  @apply flex flex-col items-center justify-center gap-2 py-8 text-[12px] font-medium text-text-secondary/70;
}

.local-folder-scanning {
  @apply flex items-center justify-center gap-2 text-[12px] font-medium text-primary;
}

.local-folder-scanning-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--color-primary);
  animation: local-folder-scan-pulse 1.2s ease-in-out infinite;
}

@keyframes local-folder-scan-pulse {
  0%,
  100% {
    opacity: 0.35;
    transform: scale(0.85);
  }
  50% {
    opacity: 1;
    transform: scale(1.05);
  }
}

.local-folder-add-btn {
  @apply inline-flex items-center gap-1.5 font-semibold;
}
</style>
