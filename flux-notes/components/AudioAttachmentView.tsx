import React, { useEffect, useRef, useState } from 'react';
import { GestureResponderEvent, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { NoteColorTheme } from '../types/note';

type Props = {
  uri: string;
  name: string;
  waveform?: number[];
  durationMs?: number;
  transcript?: string;
  transcriptStatus?: 'pending' | 'ready' | 'error';
  theme: NoteColorTheme;
};

const BAR_COUNT = 40;

// Fallback bars for older recordings saved before metering was captured.
function placeholderWaveform(seed: string): number[] {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return Array.from({ length: BAR_COUNT }, (_, i) => {
    const v = Math.sin(hash + i * 12.9898) * 43758.5453;
    return 0.25 + Math.abs(v - Math.floor(v)) * 0.75;
  });
}

function resample(samples: number[], count: number): number[] {
  if (samples.length === 0) return new Array(count).fill(0.3);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.floor((i / count) * samples.length);
    out.push(samples[Math.min(idx, samples.length - 1)]);
  }
  return out;
}

export default function AudioAttachmentView({ uri, name, waveform, durationMs, transcript, transcriptStatus, theme }: Props) {
  const player = useAudioPlayer(uri);
  const status = useAudioPlayerStatus(player);
  const barsRef = useRef(waveform && waveform.length > 0 ? resample(waveform, BAR_COUNT) : resample(placeholderWaveform(name), BAR_COUNT));
  const [barWidth, setBarWidth] = useState(0);

  const duration = status.duration || (durationMs ? durationMs / 1000 : 0);
  const progress = duration > 0 ? Math.min(1, status.currentTime / duration) : 0;

  const togglePlay = () => {
    if (status.playing) player.pause();
    else player.play();
  };

  const seekFromTouch = (event: GestureResponderEvent) => {
    if (!barWidth || !duration) return;
    const ratio = Math.max(0, Math.min(1, event.nativeEvent.locationX / barWidth));
    player.seekTo(ratio * duration);
  };

  return (
    <View style={[styles.container, { borderColor: theme.border, backgroundColor: theme.badgeBg }]}>
      <Pressable onPress={togglePlay} hitSlop={8} style={[styles.playBtn, { backgroundColor: theme.accent }]}>
        <Ionicons name={status.playing ? 'pause' : 'play'} size={16} color="#ffffff" />
      </Pressable>
      <Pressable
        style={styles.waveform}
        onLayout={(e) => setBarWidth(e.nativeEvent.layout.width)}
        onPress={seekFromTouch}
      >
        {barsRef.current.map((amplitude, i) => {
          const played = i / barsRef.current.length <= progress;
          return (
            <View
              key={i}
              style={[
                styles.bar,
                {
                  height: Math.max(3, amplitude * 22),
                  backgroundColor: played ? theme.accent : theme.border,
                },
              ]}
            />
          );
        })}
      </Pressable>
      <Text style={[styles.time, { color: theme.secondaryText }]}>
        {formatTime(status.currentTime || 0)} / {formatTime(duration)}
      </Text>
      {transcript ? (
        <Text style={[styles.transcript, { color: theme.text }]}>{transcript}</Text>
      ) : transcriptStatus === 'pending' ? (
        <Text style={[styles.transcript, { color: theme.secondaryText, fontStyle: 'italic' }]}>Transcribing…</Text>
      ) : transcriptStatus === 'error' ? (
        <Text style={[styles.transcript, { color: theme.secondaryText, fontStyle: 'italic' }]}>Transcript unavailable</Text>
      ) : null}
    </View>
  );
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  container: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
    marginVertical: 4,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
  },
  playBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  waveform: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    flex: 1,
    minWidth: 120,
    height: 24,
  },
  bar: {
    width: 3,
    borderRadius: 1.5,
  },
  time: {
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  transcript: {
    fontSize: 13,
    lineHeight: 18,
    width: '100%',
    marginTop: 4,
  },
});
