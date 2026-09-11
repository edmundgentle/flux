import React from 'react';
import { Pressable, StyleSheet, Text, View, GestureResponderEvent } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { NOTE_COLORS, NoteItem } from '../types/note';
import MarkdownView from './MarkdownView';

type Props = {
  note: NoteItem;
  onPress: () => void;
  onTogglePin?: () => void;
  onToggleCheckItem?: (itemId: string) => void;
  cardWidth?: number | string;
};

export default function NoteCard({
  note,
  onPress,
  onTogglePin,
  onToggleCheckItem,
  cardWidth = '100%',
}: Props) {
  const theme = NOTE_COLORS[note.color] || NOTE_COLORS.default;

  const formattedDate = new Date(note.updatedAt || note.createdAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });

  return (
    <Pressable
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: theme.cardBg,
          borderColor: theme.border,
          width: cardWidth as any,
        },
        pressed && styles.pressed,
      ]}
      onPress={onPress}
    >
      <View style={styles.header}>
        <Text style={[styles.title, { color: theme.text }]} numberOfLines={2}>
          {note.title || 'Untitled Note'}
        </Text>
        {onTogglePin ? (
          <Pressable
            onPress={(e: GestureResponderEvent) => {
              e.stopPropagation();
              onTogglePin();
            }}
            hitSlop={8}
          >
            <Ionicons
              name={note.pinned ? 'pin' : 'pin-outline'}
              size={18}
              color={note.pinned ? '#0f172a' : theme.secondaryText}
            />
          </Pressable>
        ) : null}
      </View>

      <View style={styles.contentContainer}>
        {note.isChecklist && note.checklistItems.length > 0 ? (
          <View style={styles.checklistPreview}>
            {note.checklistItems.slice(0, 5).map((item) => (
              <Pressable
                key={item.id}
                style={styles.checkRow}
                onPress={(e: GestureResponderEvent) => {
                  if (onToggleCheckItem) {
                    e.stopPropagation();
                    onToggleCheckItem(item.id);
                  }
                }}
              >
                <Ionicons
                  name={item.completed ? 'checkbox' : 'square-outline'}
                  size={16}
                  color={item.completed ? theme.secondaryText : theme.accent}
                />
                <Text
                  style={[
                    styles.checkText,
                    { color: item.completed ? theme.secondaryText : theme.text },
                    item.completed && styles.strikethrough,
                  ]}
                  numberOfLines={1}
                >
                  {item.text}
                </Text>
              </Pressable>
            ))}
            {note.checklistItems.length > 5 ? (
              <Text style={[styles.moreText, { color: theme.secondaryText }]}>
                +{note.checklistItems.length - 5} more items
              </Text>
            ) : null}
          </View>
        ) : (
          <MarkdownView content={note.content} theme={theme} numberOfLines={6} />
        )}
      </View>

      {note.labels && note.labels.length > 0 ? (
        <View style={styles.labelsRow}>
          {note.labels.map((label, index) => (
            <View key={index} style={[styles.labelChip, { backgroundColor: theme.badgeBg }]}>
              <Text style={[styles.labelChipText, { color: theme.text }]}>#{label}</Text>
            </View>
          ))}
        </View>
      ) : null}

      <View style={styles.footer}>
        <Text style={[styles.dateText, { color: theme.secondaryText }]}>{formattedDate}</Text>
        {note.pinned ? (
          <View style={[styles.pinnedBadge, { backgroundColor: theme.badgeBg }]}>
            <Text style={[styles.pinnedBadgeText, { color: theme.text }]}>Pinned</Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    marginBottom: 12,
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 2,
    overflow: 'hidden',
  },
  pressed: {
    opacity: 0.9,
    transform: [{ scale: 0.99 }],
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 8,
    marginBottom: 8,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    flex: 1,
    lineHeight: 22,
  },
  contentContainer: {
    marginBottom: 8,
  },
  checklistPreview: {
    gap: 6,
  },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  checkText: {
    fontSize: 14,
    flex: 1,
  },
  strikethrough: {
    textDecorationLine: 'line-through',
    opacity: 0.65,
  },
  moreText: {
    fontSize: 12,
    fontStyle: 'italic',
    marginTop: 2,
  },
  labelsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 6,
    marginBottom: 6,
  },
  labelChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
  },
  labelChipText: {
    fontSize: 11,
    fontWeight: '600',
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 4,
  },
  dateText: {
    fontSize: 11,
  },
  pinnedBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  pinnedBadgeText: {
    fontSize: 10,
    fontWeight: '700',
  },
});
