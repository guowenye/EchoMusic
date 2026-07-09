<script setup lang="ts">
import { useSettingStore } from '@/stores/setting';
import AmllLyricView from './AmllLyricView.vue';
import LyricScroller from './LyricScroller.vue';

interface Props {
  collapsed?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  collapsed: false,
});

const settingStore = useSettingStore();
</script>

<template>
  <!-- Apple Music-like Lyrics 渲染与原生渲染二选一，按设置切换 -->
  <AmllLyricView v-if="settingStore.amllEnabled" :collapsed="props.collapsed" />
  <LyricScroller v-else :collapsed="props.collapsed" />
</template>
