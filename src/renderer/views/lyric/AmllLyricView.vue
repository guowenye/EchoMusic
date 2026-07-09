<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { LyricPlayer } from '@applemusic-like-lyrics/vue';
import type {
  LyricLine as AmllLyricLine,
  LyricWord as AmllLyricWord,
  LyricLineMouseEvent,
} from '@applemusic-like-lyrics/core';
import '@applemusic-like-lyrics/core/style.css';
import { testLyricFilter, useLyricStore } from '@/stores/lyric';
import { usePlayerStore } from '@/stores/player';
import { useSettingStore } from '@/stores/setting';
import { useYrcAnimation } from './composables/useYrcAnimation';

interface Props {
  collapsed?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  collapsed: false,
});

const lyricStore = useLyricStore();
const playerStore = usePlayerStore();
const settingStore = useSettingStore();

// 复用与原生渲染器一致的歌词时钟（含 mpv 上报节流补偿、播放速率外推与每首歌的歌词偏移）
const { getNowMs, getLyricTimelineMs, syncSeekAnchor } = useYrcAnimation();

// 与 LyricScroller 的逐字进度一致的固定提前量，抵消 mpv 250ms 节流 + IPC 延迟
const AMLL_LOOKAHEAD_MS = 120;
// currentIndex 仍需低频维护，供播放控件 / 插件特效等其它消费方使用
const INDEX_REFRESH_INTERVAL_MS = 100;

const currentTimeMs = ref(0);

let rafId: number | null = null;
let lastIndexRefreshTick = 0;

const tick = (timestamp: number) => {
  currentTimeMs.value = Math.max(0, getLyricTimelineMs(AMLL_LOOKAHEAD_MS));
  if (timestamp - lastIndexRefreshTick >= INDEX_REFRESH_INTERVAL_MS) {
    lastIndexRefreshTick = timestamp;
    lyricStore.updateCurrentIndex(getNowMs() / 1000);
  }
  rafId = requestAnimationFrame(tick);
};

onMounted(() => {
  syncSeekAnchor();
  currentTimeMs.value = Math.max(0, getLyricTimelineMs(AMLL_LOOKAHEAD_MS));
  rafId = requestAnimationFrame(tick);
});

onUnmounted(() => {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
});

watch(
  () => playerStore.currentTime,
  () => {
    syncSeekAnchor();
  },
);

watch(
  () => playerStore.isPlaying,
  () => {
    syncSeekAnchor();
  },
);

const hasLyrics = computed(() => lyricStore.lines.length > 0);

// 无时间轴歌词的静态回退（与 LyricScroller 保持一致）
const staticLyricLines = computed(() =>
  lyricStore.rawLyric
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\[\d+:\d+(?:\.\d+)?\]/, '')
        .replace(/^\[\d+,\d+\]/, '')
        .trim(),
    )
    .filter((line) => {
      if (!line) return false;
      return !/^\[(?:id|ar|ti|al|by|offset|hash|language|kana):/i.test(line);
    }),
);
const hasStaticLyrics = computed(
  () => !hasLyrics.value && !lyricStore.isLoading && staticLyricLines.value.length > 0,
);

const getLineStartMs = (line: (typeof lyricStore.lines)[number]) =>
  line.characters?.[0]?.startTime ?? Math.round((Number(line.time) || 0) * 1000);

// EchoMusic 歌词模型 → AMLL LyricLine 映射
// seekTimes 与 amllLines 下标一一对应，记录行点击跳转所用的播放器时间（秒）
const mappedLyrics = computed(() => {
  const filterOn = settingStore.lyricFilterEnabled;
  const pattern = settingStore.lyricFilterPattern;
  const showTranslation = lyricStore.showTranslation;
  const showRomanLine = lyricStore.showRomanization;
  const showRomanWords = settingStore.amllShowRomanWords;

  const visible = lyricStore.lines.filter(
    (line) => !filterOn || !testLyricFilter(line.text, filterOn, pattern),
  );

  const amllLines: AmllLyricLine[] = [];
  const seekTimes: number[] = [];

  for (let i = 0; i < visible.length; i++) {
    const line = visible[i]!;
    const chars = line.characters ?? [];
    const isYrc = chars.length > 1;
    const lineStart = getLineStartMs(line);
    const nextLine = visible[i + 1];
    const nextStart = nextLine ? getLineStartMs(nextLine) : undefined;
    const lastCharEnd = chars.length > 0 ? chars[chars.length - 1]!.endTime : 0;
    const lineEnd = Math.max(lastCharEnd || nextStart || lineStart + 5000, lineStart + 1);

    // 逐字音译：音译字符与主歌词字符一一对齐时，挂到每个字词上（word.romanWord）
    const romanChars = line.romanizedCharacters;
    const alignedRomanWords = Boolean(
      showRomanWords && isYrc && romanChars && romanChars.length === chars.length,
    );

    let words: AmllLyricWord[];
    if (isYrc) {
      words = chars.map((char, ci) => {
        const word: AmllLyricWord = {
          word: char.text,
          startTime: char.startTime || lineStart,
          endTime: char.endTime || lineEnd,
        };
        if (alignedRomanWords) {
          word.romanWord = romanChars![ci]?.text ?? '';
        }
        return word;
      });
    } else {
      words = [{ word: line.text, startTime: lineStart, endTime: lineEnd }];
    }

    const romanText = line.romanized?.trim() ?? '';
    // 已有逐字音译时不再输出整行音译，避免重复显示
    const romanLyric =
      !alignedRomanWords && romanText && (showRomanWords || showRomanLine) ? romanText : '';

    amllLines.push({
      words,
      translatedLyric: showTranslation ? (line.translated?.trim() ?? '') : '',
      romanLyric,
      startTime: lineStart,
      endTime: lineEnd,
      isBG: false,
      isDuet: false,
    });
    seekTimes.push(Number(line.time) || lineStart / 1000);
  }

  return { amllLines, seekTimes };
});

