import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { NoteColorTheme } from '../types/note';

type Props = {
  content: string;
  theme: NoteColorTheme;
  numberOfLines?: number;
};

export default function MarkdownView({ content, theme, numberOfLines }: Props) {
  if (!content || !content.trim()) {
    return null;
  }

  const lines = content.split('\n');
  const renderedLines: React.ReactNode[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (numberOfLines && renderedLines.length >= numberOfLines) {
      break;
    }

    const line = lines[i];
    if (line.startsWith('---')) continue; // Skip frontmatter dividers if any

    // Headers
    if (line.startsWith('# ')) {
      renderedLines.push(
        <Text key={i} style={[styles.h1, { color: theme.text }]} numberOfLines={1}>
          {line.replace(/^#\s+/, '')}
        </Text>
      );
      continue;
    }
    if (line.startsWith('## ')) {
      renderedLines.push(
        <Text key={i} style={[styles.h2, { color: theme.text }]} numberOfLines={1}>
          {line.replace(/^##\s+/, '')}
        </Text>
      );
      continue;
    }
    if (line.startsWith('### ')) {
      renderedLines.push(
        <Text key={i} style={[styles.h3, { color: theme.text }]} numberOfLines={1}>
          {line.replace(/^###\s+/, '')}
        </Text>
      );
      continue;
    }

    // Checkboxes
    const checkMatch = line.match(/^\s*[-*]\s*\[([ xX])\]\s*(.*)$/);
    if (checkMatch) {
      const isDone = checkMatch[1].toLowerCase() === 'x';
      const itemText = checkMatch[2];
      renderedLines.push(
        <View key={i} style={styles.checkboxRow}>
          <Ionicons
            name={isDone ? 'checkbox' : 'square-outline'}
            size={16}
            color={isDone ? theme.secondaryText : theme.accent}
          />
          <Text
            style={[
              styles.checkboxText,
              { color: isDone ? theme.secondaryText : theme.text },
              isDone && styles.strikethrough,
            ]}
            numberOfLines={numberOfLines ? 1 : undefined}
          >
            {itemText}
          </Text>
        </View>
      );
      continue;
    }

    // Bullets
    if (line.match(/^\s*[-*]\s+/)) {
      const bulletText = line.replace(/^\s*[-*]\s+/, '');
      renderedLines.push(
        <View key={i} style={styles.bulletRow}>
          <Text style={[styles.bulletDot, { color: theme.accent }]}>•</Text>
          <Text
            style={[styles.bodyText, { color: theme.text }]}
            numberOfLines={numberOfLines ? 1 : undefined}
          >
            {bulletText}
          </Text>
        </View>
      );
      continue;
    }

    // Normal paragraph
    if (line.trim().length > 0) {
      renderedLines.push(
        <Text
          key={i}
          style={[styles.bodyText, { color: theme.text }]}
          numberOfLines={numberOfLines ? 1 : undefined}
        >
          {formatInlineMarkdown(line)}
        </Text>
      );
    }
  }

  return <View style={styles.container}>{renderedLines}</View>;
}

function formatInlineMarkdown(text: string): React.ReactNode[] {
  // Simple bold/italic inline parser
  const parts = text.split(/(\*\*.*?\*\*|\*.*?\*|`.*?`)/g);
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <Text key={index} style={{ fontWeight: '700' }}>
          {part.slice(2, -2)}
        </Text>
      );
    }
    if (part.startsWith('*') && part.endsWith('*')) {
      return (
        <Text key={index} style={{ fontStyle: 'italic' }}>
          {part.slice(1, -1)}
        </Text>
      );
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <Text key={index} style={styles.inlineCode}>
          {part.slice(1, -1)}
        </Text>
      );
    }
    return part;
  });
}

const styles = StyleSheet.create({
  container: {
    gap: 4,
  },
  h1: {
    fontSize: 18,
    fontWeight: '700',
    marginTop: 4,
    marginBottom: 2,
  },
  h2: {
    fontSize: 16,
    fontWeight: '700',
    marginTop: 3,
    marginBottom: 2,
  },
  h3: {
    fontSize: 14,
    fontWeight: '600',
    marginTop: 2,
    marginBottom: 1,
  },
  bodyText: {
    fontSize: 14,
    lineHeight: 20,
  },
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginVertical: 2,
  },
  checkboxText: {
    fontSize: 14,
    flex: 1,
  },
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    marginVertical: 1,
  },
  bulletDot: {
    fontSize: 16,
    lineHeight: 20,
  },
  strikethrough: {
    textDecorationLine: 'line-through',
    opacity: 0.7,
  },
  inlineCode: {
    fontFamily: 'monospace',
    backgroundColor: 'rgba(0,0,0,0.06)',
    borderRadius: 4,
    paddingHorizontal: 4,
    fontSize: 13,
  },
});
