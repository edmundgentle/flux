import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { NoteColorTheme } from '../types/note';

type Props = {
  uri: string;
  name: string;
  theme: NoteColorTheme;
};

export default function VideoAttachmentBlock({ uri, name, theme }: Props) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
  });

  return (
    <View style={[styles.container, { borderColor: theme.border, backgroundColor: theme.badgeBg }]}>
      <VideoView
        style={styles.video}
        player={player}
        contentFit="contain"
        allowsPictureInPicture
        nativeControls
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
    marginVertical: 4,
  },
  video: {
    width: '100%',
    aspectRatio: 16 / 9,
    backgroundColor: '#000000',
  },
  name: {
    fontSize: 12,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
});
