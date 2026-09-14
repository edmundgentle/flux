import React, { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { NoteColorTheme } from '../types/note';

type BlockKind = 'paragraph' | 'heading1' | 'heading2' | 'bullet' | 'checkbox';
type Block = { id: string; kind: BlockKind; text: string; checked?: boolean; bold?: boolean; italic?: boolean };

type Props = { value: string; onChange: (markdown: string) => void; theme: NoteColorTheme };

export type VisualNoteEditorHandle = {
  addBlock: (kind: BlockKind) => void;
  toggleStyle: (style: 'bold' | 'italic') => void;
};

function unwrap(text: string, marker: string): { text: string; applied: boolean } {
  if (text.length >= marker.length * 2 && text.startsWith(marker) && text.endsWith(marker)) {
    return { text: text.slice(marker.length, -marker.length), applied: true };
  }
  return { text, applied: false };
}

const parseBlocks = (markdown: string): Block[] => markdown.split('\n').map((line, index) => {
  const check = line.match(/^\s*[-*]\s*\[([ xX])\]\s*(.*)$/);
  let kind: BlockKind = 'paragraph';
  let rest = line;
  let checked: boolean | undefined;
  if (check) {
    kind = 'checkbox';
    checked = check[1].toLowerCase() === 'x';
    rest = check[2];
  } else if (line.startsWith('# ')) {
    kind = 'heading1';
    rest = line.slice(2);
  } else if (line.startsWith('## ')) {
    kind = 'heading2';
    rest = line.slice(3);
  } else if (/^\s*[-*]\s+/.test(line)) {
    kind = 'bullet';
    rest = line.replace(/^\s*[-*]\s+/, '');
  }
  const boldResult = unwrap(rest, '**');
  const italicResult = unwrap(boldResult.text, '*');
  return { id: `${index}`, kind, checked, text: italicResult.text, bold: boldResult.applied, italic: italicResult.applied };
});

const serialize = (blocks: Block[]) => blocks.map((block) => {
  let text = block.text;
  if (block.italic) text = `*${text}*`;
  if (block.bold) text = `**${text}**`;
  if (block.kind === 'heading1') return `# ${text}`;
  if (block.kind === 'heading2') return `## ${text}`;
  if (block.kind === 'bullet') return `- ${text}`;
  if (block.kind === 'checkbox') return `- [${block.checked ? 'x' : ' '}] ${text}`;
  return text;
}).join('\n');

const VisualNoteEditor = forwardRef<VisualNoteEditorHandle, Props>(({ value, onChange, theme }, ref) => {
  const [blocks, setBlocks] = useState<Block[]>(() => parseBlocks(value));
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  useEffect(() => setBlocks(parseBlocks(value)), [value]);
  const update = (next: Block[]) => { setBlocks(next); onChange(serialize(next)); };

  useImperativeHandle(ref, () => ({
    addBlock: (kind: BlockKind) => update([...blocks, { id: `${Date.now()}`, kind, text: '', checked: false }]),
    toggleStyle: (style: 'bold' | 'italic') => {
      if (focusedIndex === null) return;
      update(blocks.map((item, i) => i === focusedIndex ? { ...item, [style]: !item[style] } : item));
    },
  }), [blocks, focusedIndex]);

  return <View style={styles.container}>
    {blocks.map((block, index) => <View key={block.id} style={styles.row}>
      {block.kind === 'checkbox' ? <Pressable onPress={() => update(blocks.map((item, i) => i === index ? { ...item, checked: !item.checked } : item))}>
        <Ionicons name={block.checked ? 'checkbox' : 'square-outline'} size={20} color={theme.accent} />
      </Pressable> : null}
      {block.kind === 'bullet' ? <Ionicons name="ellipse" size={7} color={theme.accent} style={styles.bullet} /> : null}
      <TextInput value={block.text} onChangeText={(text) => update(blocks.map((item, i) => i === index ? { ...item, text } : item))}
        onFocus={() => setFocusedIndex(index)}
        multiline placeholder={index === 0 ? 'Start writing…' : ''} placeholderTextColor={theme.secondaryText}
        style={[styles.input, { color: theme.text }, block.kind === 'heading1' && styles.h1, block.kind === 'heading2' && styles.h2,
          block.bold && styles.bold, block.italic && styles.italic, block.checked && styles.done]} />
    </View>)}
    <View style={styles.addRow}>
      <Pressable onPress={() => update([...blocks, { id: `${Date.now()}`, kind: 'paragraph', text: '' }])}><Ionicons name="add-circle-outline" size={22} color={theme.accent} /></Pressable>
      <Pressable onPress={() => update([...blocks, { id: `${Date.now()}`, kind: 'heading1', text: '' }])}><Ionicons name="text-outline" size={21} color={theme.accent} /></Pressable>
      <Pressable onPress={() => update([...blocks, { id: `${Date.now()}`, kind: 'bullet', text: '' }])}><Ionicons name="list-outline" size={22} color={theme.accent} /></Pressable>
      <Pressable onPress={() => update([...blocks, { id: `${Date.now()}`, kind: 'checkbox', text: '', checked: false }])}><Ionicons name="checkbox-outline" size={22} color={theme.accent} /></Pressable>
    </View>
  </View>;
});

export default VisualNoteEditor;

const styles = StyleSheet.create({
  container: { minHeight: 220 }, row: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, minHeight: 30 },
  bullet: { marginTop: 11, marginHorizontal: 6 }, input: { flex: 1, fontSize: 16, lineHeight: 24, paddingVertical: 3 },
  h1: { fontSize: 24, fontWeight: '700', lineHeight: 30 }, h2: { fontSize: 20, fontWeight: '700', lineHeight: 27 },
  bold: { fontWeight: '700' }, italic: { fontStyle: 'italic' },
  done: { textDecorationLine: 'line-through', opacity: 0.65 }, addRow: { flexDirection: 'row', gap: 18, marginTop: 8 },
});

