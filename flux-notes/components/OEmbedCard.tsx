import React, { useEffect, useState } from 'react';
import { Image, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { NoteColorTheme } from '../types/note';
import { Ionicons } from '@expo/vector-icons';
import { fetchLinkMetadata, hostnameOf, LinkMetadata } from '../utils/oembed';
import VideoAttachmentBlock from './VideoAttachmentBlock';
import AspectRatioImage from './AspectRatioImage';

type Props = { url: string; theme: NoteColorTheme };

export default function OEmbedCard({ url, theme }: Props) {
  const [data, setData] = useState<LinkMetadata | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void fetchLinkMetadata(url).then((result) => {
      if (!cancelled) setData(result);
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (!data) {
    // Still loading (undefined) or no embed found (null): show a plain link.
    return (
      <Pressable
        onPress={() => void Linking.openURL(url).catch(() => {})}
        style={[
          styles.fileAttachmentRow,
          { borderColor: theme.border, backgroundColor: theme.badgeBg },
        ]}
      >
        <Ionicons name="globe-outline" size={18} color={theme.accent} />
        <Text
          style={[styles.fileAttachmentText, { color: theme.accent, textDecorationLine: 'underline' }]}
          numberOfLines={1}
        >
          {url}
        </Text>
        <Ionicons name="open-outline" size={14} color={theme.secondaryText} />
      </Pressable>
    );
  }

  const isDirectVideo = (data.type === 'video' || data.videoUrl) && data.videoUrl && /\.(mp4|webm|mov|m4v)(\?.*)?$/i.test(data.videoUrl);
  const isVideo = data.type === 'video';
  const image = data.image;
  const title = data.title || hostnameOf(url);
  const description = data.description;
  const source = data.provider || hostnameOf(url);

  // If the embed is a direct video stream
  if (isDirectVideo && data.videoUrl) {
    return (
      <View style={[styles.mediaCard, { borderColor: theme.border, backgroundColor: theme.badgeBg }]}>
        <VideoAttachmentBlock uri={data.videoUrl} name={title} theme={theme} />
        <Pressable
          style={styles.mediaFooter}
          onPress={() => void Linking.openURL(url).catch(() => {})}
        >
          <Text style={[styles.title, { color: theme.text }]} numberOfLines={1}>
            {title}
          </Text>
          <Text style={[styles.provider, { color: theme.secondaryText }]} numberOfLines={1}>
            {source}
          </Text>
        </Pressable>
      </View>
    );
  }

  // Large image card for all embeds with an image (photo, video poster, articles, link previews)
  if (image) {
    return (
      <Pressable
        style={[styles.mediaCard, { borderColor: theme.border, backgroundColor: theme.badgeBg }]}
        onPress={() => void Linking.openURL(url).catch(() => {})}
      >
        <View style={styles.imageContainer}>
          <AspectRatioImage uri={image} style={styles.fullImage} />
          {isVideo ? (
            <View style={[styles.playButtonOverlay, { backgroundColor: theme.accent }]}>
              <Ionicons name="play" size={24} color="#ffffff" style={{ marginLeft: 2 }} />
            </View>
          ) : null}
        </View>
        <View style={styles.mediaFooter}>
          <Text style={[styles.title, { color: theme.text }]} numberOfLines={2}>
            {title}
          </Text>
          {description ? (
            <Text style={[styles.description, { color: theme.text }]} numberOfLines={2}>
              {description}
            </Text>
          ) : null}
          <Text style={[styles.provider, { color: theme.secondaryText }]} numberOfLines={1}>
            {source}
          </Text>
        </View>
      </Pressable>
    );
  }

  // Fallback card when no image is available
  return (
    <Pressable
      style={[styles.mediaCard, { borderColor: theme.border, backgroundColor: theme.badgeBg }]}
      onPress={() => void Linking.openURL(url).catch(() => {})}
    >
      <View style={styles.mediaFooter}>
        <Text style={[styles.title, { color: theme.text }]} numberOfLines={2}>
          {title}
        </Text>
        {description ? (
          <Text style={[styles.description, { color: theme.text }]} numberOfLines={3}>
            {description}
          </Text>
        ) : null}
        <Text style={[styles.provider, { color: theme.secondaryText }]} numberOfLines={1}>
          {source}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  mediaCard: {
    borderWidth: 1,
    borderRadius: 12,
    overflow: 'hidden',
    marginVertical: 6,
  },
  imageContainer: {
    position: 'relative',
    width: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  fullImage: {
    width: '100%',
    backgroundColor: '#00000010',
  },
  playButtonOverlay: {
    position: 'absolute',
    width: 48,
    height: 48,
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 4,
  },
  mediaFooter: {
    padding: 12,
    gap: 4,
  },
  title: {
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 18,
  },
  description: {
    fontSize: 12,
    lineHeight: 16,
  },
  provider: {
    fontSize: 11,
    marginTop: 2,
  },
  fileAttachmentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  fileAttachmentText: {
    fontSize: 14,
    fontWeight: '500',
    flex: 1,
  },
});
