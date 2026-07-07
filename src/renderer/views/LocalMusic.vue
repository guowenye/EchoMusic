<script setup lang="ts">
defineOptions({ name: 'local-music' });
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { Song } from '@/models/song';
import type { SetPlaybackQueueOptions } from '@/stores/playlist';
import { useLocalMusicStore } from '@/stores/local';
import { usePlayerStore } from '@/stores/player';
import { usePlaylistStore } from '@/stores/playlist';
import { useSettingStore } from '@/stores/setting';
import { useThemeStore } from '@/stores/theme';
import { useToastStore } from '@/stores/toast';
import { getAccentGradientPair } from '@/utils/color';
import { replaceQueueAndPlay } from '@/utils/playback';
import { filterSongsByQuery, sortSongs } from '@/utils/songList';
import SliverHeader from '@/components/music/DetailPageSliverHeader.vue';
import ActionRow from '@/components/music/DetailPageActionRow.vue';
import SongList from '@/components/music/SongList.vue';
import SongListHeader from '@/components/music/SongListHeader.vue';
import BatchActionDrawer from '@/components/music/BatchActionDrawer.vue';
import Button from '@/components/ui/Button.vue';
import Badge from '@/components/ui/Badge.vue';
import Cover from '@/components/ui/Cover.vue';
import Tabs from '@/components/ui/Tabs.vue';
import TabsList from '@/components/ui/TabsList.vue';
import TabsTrigger from '@/components/ui/TabsTrigger.vue';
import PageScrollContainer from '@/components/ui/PageScrollContainer.vue';
import { useStickyTabsLayout } from '@/composables/useStickyTabsLayout';
import type { SortField, SortOrder } from '@/components/music/SongListHeader.vue';
import {
  iconChevronLeft,
  iconCurrentLocation,
  iconFolderOpen,
  iconList,
  iconMusic,
  iconPlay,
  iconPlus,
  iconRefreshCw,
  iconSearch,
  iconSettings,
  iconUser,
} from '@/icons';

type TabKey = 'songs' | 'artists' | 'albums' | 'playlists' | 'folders';

const router = useRouter();
const localStore = useLocalMusicStore();
const playerStore = usePlayerStore();
const playlistStore = usePlaylistStore();
const settingStore = useSettingStore();
const themeStore = useThemeStore();
const toastStore = useToastStore();

const activeTab = ref<TabKey>('songs');
const searchQuery = ref('');
const showBatchDrawer = ref(false);
const sortField = ref<SortField | null>(null);
const sortOrder = ref<SortOrder>(null);
const selectedArtist = ref<string | null>(null);
const selectedAlbumKey = ref<string | null>(null);
const selectedPlaylistPath = ref<string | null>(null);
const selectedFolderPath = ref<string | null>(null);
const songListRef = ref<{ scrollToActive?: () => void } | null>(null);
const pageScrollRef = ref<InstanceType<typeof PageScrollContainer> | null>(null);
const sliverHeaderRef = ref<{ currentHeight?: number } | null>(null);
const { tabsTop, tabsMinHeight } = useStickyTabsLayout(sliverHeaderRef);

const activeSongId = computed(() => playerStore.currentTrackId ?? undefined);
const hasFolders = computed(() => localStore.folders.length > 0);
const scanning = computed(() => localStore.scanning);
const scanProgress = computed(() => localStore.scanProgress);