const wordFadeWidth = computed(() => {
  const value = Number(settingStore.amllWordFadeWidth);
  if (!Number.isFinite(value) || value <= 0) return 0.5;
  return Math.min(4, Math.max(0.01, value));
});

const alignPosition = computed(() => (props.collapsed ? 0.85 : 0.5));

// 未自定义颜色时保持 AMLL 原生的白色观感；自定义后跟随已播字色
const amllColor = computed(() =>
  lyricStore.playedColor ? lyricStore.effectivePlayedColor : '#ffffff',
);

const wrapperStyle = computed(() => {
  const scale = (props.collapsed ? 0.55 : 1) * (lyricStore.fontScale || 1);
  return {
    fontFamily: settingStore.buildLyricFontFamily(),
    fontWeight: String(lyricStore.fontWeightValue),
    '--amll-lp-color': amllColor.value,
    '--amll-lp-font-size': `calc(max(max(5vh, 2.5vw), 12px) * ${scale})`,
  };
});

const handleLineClick = (event: LyricLineMouseEvent) => {
  const time = mappedLyrics.value.seekTimes[event.lineIndex];
  if (time === undefined) return;
  playerStore.seek(time);
  if (!playerStore.isPlaying) {
    playerStore.togglePlay();
  }
  lyricStore.updateCurrentIndex(time);
};
</script>

<template>
  <div class="amll-lyric-wrap" :style="wrapperStyle">
    <LyricPlayer
      v-if="hasLyrics"
      class="amll-lyric-host"
      :lyric-lines="mappedLyrics.amllLines"
      :current-time="currentTimeMs"
      :playing="playerStore.isPlaying"
      :enable-spring="settingStore.amllSpringEnabled"
      :enable-blur="true"
      :enable-scale="true"
      :hide-passed-lines="settingStore.amllHidePassedLines"
      :word-fade-width="wordFadeWidth"
      :align-position="alignPosition"
      align-anchor="center"
      @line-click="handleLineClick"
    />

    <template v-else-if="hasStaticLyrics">
      <div class="amll-static-scroller">
        <div class="amll-static-list">
          <div
            v-for="(line, index) in staticLyricLines"
            :key="`${line}-${index}`"
            class="amll-static-row"
            :style="{ color: lyricStore.effectiveUnplayedColor }"
          >
            {{ line }}
          </div>
        </div>
      </div>
    </template>

    <!-- 空状态 -->
    <div v-else class="flex h-full items-center justify-center text-center">
      <div class="space-y-3">
        <p class="text-[28px] font-semibold opacity-80">
          {{ lyricStore.isLoading ? '歌词加载中…' : '暂无歌词' }}
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.amll-lyric-wrap {
  position: relative;
  height: 100%;
  width: 100%;
}

.amll-lyric-host {
  height: 100%;
  width: 100%;
}

.amll-static-scroller {
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: none;
  -ms-overflow-style: none;
  mask-image: linear-gradient(180deg, transparent 0%, black 10%, black 90%, transparent 100%);
  -webkit-mask-image: linear-gradient(
    180deg,
    transparent 0%,
    black 10%,
    black 90%,
    transparent 100%
  );
}

.amll-static-scroller::-webkit-scrollbar {
  display: none;
}

.amll-static-list {
  min-height: 100%;
  padding: 20vh 8px;
}

.amll-static-row {
  padding: 10px 16px;
  text-align: center;
  line-height: 1.32;
  opacity: 0.86;
  font-size: 1.4rem;
  font-weight: 600;
}
</style>
