import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { ChecklistItem, NOTE_COLORS, NoteColorId, NoteItem } from '../types/note';
import ColorPicker from './ColorPicker';
import MarkdownView from './MarkdownView';

type Props = {
  visible: boolean;
  initialNote: NoteItem | null; // null means create new note
  initialIsChecklist?: boolean;
  onClose: () => void;
  onSave: (note: Partial<NoteItem> & { title: string }) => Promise<void>;
  onDelete?: (noteId: string, path: string) => Promise<void>;
};

export default function NoteEditorModal({
  visible,
  initialNote,
  initialIsChecklist = false,
  onClose,
  onSave,
  onDelete,
}: Props) {
  const insets = useSafeAreaInsets();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [isChecklist, setIsChecklist] = useState(initialIsChecklist);
  const [checklistItems, setChecklistItems] = useState<ChecklistItem[]>([]);
  const [newItemText, setNewItemText] = useState('');
  const [pinned, setPinned] = useState(false);
  const [color, setColor] = useState<NoteColorId>('default');
  const [labels, setLabels] = useState<string[]>([]);
  const [newLabelText, setNewLabelText] = useState('');
  const [showLabelInput, setShowLabelInput] = useState(false);
  const [previewMode, setPreviewMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (visible) {
      if (initialNote) {
        setTitle(initialNote.title || '');
        setContent(initialNote.content || '');
        setIsChecklist(initialNote.isChecklist);
        setChecklistItems(initialNote.checklistItems ? [...initialNote.checklistItems] : []);
        setPinned(initialNote.pinned);
        setColor(initialNote.color || 'default');
        setLabels(initialNote.labels ? [...initialNote.labels] : []);
      } else {
        setTitle('');
        setContent('');
        setIsChecklist(initialIsChecklist);
        setChecklistItems([]);
        setPinned(false);
        setColor('default');
        setLabels([]);
      }
      setNewItemText('');
      setNewLabelText('');
      setShowLabelInput(false);
      setPreviewMode(false);
    }
  }, [visible, initialNote, initialIsChecklist]);

  const theme = NOTE_COLORS[color] || NOTE_COLORS.default;

  const handleAddCheckitem = () => {
    if (!newItemText.trim()) return;
    const newItem: ChecklistItem = {
      id: `item_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      text: newItemText.trim(),
      completed: false,
    };
    setChecklistItems((prev: ChecklistItem[]) => [...prev, newItem]);
    setNewItemText('');
  };

  const handleToggleCheckitem = (id: string) => {
    setChecklistItems((prev: ChecklistItem[]) =>
      prev.map((item: ChecklistItem) => (item.id === id ? { ...item, completed: !item.completed } : item))
    );
  };

  const handleRemoveCheckitem = (id: string) => {
    setChecklistItems((prev: ChecklistItem[]) => prev.filter((item: ChecklistItem) => item.id !== id));
  };

  const handleAddLabel = () => {
    const trimmed = newLabelText.trim().replace(/^#/, '');
    if (trimmed && !labels.includes(trimmed)) {
      setLabels((prev: string[]) => [...prev, trimmed]);
    }
    setNewLabelText('');
    setShowLabelInput(false);
  };

  const handleRemoveLabel = (labelToRemove: string) => {
    setLabels((prev: string[]) => prev.filter((l: string) => l !== labelToRemove));
  };

  const handleSave = async () => {
    const trimmedTitle = title.trim();
    const hasItems = isChecklist && checklistItems.length > 0;
    const hasText = content.trim().length > 0;

    if (!trimmedTitle && !hasItems && !hasText) {
      onClose();
      return;
    }

    setSaving(true);
    try {
      await onSave({
        id: initialNote?.id,
        path: initialNote?.path,
        title: trimmedTitle || (hasItems ? 'Shopping List' : 'Note'),
        content,
        isChecklist,
        checklistItems,
        pinned,
        color,
        labels,
        createdAt: initialNote?.createdAt,
      });
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save note';
      Alert.alert('Save error', msg);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = () => {
    if (!initialNote || !onDelete) return;
    Alert.alert('Delete note', 'Are you sure you want to delete this note?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          setDeleting(true);
          try {
            await onDelete(initialNote.id, initialNote.path);
            onClose();
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to delete note';
            Alert.alert('Delete error', msg);
          } finally {
            setDeleting(false);
          }
        },
      },
    ]);
  };

  const insertMarkdownSyntax = (prefix: string, suffix: string = '') => {
    setContent((prev: string) => `${prev}\n${prefix}${suffix}`);
  };

  const uncompletedItems = checklistItems.filter((i) => !i.completed);
  const completedItems = checklistItems.filter((i) => i.completed);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.container, { backgroundColor: theme.bg, paddingTop: insets.top + 10 }]}>
        {/* Header toolbar */}
        <View style={[styles.header, { borderBottomColor: theme.border }]}>
          <Pressable onPress={onClose} hitSlop={10}>
            <Ionicons name="arrow-back" size={24} color={theme.text} />
          </Pressable>
          <View style={styles.headerRight}>
            <Pressable
              onPress={() => setIsChecklist((prev: boolean) => !prev)}
              style={styles.headerIconBtn}
              hitSlop={8}
            >
              <Ionicons
                name={isChecklist ? 'document-text-outline' : 'checkbox-outline'}
                size={22}
                color={theme.text}
              />
            </Pressable>
            <Pressable
              onPress={() => setPreviewMode((prev: boolean) => !prev)}
              style={styles.headerIconBtn}
              hitSlop={8}
            >
              <Ionicons
                name={previewMode ? 'create-outline' : 'eye-outline'}
                size={22}
                color={theme.text}
              />
            </Pressable>
            <Pressable onPress={() => setPinned((prev: boolean) => !prev)} style={styles.headerIconBtn} hitSlop={8}>
              <Ionicons
                name={pinned ? 'pin' : 'pin-outline'}
                size={22}
                color={pinned ? '#0f172a' : theme.text}
              />
            </Pressable>
            {initialNote && onDelete ? (
              <Pressable onPress={handleDelete} style={styles.headerIconBtn} hitSlop={8} disabled={deleting}>
                <Ionicons name="trash-outline" size={22} color="#dc2626" />
              </Pressable>
            ) : null}
            <Pressable
              style={[styles.saveBtn, { backgroundColor: theme.accent }]}
              onPress={() => void handleSave()}
              disabled={saving}
            >
              {saving ? (
                <ActivityIndicator size="small" color="#ffffff" />
              ) : (
                <Text style={styles.saveBtnText}>Save</Text>
              )}
            </Pressable>
          </View>
        </View>

        {/* Note Body Scroll View */}
        <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
          {/* Title Input */}
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="Title"
            placeholderTextColor={theme.secondaryText}
            style={[styles.titleInput, { color: theme.text }]}
            multiline={false}
          />

          {/* Labels Row */}
          <View style={styles.labelsContainer}>
            {labels.map((label: string, idx: number) => (
              <View key={idx} style={[styles.labelChip, { backgroundColor: theme.badgeBg }]}>
                <Text style={[styles.labelChipText, { color: theme.text }]}>#{label}</Text>
                <Pressable onPress={() => handleRemoveLabel(label)} hitSlop={6}>
                  <Ionicons name="close-circle" size={14} color={theme.secondaryText} />
                </Pressable>
              </View>
            ))}
            {showLabelInput ? (
              <View style={styles.addLabelInputRow}>
                <TextInput
                  value={newLabelText}
                  onChangeText={setNewLabelText}
                  placeholder="tag name"
                  placeholderTextColor={theme.secondaryText}
                  style={[styles.labelTextInput, { color: theme.text, borderColor: theme.border }]}
                  autoCapitalize="none"
                  onSubmitEditing={handleAddLabel}
                  autoFocus
                />
                <Pressable onPress={handleAddLabel} hitSlop={6}>
                  <Ionicons name="checkmark-circle" size={20} color={theme.accent} />
                </Pressable>
              </View>
            ) : (
              <Pressable
                style={[styles.addLabelBtn, { borderColor: theme.border }]}
                onPress={() => setShowLabelInput(true)}
              >
                <Ionicons name="add" size={14} color={theme.secondaryText} />
                <Text style={[styles.addLabelText, { color: theme.secondaryText }]}>Add tag</Text>
              </Pressable>
            )}
          </View>

          {/* Mode Switch: Preview vs Edit vs Checklist */}
          {previewMode ? (
            <View style={styles.previewContainer}>
              <Text style={[styles.sectionHeading, { color: theme.secondaryText }]}>Live Preview</Text>
              <MarkdownView content={content} theme={theme} />
            </View>
          ) : isChecklist ? (
            <View style={styles.checklistSection}>
              <Text style={[styles.sectionHeading, { color: theme.secondaryText }]}>
                List Items ({checklistItems.length})
              </Text>

              {/* Add item input */}
              <View style={[styles.addItemRow, { borderColor: theme.border, backgroundColor: theme.cardBg }]}>
                <Ionicons name="add" size={20} color={theme.accent} />
                <TextInput
                  value={newItemText}
                  onChangeText={setNewItemText}
                  placeholder="List item..."
                  placeholderTextColor={theme.secondaryText}
                  style={[styles.addItemInput, { color: theme.text }]}
                  onSubmitEditing={handleAddCheckitem}
                />
                {newItemText ? (
                  <Pressable onPress={handleAddCheckitem} hitSlop={6}>
                    <Text style={[styles.addBtnText, { color: theme.accent }]}>Add</Text>
                  </Pressable>
                ) : null}
              </View>

              {/* Uncompleted items */}
              {uncompletedItems.map((item: ChecklistItem) => (
                <View key={item.id} style={[styles.checkItemRow, { borderBottomColor: theme.border }]}>
                  <Pressable onPress={() => handleToggleCheckitem(item.id)} hitSlop={8}>
                    <Ionicons name="square-outline" size={20} color={theme.accent} />
                  </Pressable>
                  <TextInput
                    value={item.text}
                    onChangeText={(txt: string) =>
                      setChecklistItems((prev: ChecklistItem[]) =>
                        prev.map((i: ChecklistItem) => (i.id === item.id ? { ...i, text: txt } : i))
                      )
                    }
                    style={[styles.checkItemInput, { color: theme.text }]}
                  />
                  <Pressable onPress={() => handleRemoveCheckitem(item.id)} hitSlop={8}>
                    <Ionicons name="close" size={18} color={theme.secondaryText} />
                  </Pressable>
                </View>
              ))}

              {/* Completed items */}
              {completedItems.length > 0 ? (
                <View style={styles.completedSection}>
                  <Text style={[styles.completedHeading, { color: theme.secondaryText }]}>
                    Completed ({completedItems.length})
                  </Text>
                  {completedItems.map((item: ChecklistItem) => (
                    <View key={item.id} style={[styles.checkItemRow, { borderBottomColor: theme.border }]}>
                      <Pressable onPress={() => handleToggleCheckitem(item.id)} hitSlop={8}>
                        <Ionicons name="checkbox" size={20} color={theme.secondaryText} />
                      </Pressable>
                      <Text style={[styles.completedItemText, { color: theme.secondaryText }]}>
                        {item.text}
                      </Text>
                      <Pressable onPress={() => handleRemoveCheckitem(item.id)} hitSlop={8}>
                        <Ionicons name="close" size={18} color={theme.secondaryText} />
                      </Pressable>
                    </View>
                  ))}
                </View>
              ) : null}
            </View>
          ) : (
            <View style={styles.textEditorSection}>
              {/* Markdown Toolbar */}
              <View style={[styles.formattingBar, { borderBottomColor: theme.border }]}>
                <Pressable style={styles.toolBtn} onPress={() => insertMarkdownSyntax('# ')}>
                  <Text style={[styles.toolBtnText, { color: theme.text }]}>H1</Text>
                </Pressable>
                <Pressable style={styles.toolBtn} onPress={() => insertMarkdownSyntax('## ')}>
                  <Text style={[styles.toolBtnText, { color: theme.text }]}>H2</Text>
                </Pressable>
                <Pressable style={styles.toolBtn} onPress={() => insertMarkdownSyntax('**', '**')}>
                  <Text style={[styles.toolBtnText, { color: theme.text, fontWeight: '700' }]}>B</Text>
                </Pressable>
                <Pressable style={styles.toolBtn} onPress={() => insertMarkdownSyntax('*', '*')}>
                  <Text style={[styles.toolBtnText, { color: theme.text, fontStyle: 'italic' }]}>I</Text>
                </Pressable>
                <Pressable style={styles.toolBtn} onPress={() => insertMarkdownSyntax('- ')}>
                  <Ionicons name="list" size={16} color={theme.text} />
                </Pressable>
                <Pressable style={styles.toolBtn} onPress={() => insertMarkdownSyntax('- [ ] ')}>
                  <Ionicons name="checkbox-outline" size={16} color={theme.text} />
                </Pressable>
                <Pressable style={styles.toolBtn} onPress={() => insertMarkdownSyntax('`', '`')}>
                  <Ionicons name="code-slash" size={16} color={theme.text} />
                </Pressable>
              </View>

              <TextInput
                value={content}
                onChangeText={setContent}
                placeholder="Note text (Markdown supported)..."
                placeholderTextColor={theme.secondaryText}
                style={[styles.contentInput, { color: theme.text }]}
                multiline
                textAlignVertical="top"
              />
            </View>
          )}

          {/* Color Picker */}
          <ColorPicker selectedColor={color} onSelectColor={setColor} />
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  headerIconBtn: {
    padding: 4,
  },
  saveBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
  },
  saveBtnText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 14,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 18,
  },
  titleInput: {
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 12,
    padding: 0,
  },
  labelsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    marginBottom: 16,
  },
  labelChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 14,
  },
  labelChipText: {
    fontSize: 12,
    fontWeight: '600',
  },
  addLabelBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 14,
    borderWidth: 1,
    borderStyle: 'dashed',
  },
  addLabelText: {
    fontSize: 12,
  },
  addLabelInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  labelTextInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
    fontSize: 12,
    minWidth: 90,
  },
  sectionHeading: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  previewContainer: {
    minHeight: 200,
    marginBottom: 16,
  },
  checklistSection: {
    marginBottom: 16,
  },
  addItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 12,
  },
  addItemInput: {
    flex: 1,
    fontSize: 15,
  },
  addBtnText: {
    fontWeight: '700',
    fontSize: 14,
  },
  checkItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  checkItemInput: {
    flex: 1,
    fontSize: 15,
    padding: 0,
  },
  completedSection: {
    marginTop: 20,
  },
  completedHeading: {
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 8,
  },
  completedItemText: {
    flex: 1,
    fontSize: 15,
    textDecorationLine: 'line-through',
  },
  textEditorSection: {
    minHeight: 250,
    marginBottom: 16,
  },
  formattingBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    borderBottomWidth: 1,
    marginBottom: 12,
  },
  toolBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: 'rgba(0,0,0,0.04)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  toolBtnText: {
    fontSize: 13,
    fontWeight: '600',
  },
  contentInput: {
    fontSize: 16,
    lineHeight: 24,
    minHeight: 200,
  },
});