const localCoverUrl = computed(() => {
  const { from, to } = getAccentGradientPair(themeStore.sourceColor);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${from}" />
          <stop offset="100%" stop-color="${to}" />
        </linearGradient>
      </defs>
      <rect width="400" height="400" rx="60" fill="url(#g)" />
      <g fill="#FFFFFF" opacity="0.92">
        <rect x="112" y="118" width="176" height="120" rx="14" />
        <path d="M92 252h216c8 0 14 6 14 14 0 9-7 16-16 16H94c-9 0-16-7-16-16 0-8 6-14 14-14z" />
        <g fill="${from}">
          <path d="M212 148v46a17 17 0 1 0 8 14v-44l22 6v-16l-30-6z" opacity="0.9"/>
        </g>
      </g>
    </svg>
  `;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
});

// ── 各分类数据 ──

const normalizedQuery = computed(() => searchQuery.value.trim().toLowerCase());

const sortedAllSongs = computed(() =>
  sortSongs(localStore.songs, sortField.value, sortOrder.value, {
    indexSource: localStore.songs,
  }),
);

const filteredArtistGroups = computed(() => {
  const query = normalizedQuery.value;
  if (!query) return localStore.artistGroups;
  return localStore.artistGroups.filter((group) => group.name.toLowerCase().includes(query));
});

const filteredAlbumGroups = computed(() => {
  const query = normalizedQuery.value;
  if (!query) return localStore.albumGroups;
  return localStore.albumGroups.filter(
    (group) =>
      group.name.toLowerCase().includes(query) || group.artist.toLowerCase().includes(query),
  );
});

const filteredPlaylistGroups = computed(() => {
  const query = normalizedQuery.value;
  if (!query) return localStore.playlistGroups;
  return localStore.playlistGroups.filter((group) => group.name.toLowerCase().includes(query));
});

const filteredFolderGroups = computed(() => {
  const query = normalizedQuery.value;
  if (!query) return localStore.folderGroups;
  return localStore.folderGroups.filter(
    (group) =>
      group.name.toLowerCase().includes(query) ||
      group.displayPath.toLowerCase().includes(query) ||
      group.path.toLowerCase().includes(query),
  );
});

/** 当前下钻的详情上下文（歌手/专辑/歌单/文件夹二级列表） */
const detailContext = computed<{
  title: string;
  subtitle: string;
  queueId: string;
  songs: Song[];
} | null>(() => {
  if (activeTab.value === 'artists' && selectedArtist.value) {
    const group = localStore.artistGroups.find((item) => item.name === selectedArtist.value);
    if (group) {
      return {
        title: group.name,
        subtitle: '本地歌手',
        queueId: `queue:local:artist:${group.name}`,
        songs: group.songs,
      };
    }
  }
  if (activeTab.value === 'albums' && selectedAlbumKey.value) {
    const group = localStore.albumGroups.find((item) => item.key === selectedAlbumKey.value);
    if (group) {
      return {
        title: group.name,
        subtitle: group.artist || '本地专辑',
        queueId: `queue:local:album:${group.key}`,
        songs: group.songs,
      };
    }
  }
  if (activeTab.value === 'playlists' && selectedPlaylistPath.value) {
    const group = localStore.playlistGroups.find(
      (item) => item.path === selectedPlaylistPath.value,
    );
    if (group) {
      return {
        title: group.name,
        subtitle: '本地歌单',
        queueId: `queue:local:playlist:${group.path}`,
        songs: group.songs,
      };
    }
  }
  if (activeTab.value === 'folders' && selectedFolderPath.value) {
    const group = localStore.folderGroups.find((item) => item.path === selectedFolderPath.value);
    if (group) {
      return {
        title: group.name,
        subtitle: group.displayPath,
        queueId: `queue:local:folder:${group.path}`,
        songs: group.songs,
      };
    }
  }
  return null;
});

/** 当前是否展示歌曲列表（单曲页或任一下钻详情） */
const isSongListView = computed(() => activeTab.value === 'songs' || detailContext.value !== null);

const currentListSortedSongs = computed<Song[]>(() => {
  if (activeTab.value === 'songs') return sortedAllSongs.value;
  const detail = detailContext.value;
  if (!detail) return [];
  return sortSongs(detail.songs, sortField.value, sortOrder.value, {
    indexSource: detail.songs,
  });
});

const currentListSongs = computed<Song[]>(() =>
  filterSongsByQuery(currentListSortedSongs.value, searchQuery.value),
);

const currentQueueOptions = computed<SetPlaybackQueueOptions>(() => {
  const detail = detailContext.value;
  if (activeTab.value !== 'songs' && detail) {
    return {
      queueId: detail.queueId,
      title: `本地音乐 · ${detail.title}`,
      subtitle: detail.subtitle,
      type: 'local',
      dynamic: false,
    };
  }
  return {
    queueId: 'queue:local',
    title: '本地音乐',
    subtitle: '你的本地曲库',
    type: 'local',
    dynamic: false,
  };
});

const tabItems = computed(() => [
  { key: 'songs' as TabKey, label: '单曲', count: localStore.totalCount },
  { key: 'artists' as TabKey, label: '歌手', count: localStore.artistGroups.length },
  { key: 'albums' as TabKey, label: '专辑', count: localStore.albumGroups.length },
  { key: 'playlists' as TabKey, label: '歌单', count: localStore.playlistGroups.length },
  { key: 'folders' as TabKey, label: '文件夹', count: localStore.folderGroups.length },
]);

const searchPlaceholder = computed(() => {
  if (isSongListView.value) return '搜索歌曲...';
  switch (activeTab.value) {
    case 'artists':
      return '搜索歌手...';
    case 'albums':
      return '搜索专辑...';
    case 'playlists':
      return '搜索歌单...';
    case 'folders':
      return '搜索文件夹...';
    default:
      return '搜索歌曲...';
  }
});

// ── 操作 ──

const resetSelection = () => {
  selectedArtist.value = null;
  selectedAlbumKey.value = null;
  selectedPlaylistPath.value = null;
  selectedFolderPath.value = null;
};

const scrollContentToTop = () => {
  void nextTick(() => {
    pageScrollRef.value?.setScrollTop(0);
  });
};

const handleTabChange = (value: string | number | undefined) => {
  const key = String(value ?? 'songs') as TabKey;
  if (activeTab.value === key) return;
  activeTab.value = key;
  resetSelection();
  searchQuery.value = '';
  sortField.value = null;
  sortOrder.value = null;
};

const backFromDetail = () => {
  resetSelection();
  sortField.value = null;
  sortOrder.value = null;
  searchQuery.value = '';
  scrollContentToTop();
};

const openDetail = (kind: Exclude<TabKey, 'songs'>, key: string) => {
  searchQuery.value = '';
  sortField.value = null;
  sortOrder.value = null;
  if (kind === 'artists') selectedArtist.value = key;
  else if (kind === 'albums') selectedAlbumKey.value = key;
  else if (kind === 'playlists') selectedPlaylistPath.value = key;
  else if (kind === 'folders') selectedFolderPath.value = key;
  scrollContentToTop();
};

const handleSort = (field: SortField) => {
  if (sortField.value === field) {
    if (sortOrder.value === 'asc') {
      sortOrder.value = 'desc';
    } else if (sortOrder.value === 'desc') {
      sortField.value = null;
      sortOrder.value = null;
    }
  } else {
    sortField.value = field;
    sortOrder.value = 'asc';
  }
};

const handlePlayAll = async () => {
  const queueSongs = currentListSongs.value.slice();
  if (queueSongs.length === 0) return;
  await replaceQueueAndPlay(playlistStore, playerStore, queueSongs, 0, undefined, {
    ...currentQueueOptions.value,
  });
};

const handleSongDoubleTapPlay = async (song: Song) => {
  const queueSongs = currentListSongs.value.slice();
  if (queueSongs.length === 0) return;
  await replaceQueueAndPlay(playlistStore, playerStore, queueSongs, 0, song, {
    ...currentQueueOptions.value,
  });
};

const openBatchDrawer = () => {
  if (currentListSongs.value.length === 0) return;
  showBatchDrawer.value = true;
};

const handleLocate = () => songListRef.value?.scrollToActive?.();

const goToLocalMusicSettings = () => {
  router.push({ path: '/main/settings', query: { section: 'localMusic' } });
};

const handleAddFolder = async () => {
  const result = await localStore.addFolder();
  if (result === 'duplicated') {
    toastStore.info('该目录已存在或与现有目录重叠');
  } else if (result === 'ok') {
    toastStore.actionCompleted('已添加目录，开始扫描');
  }
};

const handleRescan = async () => {
  if (scanning.value) return;
  await localStore.rescan();
  toastStore.info('正在重新扫描本地歌曲');
};

const headerSecondaryActions = computed(() => [
  {
    icon: iconRefreshCw,
    label: scanning.value ? '扫描中...' : '重新扫描',
    disabled: scanning.value || !hasFolders.value,
    onTap: handleRescan,
  },
  {
    icon: iconSettings,
    label: '管理目录',
    onTap: goToLocalMusicSettings,
  },
]);

watch(
  () => detailContext.value,
  (detail, previous) => {
    // 下钻目标因数据刷新消失时自动回退到网格视图
    if (!detail && previous && activeTab.value !== 'songs') {
      resetSelection();
    }
  },
);

onMounted(() => {
  void localStore.hydrate(true);
});
</script>

<template>
  <PageScrollContainer ref="pageScrollRef" class="local-music-container">
    <div class="local-music-view bg-bg-main min-h-full">
      <SliverHeader
        ref="sliverHeaderRef"
        typeLabel="LOCAL"
        title="本地音乐"
        :coverUrl="localCoverUrl"
        :hasDetails="true"
        :expandedHeight="176"
        :collapsedHeight="56"
      >
        <template #details>
          <div class="flex flex-col gap-2">
            <div class="text-[13px] font-semibold text-text-secondary">
              管理电脑中的音乐文件，目录内歌曲增删实时同步。
            </div>
            <div
              class="flex flex-wrap items-center gap-x-3 gap-y-2 text-[11px] font-semibold text-text-secondary/80"
            >
              <div class="inline-flex items-center gap-1.5">
                <Icon :icon="iconMusic" width="12" height="12" />
                <span>{{ localStore.totalCount }} 首</span>
              </div>
              <div class="inline-flex items-center gap-1.5">
                <Icon :icon="iconFolderOpen" width="12" height="12" />
                <span>{{ localStore.folders.length }} 个目录</span>
              </div>
              <div v-if="scanning" class="inline-flex items-center gap-1.5 text-primary">
                <span class="local-scan-dot"></span>
                <span>
                  正在扫描{{
                    scanProgress && scanProgress.total > 0
                      ? ` ${scanProgress.processed}/${scanProgress.total}`
                      : '...'
                  }}
                </span>
              </div>
            </div>
          </div>
        </template>

        <template #actions>
          <ActionRow
            :playDisabled="currentListSongs.length === 0"
            :batchDisabled="currentListSongs.length === 0"
            :secondaryActions="headerSecondaryActions"
            @play="handlePlayAll"
            @batch="openBatchDrawer"
          />
        </template>

        <template #collapsed-actions>
          <Button
            variant="unstyled"
            size="none"
            @click="handlePlayAll"
            class="p-2 rounded-lg hover:bg-[var(--control-hover-bg)] text-primary"
          >
            <Icon :icon="iconPlay" width="20" height="20" />
          </Button>
          <Button
            variant="unstyled"
            size="none"
            @click="openBatchDrawer"
            class="p-2 rounded-lg hover:bg-[var(--control-hover-bg)] text-text-main opacity-60"
          >
            <Icon :icon="iconList" width="18" height="18" />
          </Button>
          <Button
            variant="unstyled"
            size="none"
            title="本地歌曲目录设置"
            @click="goToLocalMusicSettings"
            class="p-2 rounded-lg hover:bg-[var(--control-hover-bg)] text-text-main opacity-60"
          >
            <Icon :icon="iconSettings" width="18" height="18" />
          </Button>
        </template>
      </SliverHeader>

      <BatchActionDrawer
        v-model:open="showBatchDrawer"
        :songs="currentListSongs"
        source-id="local"
      />

      <!-- 未配置目录的空状态 -->
      <div
        v-if="!hasFolders"
        class="local-empty flex flex-col items-center justify-center py-24 text-center px-6"
      >
        <div
          class="w-18 h-18 rounded-3xl bg-primary/10 text-primary flex items-center justify-center mb-5"
        >
          <Icon :icon="iconFolderOpen" width="32" height="32" />
        </div>
        <div class="text-[22px] font-semibold text-text-main">还没有本地歌曲目录</div>
        <div class="mt-2 text-[13px] font-medium text-text-secondary/75">
          添加音乐文件夹后将自动扫描，歌曲增删实时同步
        </div>
        <div class="mt-6 flex items-center gap-3">
          <Button variant="primary" size="sm" class="local-empty-btn" @click="handleAddFolder">
            <Icon :icon="iconPlus" width="15" height="15" />
            <span>添加文件夹</span>
          </Button>
          <Button variant="ghost" size="sm" class="local-empty-btn" @click="goToLocalMusicSettings">
            <Icon :icon="iconSettings" width="15" height="15" />
            <span>目录管理</span>
          </Button>
        </div>
      </div>

      <Tabs
        v-else
        :model-value="activeTab"
        class="w-full"
        :style="{ minHeight: tabsMinHeight }"
        @update:model-value="handleTabChange"
      >
        <div class="song-list-sticky sticky z-110 bg-bg-main" :style="{ top: `${tabsTop}px` }">
          <div class="px-6">
            <div class="border-b border-[var(--border-subtle)]">
              <div class="flex items-center justify-between h-14">
                <TabsList class="bg-transparent border-none gap-8">
                  <TabsTrigger v-for="tab in tabItems" :key="tab.key" :value="tab.key">
                    <span class="relative">{{ tab.label }} <Badge :count="tab.count" /></span>
                  </TabsTrigger>
                </TabsList>

                <div class="flex items-center gap-2">
                  <div class="relative">
                    <input
                      v-model="searchQuery"
                      type="text"
                      :placeholder="searchPlaceholder"
                      class="song-search-input w-52 h-9 pl-8 pr-3 rounded-lg text-text-main placeholder:text-text-main/50 outline-none text-[12px] transition-all"
                    />
                    <Icon
                      class="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-main/60"
                      :icon="iconSearch"
                      width="14"
                      height="14"
                    />
                  </div>
                  <Button
                    v-if="isSongListView"
                    variant="unstyled"
                    size="none"
                    @click="handleLocate"
                    class="song-locate-btn p-2 rounded-lg"
                    title="定位当前播放"
                  >
                    <Icon :icon="iconCurrentLocation" width="16" height="16" />
                  </Button>
                </div>
              </div>
            </div>
          </div>

          <!-- 下钻详情的返回行 -->
          <div v-if="detailContext" class="px-6">
            <div class="local-detail-bar flex items-center gap-3 h-12">
              <Button
                variant="unstyled"
                size="none"
                class="local-back-btn flex items-center gap-1 pr-2.5 pl-1.5 h-8 rounded-lg text-text-main/80"
                @click="backFromDetail"
              >
                <Icon :icon="iconChevronLeft" width="16" height="16" />
                <span class="text-[12px] font-semibold">返回</span>
              </Button>
              <div class="min-w-0 flex-1 flex items-baseline gap-2">
                <span class="text-[15px] font-bold text-text-main truncate">
                  {{ detailContext.title }}
                </span>
                <span class="text-[11px] font-medium text-text-secondary/75 truncate">
                  {{ detailContext.subtitle }} · {{ currentListSongs.length }} 首
                </span>
              </div>
            </div>
          </div>

          <SongListHeader
            v-if="isSongListView"
            :sortField="sortField"
            :sortOrder="sortOrder"
            :showCover="true"
            paddingClass="px-6"
            @sort="handleSort"
          />
        </div>

        <div class="px-6 pb-12">
          <!-- 扫描空态 -->
          <div
            v-if="localStore.totalCount === 0 && scanning"
            class="flex flex-col items-center justify-center py-20 gap-4"
          >
            <div
              class="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"
            ></div>
            <div class="text-[13px] font-medium text-text-secondary/75">正在扫描本地歌曲...</div>
          </div>

          <!-- 目录内没有歌曲 -->
          <div
            v-else-if="localStore.totalCount === 0"
            class="local-empty flex flex-col items-center justify-center py-24 text-center"
          >
            <div
              class="w-16 h-16 rounded-[18px] bg-primary/10 text-primary flex items-center justify-center mb-4"
            >
              <Icon :icon="iconMusic" width="28" height="28" />
            </div>
            <div class="text-[18px] font-semibold text-text-main">未在目录中发现歌曲</div>
            <div class="mt-2 text-[13px] font-medium text-text-secondary/75">
              支持 MP3 / FLAC / WAV / OGG / M4A 等常见格式
            </div>
            <div class="mt-5">
              <Button variant="ghost" size="sm" class="local-empty-btn" @click="handleRescan">
                <Icon :icon="iconRefreshCw" width="15" height="15" />
                <span>重新扫描</span>
              </Button>
            </div>
          </div>

          <!-- 歌曲列表（单曲 / 下钻详情） -->
          <template v-else-if="isSongListView">
            <SongList
              ref="songListRef"
              :songs="currentListSongs"
              :contextSongs="currentListSortedSongs"
              :searchQuery="searchQuery"
              :disableInternalFilter="true"
              :activeId="activeSongId"
              :showCover="true"
              :queueOptions="currentQueueOptions"
              :enableDefaultDoubleTapPlay="true"
              :onSongDoubleTapPlay="
                settingStore.replacePlaylist ? handleSongDoubleTapPlay : undefined
              "
            />
            <div
              v-if="currentListSongs.length === 0"
              class="py-16 text-center text-[13px] font-medium text-text-secondary/70"
            >
              没有匹配的歌曲
            </div>
          </template>

          <!-- 歌手网格 -->
          <template v-else-if="activeTab === 'artists'">
            <div v-if="filteredArtistGroups.length > 0" class="local-grid pt-4">
              <button
                v-for="group in filteredArtistGroups"
                :key="group.name"
                type="button"
                class="local-grid-item"
                @click="openDetail('artists', group.name)"
              >
                <div class="local-grid-cover is-round">
                  <Cover
                    :url="group.coverUrl"
                    :size="200"
                    :width="'100%'"
                    :height="'100%'"
                    :borderRadius="'50%'"
                  />
                  <div v-if="!group.coverUrl" class="local-grid-cover-fallback is-round">
                    <Icon :icon="iconUser" width="34%" height="34%" />
                  </div>
                </div>
                <div class="local-grid-title text-center">{{ group.name }}</div>
                <div class="local-grid-subtitle text-center">{{ group.songs.length }} 首</div>
              </button>
            </div>
            <div v-else class="py-16 text-center text-[13px] font-medium text-text-secondary/70">
              没有匹配的歌手
            </div>
          </template>

          <!-- 专辑网格 -->
          <template v-else-if="activeTab === 'albums'">
            <div v-if="filteredAlbumGroups.length > 0" class="local-grid pt-4">
              <button
                v-for="group in filteredAlbumGroups"
                :key="group.key"
                type="button"
                class="local-grid-item"
                @click="openDetail('albums', group.key)"
              >
                <div class="local-grid-cover">
                  <Cover
                    :url="group.coverUrl"
                    :size="200"
                    :width="'100%'"
                    :height="'100%'"
                    :borderRadius="14"
                  />
                </div>
                <div class="local-grid-title">{{ group.name }}</div>
                <div class="local-grid-subtitle">
                  {{ group.artist || '未知歌手' }} · {{ group.songs.length }} 首
                </div>
              </button>
            </div>
            <div v-else class="py-16 text-center text-[13px] font-medium text-text-secondary/70">
              没有匹配的专辑
            </div>
          </template>

          <!-- 本地歌单 -->
          <template v-else-if="activeTab === 'playlists'">
            <div v-if="filteredPlaylistGroups.length > 0" class="local-grid pt-4">
              <button
                v-for="group in filteredPlaylistGroups"
                :key="group.path"
                type="button"
                class="local-grid-item"
                @click="openDetail('playlists', group.path)"
              >
                <div class="local-grid-cover">
                  <Cover
                    :url="group.coverUrl"
                    :size="200"
                    :width="'100%'"
                    :height="'100%'"
                    :borderRadius="14"
                  />
                </div>
                <div class="local-grid-title">{{ group.name }}</div>
                <div class="local-grid-subtitle">{{ group.songs.length }} 首</div>
              </button>
            </div>
            <div
              v-else
              class="local-empty flex flex-col items-center justify-center py-20 text-center"
            >
              <div
                class="w-14 h-14 rounded-[16px] bg-primary/10 text-primary flex items-center justify-center mb-4"
              >
                <Icon :icon="iconList" width="24" height="24" />
              </div>
              <div class="text-[15px] font-semibold text-text-main">暂无本地歌单</div>
              <div class="mt-2 text-[12px] font-medium text-text-secondary/70">
                目录中的 .m3u / .m3u8 歌单文件会自动展示在这里
              </div>
            </div>
          </template>

          <!-- 文件夹列表 -->
          <template v-else-if="activeTab === 'folders'">
            <div v-if="filteredFolderGroups.length > 0" class="pt-3 space-y-1">
              <button
                v-for="group in filteredFolderGroups"
                :key="group.path"
                type="button"
                class="local-folder-row"
                @click="openDetail('folders', group.path)"
              >
                <div class="local-folder-icon">
                  <Icon :icon="iconFolderOpen" width="19" height="19" />
                </div>
                <div class="min-w-0 flex-1 text-left">
                  <div class="text-[13px] font-semibold text-text-main truncate">
                    {{ group.name }}
                  </div>
                  <div class="text-[11px] font-medium text-text-secondary/70 truncate">
                    {{ group.displayPath }}
                  </div>
                </div>
                <div class="shrink-0 text-[11px] font-semibold text-text-secondary/75">
                  {{ group.songs.length }} 首
                </div>
              </button>
            </div>
            <div v-else class="py-16 text-center text-[13px] font-medium text-text-secondary/70">
              没有匹配的文件夹
            </div>
          </template>
        </div>
      </Tabs>
    </div>
  </PageScrollContainer>
</template>

<style scoped>
@reference "@/style.css";

.local-empty {
  min-height: 320px;
}

.local-empty-btn {
  @apply inline-flex items-center gap-1.5 font-semibold;
}

.local-scan-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--color-primary);
  animation: local-scan-pulse 1.2s ease-in-out infinite;
}

@keyframes local-scan-pulse {
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

.local-detail-bar {
  border-bottom: 1px solid var(--border-subtle);
}

.local-back-btn {
  background: var(--control-muted-bg);
  transition: all 0.18s ease;
}

.local-back-btn:hover {
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
  color: var(--color-primary);
}

.local-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
  gap: 18px 16px;
}

.local-grid-item {
  @apply flex flex-col gap-2 p-3 rounded-2xl cursor-pointer transition-all text-left;
  background: transparent;
  border: 0;
}

.local-grid-item:hover {
  background: var(--row-hover-bg);
}

.local-grid-item:active {
  transform: scale(0.98);
}

.local-grid-cover {
  position: relative;
  width: 100%;
  aspect-ratio: 1;
  border-radius: 14px;
  overflow: hidden;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.08);
}

.local-grid-cover.is-round {
  border-radius: 50%;
}

.local-grid-cover-fallback {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-main);
  opacity: 0.18;
  background: var(--control-muted-bg);
}

.local-grid-cover-fallback.is-round {
  border-radius: 50%;
}

.local-grid-title {
  @apply text-[13px] font-semibold text-text-main truncate w-full;
}

.local-grid-subtitle {
  @apply text-[11px] font-medium text-text-secondary/75 truncate w-full;
}

.local-folder-row {
  @apply w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl cursor-pointer transition-all;
  background: transparent;
  border: 0;
}

.local-folder-row:hover {
  background: var(--row-hover-bg);
}

.local-folder-row:active {
  transform: scale(0.995);
}

.local-folder-icon {
  @apply w-10 h-10 shrink-0 rounded-[12px] flex items-center justify-center text-primary;
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
}
</style>
