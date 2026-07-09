<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import Button from '@/components/ui/Button.vue';
import Switch from '@/components/ui/Switch.vue';
import Slider from '@/components/ui/Slider.vue';
import SettingsSectionShell from './SettingsSectionShell.vue';
import { sectionTitles } from '../constants';
import { useSettingStore } from '@/stores/setting';
import { useToastStore } from '@/stores/toast';
import { getMusicCacheConfig } from '@/utils/musicCache';
import type { MusicCacheStats } from '../../../../shared/musicCache';

const settingStore = useSettingStore();
const toastStore = useToastStore();

const stats = ref<MusicCacheStats | null>(null);
const loadingStats = ref(false);
const clearing = ref(false);
const choosingDir = ref(false);

const bridge = () => window.electron?.musicCache;

const formatBytes = (bytes: number): string => {
  const mb = Math.max(0, Number(bytes) || 0) / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(1)} MB`;
};

const formatSizeMB = (mb: number): string => {
  const value = Math.max(0, Number(mb) || 0);
  if (value >= 1024) {
    const gb = value / 1024;
    return Number.isInteger(gb) ? `${gb} GB` : `${gb.toFixed(1)} GB`;
  }
  return `${value} MB`;
};

const effectiveDir = computed(() => stats.value?.dir ?? '');
const isCustomDir = computed(() => Boolean(String(settingStore.musicCacheDir ?? '').trim()));
const usageText = computed(() => {
  if (!stats.value) return '统计中...';
  return `已缓存 ${stats.value.count} 首 · ${formatBytes(stats.value.totalBytes)}`;
});
const maxSizeLabel = computed(() => formatSizeMB(settingStore.musicCacheMaxSizeMB));

const refreshStats = async () => {
  const api = bridge();
  if (!api || loadingStats.value) return;
  loadingStats.value = true;
  try {
    stats.value = await api.stats(getMusicCacheConfig(settingStore));
  } catch {
    stats.value = null;
  } finally {
    loadingStats.value = false;
  }
};

const handleChooseDir = async () => {
  const api = bridge();
  if (!api || choosingDir.value) return;
  choosingDir.value = true;
  try {
    const result = await api.chooseDir();
    if (result.canceled || !result.dir) return;
    if (!result.writable) {
      toastStore.actionFailed('设置缓存目录，所选目录不可写');
      return;
    }
    settingStore.musicCacheDir = result.dir;
    toastStore.actionCompleted('已更改缓存目录，新缓存将保存到该目录');
    await refreshStats();
  } catch {
    toastStore.actionFailed('设置缓存目录');
  } finally {
    choosingDir.value = false;
  }
};

const handleResetDir = async () => {
  settingStore.musicCacheDir = '';
  toastStore.actionCompleted('已恢复默认缓存目录');
  await refreshStats();
};

const handleReveal = async () => {
  const api = bridge();
  if (!api) return;
  try {
    const ok = await api.reveal(getMusicCacheConfig(settingStore));
    if (!ok) toastStore.actionFailed('打开缓存目录');
  } catch {
    toastStore.actionFailed('打开缓存目录');
  }
};

const handleClear = async () => {
  const api = bridge();
  if (!api || clearing.value) return;
  clearing.value = true;
  try {
    const result = await api.clear(getMusicCacheConfig(settingStore));
    if (result.skipped > 0) {
      toastStore.info(`已清理 ${result.removed} 首，${result.skipped} 首正在使用中已跳过`);
    } else {
      toastStore.actionCompleted(`已清空缓存（${result.removed} 首）`);
    }
    await refreshStats();
  } catch {
    toastStore.actionFailed('清空缓存');
  } finally {
    clearing.value = false;
  }
};

watch(
  () => settingStore.musicCacheDir,
  () => {
    void refreshStats();
  },
);

onMounted(() => {
  void refreshStats();
});
</script>

<template>
  <SettingsSectionShell id="musicCache" :title="sectionTitles.musicCache.label">
    <template #icon>
      <Icon :icon="sectionTitles.musicCache.icon" width="20" height="20" class="text-primary" />
    </template>

    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">启用歌曲缓存</h3>
        <p class="text-sm text-text-secondary">
          在线歌曲播放时自动缓存到本地，再次播放直接读取本地文件，不重复下载
        </p>
      </div>
      <Switch v-model="settingStore.musicCacheEnabled" />
    </div>
    <div class="settings-divider"></div>

    <div class="settings-item">
      <div class="min-w-0 flex-1 space-y-1 pr-4">
        <h3 class="font-semibold">缓存目录</h3>
        <p class="text-sm text-text-secondary">
          默认保存在软件安装目录的 MusicCache 文件夹，可自定义
        </p>
        <p
          v-if="effectiveDir"
          class="music-cache-dir-path"
          :title="effectiveDir"
        >
          {{ effectiveDir }}
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <Button
          v-if="isCustomDir"
          variant="ghost"
          size="xs"
          class="settings-button"
          @click="handleResetDir"
        >
          恢复默认
        </Button>
        <Button variant="ghost" size="xs" class="settings-button" @click="handleReveal">
          打开目录
        </Button>
        <Button
          variant="ghost"
          size="xs"
          class="settings-button"
          :disabled="choosingDir"
          @click="handleChooseDir"
        >
          {{ choosingDir ? '选择中...' : '更改目录' }}
        </Button>
      </div>
    </div>
    <div class="settings-divider"></div>

    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">缓存容量上限</h3>
        <p class="text-sm text-text-secondary">
          超出上限后自动清理最久未播放的缓存，当前上限 {{ maxSizeLabel }}
        </p>
      </div>
      <Slider
        class="w-48"
        :model-value="settingStore.musicCacheMaxSizeMB"
        :min="512"
        :max="20480"
        :step="512"
        show-value
        :format-value="() => maxSizeLabel"
        :disabled="!settingStore.musicCacheEnabled"
        @update:model-value="settingStore.musicCacheMaxSizeMB = $event"
        @value-commit="settingStore.musicCacheMaxSizeMB = $event"
      />
    </div>
    <div class="settings-divider"></div>

    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">已用空间</h3>
        <p class="text-sm text-text-secondary">{{ usageText }}</p>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <Button
          variant="ghost"
          size="xs"
          class="settings-button"
          :disabled="loadingStats"
          @click="refreshStats"
        >
          刷新
        </Button>
        <Button
          variant="ghost"
          size="xs"
          class="settings-button music-cache-clear-btn"
          :disabled="clearing || !stats || stats.count === 0"
          @click="handleClear"
        >
          {{ clearing ? '清理中...' : '清空缓存' }}
        </Button>
      </div>
    </div>
  </SettingsSectionShell>
</template>

<style scoped src="../settingsSection.css"></style>

<style scoped>
@reference "@/style.css";

.music-cache-dir-path {
  @apply truncate text-xs text-text-secondary/70;
  max-width: 420px;
}

.music-cache-clear-btn:hover:not(:disabled) {
  color: #ef4444;
}
</style>
