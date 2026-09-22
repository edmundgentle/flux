import React from 'react';
import { Image, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { NoteBlock, NoteColorTheme } from '../types/note';
import { parseBlocksFromMarkdown } from '../utils/markdownParser';
import OEmbedCard from './OEmbedCard';
import AudioAttachmentView from './AudioAttachmentView';
import VideoAttachmentBlock from './VideoAttachmentBlock';
import AspectRatioImage from './AspectRatioImage';

type Props = {
  content: string;
  theme: NoteColorTheme;
  numberOfLines?: number;
};

export default function MarkdownView({ content, theme, numberOfLines }: Props) {
  if (!content || !content.trim()) {
    return null;
  }

  const blocks: NoteBlock[] = parseBlocksFromMarkdown(content);
  const renderedElements: React.ReactNode[] = [];

  for (let i = 0; i < blocks.length; i++) {
    if (numberOfLines && renderedElements.length >= numberOfLines) {
      break;
    }

    const block = blocks[i];

    if (block.type === 'text') {
      if (block.isChecklist && block.checklistItems && block.checklistItems.length > 0) {
        for (let j = 0; j < block.checklistItems.length; j++) {
          if (numberOfLines && renderedElements.length >= numberOfLines) break;
          const item = block.checklistItems[j];
          renderedElements.push(
            <View key={`${block.id}_item_${j}`} style={styles.checkboxRow}>
              <Ionicons
                name={item.completed ? 'checkbox' : 'square-outline'}
                size={16}
                color={item.completed ? theme.secondaryText : theme.accent}
              />
              <Text
                style={[
                  styles.checkboxText,
                  { color: item.completed ? theme.secondaryText : theme.text },
                  item.completed && styles.strikethrough,
                  block.bold && styles.bold,
                  block.italic && styles.italic,
                  block.underline && styles.underline,
                ]}
                numberOfLines={numberOfLines ? 1 : undefined}
              >
                {item.text}
              </Text>
            </View>
          );
        }
        continue;
      }

      if (!block.text || !block.text.trim()) continue;

      const lines = block.text.split('\n');
      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        if (numberOfLines && renderedElements.length >= numberOfLines) break;
        const line = lines[lineIdx];
        if (!line.trim()) continue;

        const styleList: any[] = [
          styles.bodyText,
          { color: theme.text },
          block.variant === 'h1' && styles.h1,
          block.variant === 'h2' && styles.h2,
          block.bold && styles.bold,
          block.italic && styles.italic,
          block.underline && styles.underline,
          block.strikethrough && styles.strikethrough,
        ];

        renderedElements.push(
          <Text
            key={`${block.id}_line_${lineIdx}`}
            style={styleList}
            numberOfLines={numberOfLines ? 1 : undefined}
          >
            {formatInlineMarkdown(line)}
          </Text>
        );
      }
      continue;
    }

    if (block.type === 'attachment') {
      if (block.attachmentType === 'image') {
        renderedElements.push(
          <View key={block.id} style={styles.mediaBlock}>
            <AspectRatioImage uri={block.uri} style={styles.inlineImage} />
            {block.name ? (
              <Text style={[styles.mediaCaption, { color: theme.secondaryText }]}>{block.name}</Text>
            ) : null}
          </View>
        );
      } else if (block.attachmentType === 'video') {
        if (numberOfLines) {
          renderedElements.push(
            <View key={block.id} style={[styles.fileAttachment, { borderColor: theme.border, backgroundColor: theme.badgeBg }]}>
              <Ionicons name="videocam-outline" size={16} color={theme.accent} />
              <Text style={[styles.fileAttachmentText, { color: theme.text }]} numberOfLines={1}>
                {block.name || 'Video'}
              </Text>
            </View>
          );
        } else {
          renderedElements.push(
            <VideoAttachmentBlock
              key={block.id}
              uri={block.uri}
              name={block.name}
              theme={theme}
            />
          );
        }
      } else if (block.attachmentType === 'audio') {
        if (numberOfLines) {
          renderedElements.push(
            <View key={block.id} style={[styles.fileAttachment, { borderColor: theme.border, backgroundColor: theme.badgeBg }]}>
              <Ionicons name="musical-notes-outline" size={16} color={theme.accent} />
              <Text style={[styles.fileAttachmentText, { color: theme.text }]} numberOfLines={1}>
                {block.name || 'Audio clip'}
              </Text>
            </View>
          );
        } else {
          renderedElements.push(
            <AudioAttachmentView
              key={block.id}
              uri={block.uri}
              name={block.name}
              waveform={block.waveform}
              durationMs={block.durationMs}
              transcript={block.transcript}
              transcriptStatus={block.transcriptStatus}
              theme={theme}
            />
          );
        }
      } else if (block.attachmentType === 'link') {
        if (!numberOfLines && /^https?:\/\/\S+$/.test(block.uri.trim())) {
          renderedElements.push(<OEmbedCard key={block.id} url={block.uri.trim()} theme={theme} />);
        } else {
          renderedElements.push(
            <Pressable
              key={block.id}
              onPress={() => void Linking.openURL(block.uri).catch(() => {})}
              style={[styles.fileAttachment, { borderColor: theme.border, backgroundColor: theme.badgeBg }]}
            >
              <Ionicons name="globe-outline" size={16} color={theme.accent} />
              <Text style={[styles.fileAttachmentText, { color: theme.accent, textDecorationLine: 'underline' }]} numberOfLines={1}>
                {block.name || block.uri}
              </Text>
            </Pressable>
          );
        }
      } else if (block.attachmentType === 'file') {
        renderedElements.push(
          <View key={block.id} style={[styles.fileAttachment, { borderColor: theme.border, backgroundColor: theme.badgeBg }]}>
            <Ionicons name="attach-outline" size={16} color={theme.accent} />
            <Text style={[styles.fileAttachmentText, { color: theme.text }]} numberOfLines={1}>
              {block.name || 'File attachment'}
            </Text>
          </View>
        );
      }
    }
  }

  return <View style={styles.container}>{renderedElements}</View>;
}

