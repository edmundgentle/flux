import React, { useEffect, useRef, useState } from 'react';
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
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { RecordingPresets, requestRecordingPermissionsAsync, useAudioRecorder, useAudioRecorderState } from 'expo-audio';
import { ChecklistItem, NOTE_COLORS, NoteAttachment, NoteColorId, NoteItem } from '../types/note';
import ColorPicker from './ColorPicker';
import Popover from './Popover';
import AudioAttachmentView from './AudioAttachmentView';
import VisualNoteEditor, { VisualNoteEditorHandle } from './VisualNoteEditor';
import { transcribeAudio } from '../utils/transcribe';
import type { FluxClient } from '@flux-sdk/core';

type Props = {
  visible: boolean;
  initialNote: NoteItem | null; // null means create new note
  initialIsChecklist?: boolean;
  initialDraft?: { title?: string; content?: string; attachments?: NoteAttachment[] };
  client?: FluxClient;
  onClose: () => void;
  onSave: (note: Partial<NoteItem> & { title: string }) => Promise<void>;
  onDelete?: (noteId: string, path: string) => Promise<void>;
};

export default function NoteEditorModal({
  visible,
  initialNote,
  initialIsChecklist = false,
  initialDraft,
  client,
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
  const [attachments, setAttachments] = useState<NoteAttachment[]>([]);
  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true });
  const recorderState = useAudioRecorderState(recorder, 100);
  const meterSamplesRef = useRef<number[]>([]);
  const editorRef = useRef<VisualNoteEditorHandle>(null);
  const [newLabelText, setNewLabelText] = useState('');
  const [showLabelInput, setShowLabelInput] = useState(false);
  const [showFormatting, setShowFormatting] = useState(false);
  const [showColors, setShowColors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (recorderState.isRecording && typeof recorderState.metering === 'number') {
      // dB metering (~-160..0) normalised to 0..1 bar heights for the waveform.
      const normalized = Math.max(0, Math.min(1, (recorderState.metering + 60) / 60));
      meterSamplesRef.current.push(normalized);
    }
  }, [recorderState.isRecording, recorderState.metering]);

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
        setAttachments(initialNote.attachments ? [...initialNote.attachments] : []);
      } else {
        setTitle(initialDraft?.title || '');
        setContent(initialDraft?.content || '');
        setIsChecklist(initialIsChecklist);
        setChecklistItems([]);
        setPinned(false);
        setColor('default');
        setLabels([]);
        setAttachments(initialDraft?.attachments ? [...initialDraft.attachments] : []);
      }
      setNewItemText('');
      setNewLabelText('');
      setShowLabelInput(false);
      setShowFormatting(false);
      setShowColors(false);
    }
  }, [visible, initialNote, initialIsChecklist, initialDraft]);

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

  const addAttachment = (attachment: Omit<NoteAttachment, 'id'>) => {
    const item = { ...attachment, id: `attachment_${Date.now()}_${attachments.length}` };
    setAttachments((current) => [...current, item]);
    // Audio clips render inline via their waveform player, not as a markdown link.
    if (attachment.kind === 'audio') return item.id;
    const markdown = attachment.kind === 'image'
      ? `![${attachment.name}](${attachment.uri})`
      : `[${attachment.name}](${attachment.uri})`;
    setContent((current) => `${current}${current.trim() ? '\n\n' : ''}${markdown}`);
    return item.id;
  };

  const pickMedia = async (camera = false) => {
    if (camera) {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) return Alert.alert('Camera permission required');
    }
    const result = camera
      ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images', 'videos'], quality: 0.8 })
      : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], quality: 0.8 });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    addAttachment({ name: asset.fileName || `media-${Date.now()}`, uri: asset.uri, mimeType: asset.mimeType || 'application/octet-stream', kind: asset.type === 'video' ? 'video' : 'image' });
  };

  const importFile = async () => {
    const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    addAttachment({ name: asset.name, uri: asset.uri, mimeType: asset.mimeType || 'application/octet-stream', kind: 'file' });
  };

  const toggleRecording = async () => {
    if (recorder.isRecording) {
      const durationMs = recorder.currentTime * 1000;
      await recorder.stop();
      const waveform = meterSamplesRef.current;
      meterSamplesRef.current = [];
      if (recorder.uri) {
        const attachmentId = addAttachment({
          name: `recording-${Date.now()}.m4a`,
          uri: recorder.uri,
          mimeType: 'audio/m4a',
          kind: 'audio',
          waveform,
          durationMs,
          transcriptStatus: 'pending',
        });
        void transcribeIfPossible(attachmentId, recorder.uri);
      }
      return;
    }
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) return Alert.alert('Microphone permission required');
    meterSamplesRef.current = [];
    await recorder.prepareToRecordAsync();
    recorder.record();
  };

  const transcribeIfPossible = async (attachmentId: string, uri: string) => {
    const session = client?.getAuthSession();
    if (!session) {
      setAttachments((current) => current.map((a) => a.id === attachmentId ? { ...a, transcriptStatus: 'error' } : a));
      return;
    }
    const transcript = await transcribeAudio(uri, 'audio/m4a', session.token, session.instanceId);
    setAttachments((current) => current.map((a) => a.id === attachmentId
      ? { ...a, transcript: transcript || undefined, transcriptStatus: transcript ? 'ready' : 'error' }
      : a));
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
        attachments,
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

  const uncompletedItems = checklistItems.filter((i) => !i.completed);
  const completedItems = checklistItems.filter((i) => i.completed);
  const audioAttachments = attachments.filter((a) => a.kind === 'audio');

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
              onPress={() => setShowFormatting((prev: boolean) => !prev)}
              style={styles.headerIconBtn}
              hitSlop={8}
            >
              <Ionicons
                name="text-outline"
                size={22}
                color={theme.text}
              />
            </Pressable>
            <Pressable onPress={() => setShowColors((prev: boolean) => !prev)} style={styles.headerIconBtn} hitSlop={8}>
              <Ionicons name="color-palette-outline" size={22} color={theme.text} />
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

          {/* Mode Switch: Edit vs Checklist */}
          {isChecklist ? (
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
              <VisualNoteEditor ref={editorRef} value={content} onChange={setContent} theme={theme} />
              {audioAttachments.map((attachment) => (
                <AudioAttachmentView
                  key={attachment.id}
                  uri={attachment.uri}
                  name={attachment.name}
                  waveform={attachment.waveform}
                  durationMs={attachment.durationMs}
                  transcript={attachment.transcript}
                  transcriptStatus={attachment.transcriptStatus}
                  theme={theme}
                />
              ))}
            </View>
          )}
        </ScrollView>

        <Popover visible={showFormatting} onClose={() => setShowFormatting(false)}>
          <View style={styles.formattingBar}>
            <Pressable style={styles.toolBtn} onPress={() => editorRef.current?.addBlock('heading1')}>
              <Text style={[styles.toolBtnText, { color: theme.text }]}>H1</Text>
            </Pressable>
            <Pressable style={styles.toolBtn} onPress={() => editorRef.current?.addBlock('heading2')}>
              <Text style={[styles.toolBtnText, { color: theme.text }]}>H2</Text>
            </Pressable>
            <Pressable style={styles.toolBtn} onPress={() => editorRef.current?.toggleStyle('bold')}>
              <Text style={[styles.toolBtnText, { color: theme.text, fontWeight: '700' }]}>B</Text>
            </Pressable>
            <Pressable style={styles.toolBtn} onPress={() => editorRef.current?.toggleStyle('italic')}>
              <Text style={[styles.toolBtnText, { color: theme.text, fontStyle: 'italic' }]}>I</Text>
            </Pressable>
            <Pressable style={styles.toolBtn} onPress={() => editorRef.current?.addBlock('bullet')}>
              <Ionicons name="list" size={16} color={theme.text} />
            </Pressable>
            <Pressable style={styles.toolBtn} onPress={() => editorRef.current?.addBlock('checkbox')}>
              <Ionicons name="checkbox-outline" size={16} color={theme.text} />
            </Pressable>
            <Pressable style={styles.toolBtn} onPress={() => void pickMedia(false)}>
              <Ionicons name="images-outline" size={16} color={theme.text} />
            </Pressable>
            <Pressable style={styles.toolBtn} onPress={() => void pickMedia(true)}>
              <Ionicons name="camera-outline" size={16} color={theme.text} />
            </Pressable>
            <Pressable style={styles.toolBtn} onPress={() => void importFile()}>
              <Ionicons name="attach-outline" size={16} color={theme.text} />
            </Pressable>
            <Pressable style={styles.toolBtn} onPress={() => void toggleRecording()}>
              <Ionicons name={recorder.isRecording ? 'stop-circle-outline' : 'mic-outline'} size={16} color={recorder.isRecording ? '#dc2626' : theme.text} />
            </Pressable>
          </View>
        </Popover>

        <Popover visible={showColors} onClose={() => setShowColors(false)}>
          <ColorPicker selectedColor={color} onSelectColor={(id) => { setColor(id); setShowColors(false); }} />
        </Popover>
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
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    maxWidth: 260,
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
