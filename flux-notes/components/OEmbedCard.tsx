import React, { useEffect, useState } from 'react';
import { Image, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { NoteColorTheme } from '../types/note';
import { fetchOEmbed, OEmbedData } from '../utils/oembed';

type Props = { url: string; theme: NoteColorTheme };

function hostnameOf(url: string): string {
  const match = url.match(/^https?:\/\/([^/]+)/i);
  return match ? match[1] : url;
}

export default function OEmbedCard({ url, theme }: Props) {
  const [data, setData] = useState<OEmbedData | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void fetchOEmbed(url).then((result) => {
      if (!cancelled) setData(result);
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (!data) {
    // Still loading (undefined) or no embed found (null): show a plain link.
    return (
      <Pressable onPress={() => Linking.openURL(url)}>
        <Text style={[styles.plainLink, { color: theme.accent }]} numberOfLines={1}>{url}</Text>
      </Pressable>
    );
  }

  return (
    <Pressable
      style={[styles.card, { borderColor: theme.border, backgroundColor: theme.badgeBg }]}
      onPress={() => Linking.openURL(url)}
    >
      {data.thumbnailUrl ? (
        <Image source={{ uri: data.thumbnailUrl }} style={styles.thumbnail} resizeMode="cover" />
      ) : null}
      <View style={styles.textBlock}>
        <Text style={[styles.title, { color: theme.text }]} numberOfLines={2}>{data.title || url}</Text>
        <Text style={[styles.provider, { color: theme.secondaryText }]} numberOfLines={1}>
          {data.providerName || hostnameOf(url)}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    borderWidth: 1,
    borderRadius: 12,
    overflow: 'hidden',
    marginVertical: 4,
  },
  thumbnail: {
    width: 64,
    height: 64,
  },
  textBlock: {
    flex: 1,
    padding: 8,
    justifyContent: 'center',
    gap: 2,
  },
  title: {
    fontSize: 13,
    fontWeight: '600',
  },
  provider: {
    fontSize: 11,
  },
  plainLink: {
    fontSize: 14,
    textDecorationLine: 'underline',
  },
});