function formatInlineMarkdown(text: string, inheritedStyle: any = {}): React.ReactNode {
  if (!text) return null;
  const parts = text.split(/(\*\*[\s\S]*?\*\*|\*[\s\S]*?\*|`[\s\S]*?`|~~[\s\S]*?~~|<u>[\s\S]*?<\/u>)/g);
  return parts.map((part, index) => {
    if (!part) return null;
    if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
      const nextStyle = { ...inheritedStyle, fontWeight: '700' as const };
      return (
        <Text key={index} style={nextStyle}>
          {formatInlineMarkdown(part.slice(2, -2), nextStyle)}
        </Text>
      );
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length >= 2) {
      const nextStyle = { ...inheritedStyle, fontStyle: 'italic' as const };
      return (
        <Text key={index} style={nextStyle}>
          {formatInlineMarkdown(part.slice(1, -1), nextStyle)}
        </Text>
      );
    }
    if (part.startsWith('~~') && part.endsWith('~~') && part.length >= 4) {
      const nextStyle = { ...inheritedStyle, textDecorationLine: 'line-through' as const };
      return (
        <Text key={index} style={nextStyle}>
          {formatInlineMarkdown(part.slice(2, -2), nextStyle)}
        </Text>
      );
    }
    if (part.startsWith('<u>') && part.endsWith('</u>') && part.length >= 7) {
      const nextStyle = { ...inheritedStyle, textDecorationLine: 'underline' as const };
      return (
        <Text key={index} style={nextStyle}>
          {formatInlineMarkdown(part.slice(3, -4), nextStyle)}
        </Text>
      );
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      return (
        <Text key={index} style={[styles.inlineCode, inheritedStyle]}>
          {part.slice(1, -1)}
        </Text>
      );
    }
    return (
      <Text key={index} style={inheritedStyle}>
        {part}
      </Text>
    );
  });
}

const styles = StyleSheet.create({
  container: {
    gap: 6,
  },
  h1: {
    fontSize: 20,
    fontWeight: '700',
    marginTop: 6,
    marginBottom: 2,
    lineHeight: 26,
  },
  h2: {
    fontSize: 17,
    fontWeight: '700',
    marginTop: 4,
    marginBottom: 2,
    lineHeight: 22,
  },
  bodyText: {
    fontSize: 15,
    lineHeight: 22,
  },
  bold: {
    fontWeight: '700',
  },
  italic: {
    fontStyle: 'italic',
  },
  underline: {
    textDecorationLine: 'underline',
  },
  strikethrough: {
    textDecorationLine: 'line-through',
  },
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginVertical: 2,
  },
  checkboxText: {
    fontSize: 15,
    flex: 1,
  },
  mediaBlock: {
    marginVertical: 4,
    borderRadius: 12,
    overflow: 'hidden',
  },
  inlineImage: {
    width: '100%',
    borderRadius: 10,
    backgroundColor: '#00000010',
  },
  mediaCaption: {
    fontSize: 12,
    marginTop: 4,
  },
  fileAttachment: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    marginVertical: 2,
  },
  fileAttachmentText: {
    fontSize: 13,
    fontWeight: '500',
    flex: 1,
  },
  inlineCode: {
    fontFamily: 'monospace',
    backgroundColor: 'rgba(0,0,0,0.06)',
    paddingHorizontal: 4,
    borderRadius: 4,
    fontSize: 13,
  },
});
