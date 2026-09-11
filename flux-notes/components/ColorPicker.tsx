import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { NOTE_COLORS, NoteColorId } from '../types/note';

type Props = {
  selectedColor: NoteColorId;
  onSelectColor: (colorId: NoteColorId) => void;
};

export default function ColorPicker({ selectedColor, onSelectColor }: Props) {
  const colorIds = Object.keys(NOTE_COLORS) as NoteColorId[];

  return (
    <View style={styles.container}>
      <Text style={styles.label}>Note Theme</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
        {colorIds.map((id) => {
          const colorTheme = NOTE_COLORS[id];
          const isSelected = selectedColor === id;
          return (
            <Pressable
              key={id}
              style={[
                styles.colorSwatch,
                { backgroundColor: colorTheme.cardBg, borderColor: colorTheme.border },
                isSelected && styles.selectedSwatch,
              ]}
              onPress={() => onSelectColor(id)}
              hitSlop={6}
            >
              {isSelected ? (
                <Ionicons name="checkmark" size={18} color={colorTheme.text} />
              ) : null}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginVertical: 8,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748b',
    marginBottom: 8,
  },
  scrollContent: {
    flexDirection: 'row',
    gap: 10,
    paddingVertical: 4,
    paddingHorizontal: 2,
  },
  colorSwatch: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  selectedSwatch: {
    borderWidth: 2.5,
    borderColor: '#0f172a',
    transform: [{ scale: 1.1 }],
  },
});
