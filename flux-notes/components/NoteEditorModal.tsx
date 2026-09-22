import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
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
import {
  AttachmentBlock,
  ChecklistItem,
  NOTE_COLORS,
  NoteAttachment,
  NoteBlock,
  NoteColorId,
  NoteItem,
  TextBlock,
  TextBlockVariant,
} from '../types/note';
import ColorPicker from './ColorPicker';
import Popover from './Popover';
import AudioAttachmentView from './AudioAttachmentView';
import VideoAttachmentBlock from './VideoAttachmentBlock';
import AspectRatioImage from './AspectRatioImage';
import OEmbedCard from './OEmbedCard';
import { destroySpeechSession, startSpeechSession, SpeechSession } from '../utils/onDeviceTranscribe';
import {
  ensureTextBlockBetweenAttachments,
  extractAttachmentsFromBlocks,
  parseBlocksFromMarkdown,
  serializeBlocksToMarkdown,
} from '../utils/markdownParser';
import type { FluxClient } from '@flux-sdk/core';

type Props = {
  visible: boolean;
  initialNote: NoteItem | null;
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
  onClose,
  onSave,
  onDelete,
}: Props) {
  const insets = useSafeAreaInsets();
  const [title, setTitle] = useState('');
  const [blocks, setBlocks] = useState<NoteBlock[]>([]);
  const [pinned, setPinned] = useState(false);
  const [color, setColor] = useState<NoteColorId>('default');
  const [labels, setLabels] = useState<string[]>([]);
  const [activeChecklistItemId, setActiveChecklistItemId] = useState<string | null>(null);
  const [draggedBlockId, setDraggedBlockId] = useState<string | null>(null);

  // Long-press-to-drag reordering
  const dragStartIndexRef = useRef<number | null>(null);
  const dragY = useRef(new Animated.Value(0)).current;
  const dragScale = useRef(new Animated.Value(1)).current;

  // Selection tracking
  const selectionMapRef = useRef<Record<string, { start: number; end: number }>>({});
  const textInputRefsRef = useRef<Record<string, TextInput | null>>({});

  // Link dialog modal
  const [linkModalVisible, setLinkModalVisible] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');

  // UI Popovers
  const [showColors, setShowColors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Audio recording
  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true });
  const recorderState = useAudioRecorderState(recorder, 100);
  const meterSamplesRef = useRef<number[]>([]);
  const speechSessionRef = useRef<SpeechSession | null>(null);

  // Metering during recording
  useEffect(() => {
    if (recorderState.isRecording && typeof recorderState.metering === 'number') {
      const normalized = Math.max(0, Math.min(1, (recorderState.metering + 60) / 60));
      meterSamplesRef.current.push(normalized);
    }
  }, [recorderState.isRecording, recorderState.metering]);

  // Initial load
  useEffect(() => {
    if (visible) {
      if (initialNote) {
        setTitle(initialNote.title || '');
        setPinned(initialNote.pinned);
        setColor(initialNote.color || 'default');
        setLabels(initialNote.labels ? [...initialNote.labels] : []);

        const parsed = parseBlocksFromMarkdown(initialNote.content, initialNote.attachments);
        setBlocks(parsed);
      } else {
        setTitle(initialDraft?.title || '');
        setPinned(false);
        setColor('default');
        setLabels([]);

        if (initialDraft) {
          const parsed = parseBlocksFromMarkdown(initialDraft.content || '', initialDraft.attachments);
          setBlocks(parsed);
        } else {
          const initialBlock: TextBlock = {
            id: `block_${Date.now()}_0`,
            type: 'text',
            text: '',
            variant: 'paragraph',
            isChecklist: initialIsChecklist,
            checklistItems: initialIsChecklist
              ? [{ id: `item_${Date.now()}_0`, text: '', completed: false }]
              : undefined,
          };
          setBlocks([initialBlock]);
        }
      }
      setShowColors(false);
    }
  }, [visible, initialNote, initialIsChecklist, initialDraft]);

  useEffect(() => () => {
    void destroySpeechSession();
  }, []);

  const theme = NOTE_COLORS[color] || NOTE_COLORS.default;

  // Active block

  //const isBoldActive = Boolean(activeTextBlock?.bold);
  //const isItalicActive = Boolean(activeTextBlock?.italic);
  //const isUnderlineActive = Boolean(activeTextBlock?.underline);
  //const isStrikethroughActive = Boolean(activeTextBlock?.strikethrough);

  //TODO
  const isBoldActive = Boolean(false);
  const isItalicActive = Boolean(false);
  const isUnderlineActive = Boolean(false);
  const isStrikethroughActive = Boolean(false);

  // --- Block manipulation helpers ---
  const updateBlock = (id: string, updater: (b: NoteBlock) => NoteBlock) => {
    setBlocks((prev) => prev.map((b) => (b.id === id ? updater(b) : b)));
  };

  const deleteBlock = (id: string) => {
    setBlocks((prev) => {
      const filtered = prev.filter((b) => b.id !== id);
      if (filtered.length === 0) {
        const newBlock: TextBlock = {
          id: `block_${Date.now()}_0`,
          type: 'text',
          text: '',
          variant: 'paragraph',
        };
        return [newBlock];
      }
      return ensureTextBlockBetweenAttachments(filtered);
    });
  };

  const moveBlock = (index: number, direction: 'up' | 'down') => {
    setBlocks((prev) => {
      const targetIndex = direction === 'up' ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= prev.length) return prev;
      const copy = [...prev];
      const item = copy.splice(index, 1)[0];
      copy.splice(targetIndex, 0, item);
      return ensureTextBlockBetweenAttachments(copy);
    });
  };

  // Backspace on an empty text block merges into the previous block instead of just clearing text.
  const handleBackspaceOnEmptyBlock = (index: number, blockId: string) => {
    const prevBlock = blocks[index - 1];
    if (!prevBlock) return;

    if (prevBlock.type === 'text') {
      const prevId = prevBlock.id;
      const prevLength = prevBlock.text.length;
      setBlocks((prev) => ensureTextBlockBetweenAttachments(prev.filter((b) => b.id !== blockId)));
      setTimeout(() => {
        const input = textInputRefsRef.current[prevId];
        input?.focus();
        input?.setSelection(prevLength, prevLength);
      }, 0);
    } else if (prevBlock.type === 'attachment') {
      setBlocks((prev) => ensureTextBlockBetweenAttachments(prev.filter((b) => b.id !== prevBlock.id)));
    }
  };

  // --- Drag & Drop Reordering Handlers (long-press then move) ---
  const handleDragStart = (index: number, id: string) => {
    dragStartIndexRef.current = index;
    dragY.setValue(0);
    setDraggedBlockId(id);
    Animated.spring(dragScale, { toValue: 1.04, useNativeDriver: true, friction: 6 }).start();
  };

  const handleDragMove = (draggedId: string, totalDy: number) => {
    if (dragStartIndexRef.current === null) return;
    const step = 60;
    const delta = Math.round(totalDy / step);
    const targetIndex = Math.max(0, Math.min(blocks.length - 1, dragStartIndexRef.current + delta));
    setBlocks((prev) => {
      const currentIndex = prev.findIndex((b) => b.id === draggedId);
      if (currentIndex === -1 || currentIndex === targetIndex) return prev;
      const copy = [...prev];
      const item = copy.splice(currentIndex, 1)[0];
      copy.splice(targetIndex, 0, item);
      return ensureTextBlockBetweenAttachments(copy);
    });
  };

  const handleDragEnd = () => {
    dragStartIndexRef.current = null;
    Animated.parallel([
      Animated.spring(dragY, { toValue: 0, useNativeDriver: true, friction: 7 }),
      Animated.spring(dragScale, { toValue: 1, useNativeDriver: true, friction: 7 }),
    ]).start();
    setDraggedBlockId(null);
  };

  // Attached to the blocks container; hijacks touch from the ScrollView once a long-press activates dragging.
  const blockPanResponder = PanResponder.create({
    onMoveShouldSetPanResponderCapture: () => draggedBlockId !== null,
    onPanResponderMove: (_evt, gestureState) => {
      if (!draggedBlockId) return;
      dragY.setValue(gestureState.dy);
      handleDragMove(draggedBlockId, gestureState.dy);
    },
    onPanResponderRelease: handleDragEnd,
    onPanResponderTerminate: handleDragEnd,
  });

  const addTextBlock = (isChecklist = false) => {
    const newBlock: TextBlock = {
      id: `block_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      type: 'text',
      text: '',
      variant: 'paragraph',
      isChecklist,
      checklistItems: isChecklist ? [{ id: `item_${Date.now()}_0`, text: '', completed: false }] : undefined,
    };

    setBlocks((prev) => {
      return [...prev, newBlock];
    });
  };

  const addAttachmentBlock = (
    attachment: Omit<AttachmentBlock, 'id' | 'type'>,
    afterId?: string
  ) => {
    const newBlock: AttachmentBlock = {
      ...attachment,
      id: `block_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      type: 'attachment',
    };

    const newTB: TextBlock = {
      id: `block_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      type: 'text',
      text: '',
      variant: 'paragraph',
      isChecklist: false,
    };

    setBlocks((prev) => {
      if (!afterId) return [...prev, newBlock, newTB];
      const index = prev.findIndex((block) => block.id === afterId);
      if (index === -1) return [...prev, newBlock, newTB];
      const next = [...prev];
      next.splice(index + 1, 0, newBlock, newTB);
      return ensureTextBlockBetweenAttachments(next);
    });
  };

  const handleTextBlockChange = (blockId: string, text: string) => {
    const urlPattern = /https?:\/\/[^\s]+/gi;
    const matches = [...text.matchAll(urlPattern)];
    if (matches.length === 0) {
      updateBlock(blockId, (block) => (block.type === 'text' ? { ...block, text } : block));
      return;
    }

    setBlocks((prev) => {
      const blockIndex = prev.findIndex((block) => block.id === blockId);
      const block = prev[blockIndex];
      if (blockIndex === -1 || block?.type !== 'text') return prev;

      const replacement: NoteBlock[] = [];
      let cursor = 0;

      for (const match of matches) {
        const rawUrl = match[0];
        const matchStart = match.index ?? cursor;
        const url = rawUrl.replace(/[.,!?;:]+$/, '');
        if (!url) continue;
        const urlEnd = matchStart + url.length;

        if (matchStart > cursor) {
          replacement.push({
            ...block,
            id: replacement.length === 0 ? block.id : `block_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            text: text.slice(cursor, matchStart),
          });
        }

        const lowerUrl = url.toLowerCase();
        const attachmentType: AttachmentBlock['attachmentType'] = /\.(png|jpe?g|gif|webp|heic|bmp)(?:[?#].*)?$/i.test(lowerUrl)
          ? 'image'
          : /\.(mp4|mov|webm|mkv|m4v)(?:[?#].*)?$/i.test(lowerUrl)
          ? 'video'
          : 'link';
        replacement.push({
          id: `block_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          type: 'attachment',
          attachmentType,
          name: url,
          uri: url,
          mimeType: attachmentType === 'image' ? 'image/*' : attachmentType === 'video' ? 'video/*' : undefined,
        });
        cursor = urlEnd;
      }

      if (cursor < text.length) {
        replacement.push({
          ...block,
          id: replacement.length === 0 ? block.id : `block_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          text: text.slice(cursor),
        });
      }

      if (replacement.length === 0 || replacement[replacement.length - 1].type === 'attachment') {
        replacement.push({
          ...block,
          id: `block_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          text: '',
        });
      }

      const next = [...prev];
      next.splice(blockIndex, 1, ...replacement);
      return ensureTextBlockBetweenAttachments(next);
    });
  };

  // --- WYSIWYG Formatting Actions on Selected Text or Current Cursor Block ---
  const handleApplyFormatting = (formatType: 'bold' | 'italic' | 'underline' | 'strikethrough') => {
    //TODO: this is wrong, use current selected text
    const currentBlockId = blocks[0]?.id;
    const blockIndex = blocks.findIndex((b) => b.id === currentBlockId);
    if (blockIndex === -1) return;
    const block = blocks[blockIndex];
    if (block.type !== 'text') return;

    if (block.isChecklist && block.checklistItems && block.checklistItems.length > 0) {
      updateBlock(block.id, (b) => {
        if (b.type !== 'text') return b;
        return { ...b, [formatType]: !b[formatType] };
      });
      return;
    }

    const fullText = block.text || '';
    const sel = selectionMapRef.current[block.id] || { start: fullText.length, end: fullText.length };
    const s = Math.max(0, Math.min(sel.start, sel.end));
    const e = Math.min(fullText.length, Math.max(sel.start, sel.end));

    const nextVal = !Boolean(block[formatType]);

    // 1. Empty block or whole block selected -> toggle style directly on this block
    if (fullText.length === 0 || (s === 0 && e === fullText.length)) {
      updateBlock(block.id, (b) => {
        if (b.type !== 'text') return b;
        return { ...b, [formatType]: nextVal };
      });
      return;
    }

    // 2. Substring is selected -> split into styled blocks
    if (s < e) {
      const partBefore = fullText.slice(0, s);
      const partSelected = fullText.slice(s, e);
      const partAfter = fullText.slice(e);

      const replacementBlocks: TextBlock[] = [];

      if (partBefore.length > 0) {
        replacementBlocks.push({
          ...block,
          id: `block_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          text: partBefore,
        });
      }

      const formattedBlock: TextBlock = {
        ...block,
        id: `block_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        text: partSelected,
        [formatType]: nextVal,
      };
      replacementBlocks.push(formattedBlock);

      if (partAfter.length > 0) {
        replacementBlocks.push({
          ...block,
          id: `block_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          text: partAfter,
        });
      }

      setBlocks((prev) => {
        const copy = [...prev];
        copy.splice(blockIndex, 1, ...replacementBlocks);
        return copy;
      });
      return;
    }

    // 3. Cursor position (s === e)
    if (s === 0) {
      updateBlock(block.id, (b) => {
        if (b.type !== 'text') return b;
        return { ...b, [formatType]: nextVal };
      });
    } else if (s === fullText.length) {
      const newBlock: TextBlock = {
        ...block,
        id: `block_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        text: '',
        [formatType]: nextVal,
      };
      setBlocks((prev) => {
        const copy = [...prev];
        copy.splice(blockIndex + 1, 0, newBlock);
        return copy;
      });
    } else {
      const partBefore = fullText.slice(0, s);
      const partAfter = fullText.slice(s);

      const bBefore: TextBlock = {
        ...block,
        id: `block_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        text: partBefore,
      };
      const bMiddle: TextBlock = {
        ...block,
        id: `block_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        text: '',
        [formatType]: nextVal,
      };
      const bAfter: TextBlock = {
        ...block,
        id: `block_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        text: partAfter,
      };

      setBlocks((prev) => {
        const copy = [...prev];
        copy.splice(blockIndex, 1, bBefore, bMiddle, bAfter);
        return copy;
      });
    }
  };

  const handleApplyHeading = (variant: 'h1' | 'h2') => {
    //TODO: this is wrong, use current selected text
    const currentBlockId = blocks[0]?.id;
    updateBlock(currentBlockId, (b) => {
      if (b.type !== 'text') return b;
      const nextVariant: TextBlockVariant = b.variant === variant ? 'paragraph' : variant;
      return { ...b, variant: nextVariant };
    });
  };

  const toggleActiveChecklist = () => {
    //TODO: work out how this should work
    const currentBlockId = blocks[0]?.id;
    updateBlock(currentBlockId, (b) => {
      if (b.type !== 'text') return b;
      const willBeChecklist = !b.isChecklist;
      if (willBeChecklist) {
        const lines = b.text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
        const items: ChecklistItem[] = lines.length > 0
          ? lines.map((l, i) => ({ id: `item_${Date.now()}_${i}`, text: l, completed: false }))
          : [{ id: `item_${Date.now()}_0`, text: '', completed: false }];
        setActiveChecklistItemId(items[0].id);
        return { ...b, isChecklist: true, checklistItems: items };
      } else {
        const joinedText = b.checklistItems ? b.checklistItems.map((item) => item.text).join('\n') : b.text;
        setActiveChecklistItemId(null);
        return { ...b, isChecklist: false, text: joinedText, checklistItems: undefined };
      }
    });
  };

  // --- Checklist item editing helpers ---
  const updateChecklistItem = (blockId: string, itemId: string, newText: string) => {
    updateBlock(blockId, (b) => {
      if (b.type !== 'text' || !b.checklistItems) return b;
      const items = b.checklistItems.map((item) => (item.id === itemId ? { ...item, text: newText } : item));
      return { ...b, checklistItems: items, text: items.map((i) => i.text).join('\n') };
    });
  };

  const toggleChecklistItem = (blockId: string, itemId: string) => {
    updateBlock(blockId, (b) => {
      if (b.type !== 'text' || !b.checklistItems) return b;
      const items = b.checklistItems.map((item) =>
        item.id === itemId ? { ...item, completed: !item.completed } : item
      );
      return { ...b, checklistItems: items };
    });
  };

  const addChecklistItem = (blockId: string, afterItemId?: string) => {
    updateBlock(blockId, (b) => {
      if (b.type !== 'text' || !b.checklistItems) return b;
      const newItem: ChecklistItem = {
        id: `item_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        text: '',
        completed: false,
      };
      setActiveChecklistItemId(newItem.id);
      if (!afterItemId) {
        const items = [...b.checklistItems, newItem];
        return { ...b, checklistItems: items, text: items.map((i) => i.text).join('\n') };
      }
      const idx = b.checklistItems.findIndex((item) => item.id === afterItemId);
      const items = [...b.checklistItems];
      items.splice(idx + 1, 0, newItem);
      return { ...b, checklistItems: items, text: items.map((i) => i.text).join('\n') };
    });
  };

  const removeChecklistItem = (blockId: string, itemId: string) => {
    updateBlock(blockId, (b) => {
      if (b.type !== 'text' || !b.checklistItems) return b;
      const filtered = b.checklistItems.filter((item) => item.id !== itemId);
      const items = filtered.length > 0 ? filtered : [{ id: `item_${Date.now()}_0`, text: '', completed: false }];
      if (activeChecklistItemId === itemId) {
        setActiveChecklistItemId(items[0].id);
      }
      return { ...b, checklistItems: items, text: items.map((i) => i.text).join('\n') };
    });
  };

  // --- Media & File Pickers ---
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
    const isVideo = asset.type === 'video';
    addAttachmentBlock({
      attachmentType: isVideo ? 'video' : 'image',
      name: asset.fileName || `${isVideo ? 'video' : 'image'}-${Date.now()}`,
      uri: asset.uri,
      mimeType: asset.mimeType || (isVideo ? 'video/mp4' : 'image/jpeg'),
    });
  };

  const importFile = async () => {
    const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    addAttachmentBlock({
      attachmentType: 'file',
      name: asset.name,
      uri: asset.uri,
      mimeType: asset.mimeType || 'application/octet-stream',
    });
  };

  const handleAddLink = () => {
    const trimmed = linkUrl.trim();
    if (!trimmed) {
      setLinkModalVisible(false);
      return;
    }
    const validUrl = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    addAttachmentBlock({
      attachmentType: 'link',
      name: validUrl,
      uri: validUrl,
    });
    setLinkUrl('');
    setLinkModalVisible(false);
  };

  const toggleRecording = async () => {
    if (recorder.isRecording) {
      const durationMs = recorder.currentTime * 1000;
      const speechSession = speechSessionRef.current;
      speechSessionRef.current = null;
      await recorder.stop();
      const waveform = meterSamplesRef.current;
      meterSamplesRef.current = [];
      if (recorder.uri) {
        const transcript = speechSession ? await speechSession.stop().catch(() => '') : '';
        addAttachmentBlock({
          attachmentType: 'audio',
          name: `recording-${Date.now()}.m4a`,
          uri: recorder.uri,
          mimeType: 'audio/m4a',
          waveform,
          durationMs,
          transcript: transcript || undefined,
          transcriptStatus: transcript ? 'ready' : 'error',
        });
      }
      return;
    }
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) return Alert.alert('Microphone permission required');
    try {
      speechSessionRef.current = await startSpeechSession();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Speech recognition is unavailable';
      return Alert.alert('Speech recognition unavailable', message);
    }
    meterSamplesRef.current = [];
    try {
      await recorder.prepareToRecordAsync();
      recorder.record();
    } catch (error) {
      speechSessionRef.current = null;
      await destroySpeechSession();
      throw error;
    }
  };

  // --- Save / Delete Handlers ---
  const handleSave = async () => {
    const trimmedTitle = title.trim();
    const serializedMarkdown = serializeBlocksToMarkdown(blocks);
    const hasContent = blocks.some((b) => (b.type === 'text' ? b.text.trim().length > 0 : true));

    if (!trimmedTitle && !hasContent) {
      onClose();
      return;
    }

    setSaving(true);
    try {
      const attachments = extractAttachmentsFromBlocks(blocks);
      const isChecklistNote = blocks.every((b) => b.type === 'text' && b.isChecklist);
      const allChecklistItems = blocks.flatMap((b) => (b.type === 'text' && b.checklistItems ? b.checklistItems : []));

      await onSave({
        id: initialNote?.id,
        path: initialNote?.path,
        title: trimmedTitle,
        content: serializedMarkdown,
        pinned,
        color,
        labels,
        attachments,
        isChecklist: isChecklistNote,
        checklistItems: allChecklistItems,
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

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={[styles.container, { backgroundColor: theme.bg, paddingTop: insets.top + 8 }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* Header Toolbar */}
        <View style={[styles.header, { borderBottomColor: theme.border }]}>
          <Pressable onPress={onClose} hitSlop={10} style={styles.headerIconBtn}>
            <Ionicons name="arrow-back" size={24} color={theme.text} />
          </Pressable>
          <View style={styles.headerRight}>
            <Pressable
              onPress={() => setShowColors((prev) => !prev)}
              style={styles.headerIconBtn}
              hitSlop={8}
            >
              <Ionicons name="color-palette-outline" size={22} color={theme.text} />
            </Pressable>
            <Pressable
              onPress={() => setPinned((prev) => !prev)}
              style={styles.headerIconBtn}
              hitSlop={8}
            >
              <Ionicons
                name={pinned ? 'pin' : 'pin-outline'}
                size={22}
                color={pinned ? '#0f172a' : theme.text}
              />
            </Pressable>
            {initialNote && onDelete ? (
              <Pressable
                onPress={handleDelete}
                style={styles.headerIconBtn}
                hitSlop={8}
                disabled={deleting}
              >
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

        {/* Scrollable Note Content */}
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + 80 }]}
          keyboardShouldPersistTaps="handled"
          scrollEnabled={!draggedBlockId}
        >
          {/* Note Title */}
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="Title"
            placeholderTextColor={theme.secondaryText}
            style={[styles.titleInput, { color: theme.text }]}
            multiline={false}
          />

          {/* Blocks List */}
          <View style={styles.blocksContainer} {...blockPanResponder.panHandlers}>
            {blocks.map((block, index) => {
              const isDragged = block.id === draggedBlockId;

              return (
                <Pressable
                  key={block.id}
                  onLongPress={() => handleDragStart(index, block.id)}
                  delayLongPress={350}
                >
                  <Animated.View
                    style={[
                      styles.blockWrapper,
                      { borderColor: 'transparent' },
                      isDragged && [
                        styles.draggedBlock,
                        {
                          transform: [{ translateY: dragY }, { scale: dragScale }],
                        },
                      ],
                    ]}
                  >

                  {/* Block Body */}
                  {block.type === 'text' ? (
                    block.isChecklist ? (
                      /* Checklist Block */
                      <View style={styles.checklistBlock}>
                        {(block.checklistItems || []).map((item, itemIdx) => (
                          <View key={item.id} style={styles.checklistRow}>
                            <Pressable
                              onPress={() => toggleChecklistItem(block.id, item.id)}
                              hitSlop={8}
                              style={styles.checkboxTouch}
                            >
                              <Ionicons
                                name={item.completed ? 'checkbox' : 'square-outline'}
                                size={20}
                                color={item.completed ? theme.secondaryText : theme.accent}
                              />
                            </Pressable>
                            <TextInput
                              value={item.text}
                              onSelectionChange={(e) => {
                                const key = `${block.id}_${item.id}`;
                                selectionMapRef.current[key] = e.nativeEvent.selection;
                              }}
                              onChangeText={(t) => updateChecklistItem(block.id, item.id, t)}
                              onFocus={() => {
                                setActiveChecklistItemId(item.id);
                              }}
                              placeholder="List item..."
                              placeholderTextColor={theme.secondaryText}
                              style={[
                                styles.checklistTextInput,
                                { color: item.completed ? theme.secondaryText : theme.text },
                                (item.completed || block.strikethrough) && block.underline
                                  ? styles.underlineStrikethrough
                                  : (item.completed || block.strikethrough)
                                  ? styles.strikethrough
                                  : block.underline
                                  ? styles.underline
                                  : undefined,
                                block.bold && styles.bold,
                                block.italic && styles.italic,
                              ]}
                              returnKeyType="next"
                              onSubmitEditing={() => addChecklistItem(block.id, item.id)}
                              blurOnSubmit={false}
                            />
                            <Pressable
                              onPress={() => removeChecklistItem(block.id, item.id)}
                              hitSlop={8}
                              style={styles.removeCheckItemBtn}
                            >
                              <Ionicons name="close" size={16} color={theme.secondaryText} />
                            </Pressable>
                          </View>
                        ))}
                        <Pressable
                          style={[styles.addCheckItemBtn, { borderColor: theme.border }]}
                          onPress={() => addChecklistItem(block.id)}
                        >
                          <Ionicons name="add" size={16} color={theme.accent} />
                          <Text style={[styles.addCheckItemText, { color: theme.accent }]}>
                            Add item
                          </Text>
                        </Pressable>
                      </View>
                    ) : (
                      /* Standard WYSIWYG Text Block */
                      <TextInput
                        ref={(r) => {
                          textInputRefsRef.current[block.id] = r;
                        }}
                        value={block.text}
                        onSelectionChange={(e) => {
                          selectionMapRef.current[block.id] = e.nativeEvent.selection;
                        }}
                        onChangeText={(t) => handleTextBlockChange(block.id, t)}
                        onKeyPress={(e) => {
                          if (e.nativeEvent.key === 'Backspace' && block.text.length === 0) {
                            handleBackspaceOnEmptyBlock(index, block.id);
                          }
                        }}
                        onFocus={() => {
                          setActiveChecklistItemId(null);
                        }}
                        multiline
                        style={[
                          styles.textInputBlock,
                          { color: theme.text },
                          block.variant === 'h1' && styles.h1Text,
                          block.variant === 'h2' && styles.h2Text,
                          block.bold && styles.bold,
                          block.italic && styles.italic,
                          block.underline && block.strikethrough
                            ? styles.underlineStrikethrough
                            : block.underline
                            ? styles.underline
                            : block.strikethrough
                            ? styles.strikethrough
                            : undefined,
                        ]}
                      />
                    )
                  ) : (
                    /* Attachment Block */
                    <View style={styles.attachmentBlockContainer}>
                      {block.attachmentType === 'image' && (
                        <View style={styles.imageAttachment}>
                          <AspectRatioImage uri={block.uri} style={styles.attachmentImage} />
                        </View>
                      )}

                      {block.attachmentType === 'video' && (
                        <VideoAttachmentBlock uri={block.uri} name={block.name} theme={theme} />
                      )}

                      {block.attachmentType === 'audio' && (
                        <AudioAttachmentView
                          uri={block.uri}
                          name={block.name}
                          waveform={block.waveform}
                          durationMs={block.durationMs}
                          transcript={block.transcript}
                          transcriptStatus={block.transcriptStatus}
                          theme={theme}
                        />
                      )}

                      {block.attachmentType === 'link' && (
                        <View style={styles.linkAttachment}>
                          {/^https?:\/\/\S+$/.test(block.uri.trim()) ? (
                            <OEmbedCard url={block.uri.trim()} theme={theme} />
                          ) : null}
                        </View>
                      )}

                      {block.attachmentType === 'file' && (
                        <View
                          style={[
                            styles.fileAttachmentRow,
                            { borderColor: theme.border, backgroundColor: theme.badgeBg },
                          ]}
                        >
                          <Ionicons name="attach-outline" size={18} color={theme.accent} />
                          <Text style={[styles.fileAttachmentText, { color: theme.text }]} numberOfLines={1}>
                            {block.name}
                          </Text>
                        </View>
                      )}
                    </View>
                  )}
                  </Animated.View>
                </Pressable>
              );
            })}
            <Pressable style={styles.toolBtn} onPress={() => pickMedia(false)}>
              <Ionicons name="images-outline" size={18} color={theme.text} />
              <Text style={[styles.toolBtnLabel, { color: theme.text }]}>Photo/Video</Text>
            </Pressable>

            <Pressable style={styles.toolBtn} onPress={() => pickMedia(true)}>
              <Ionicons name="camera-outline" size={18} color={theme.text} />
              <Text style={[styles.toolBtnLabel, { color: theme.text }]}>Camera</Text>
            </Pressable>

            <Pressable style={styles.toolBtn} onPress={() => void toggleRecording()}>
              <Ionicons
                name={recorder.isRecording ? 'stop-circle' : 'mic-outline'}
                size={18}
                color={recorder.isRecording ? '#dc2626' : theme.text}
              />
              <Text style={[styles.toolBtnLabel, { color: recorder.isRecording ? '#dc2626' : theme.text }]}>
                {recorder.isRecording ? 'Recording…' : 'Audio'}
              </Text>
            </Pressable>

            <Pressable style={styles.toolBtn} onPress={() => void importFile()}>
              <Ionicons name="attach-outline" size={18} color={theme.text} />
              <Text style={[styles.toolBtnLabel, { color: theme.text }]}>File</Text>
            </Pressable>

            <Pressable style={styles.toolBtn} onPress={() => setLinkModalVisible(true)}>
              <Ionicons name="globe-outline" size={18} color={theme.text} />
              <Text style={[styles.toolBtnLabel, { color: theme.text }]}>Link</Text>
            </Pressable>
          </View>
        </ScrollView>

        {/* Bottom Floating Formatting & Insertion Toolbar */}
        <View style={[styles.bottomBar, { backgroundColor: theme.cardBg, borderTopColor: theme.border }]}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.toolbarScroll}>
            {/* Formatting Tools for active text block */}
            <Pressable
              style={[
                styles.toolBtn,
                //activeTextBlock?.variant === 'h1' && { backgroundColor: theme.badgeBg, borderColor: theme.accent },
              ]}
              onPress={() => handleApplyHeading('h1')}
            >
              <Text
                style={[
                  styles.toolBtnText,
                  //{ color: activeTextBlock?.variant === 'h1' ? theme.accent : theme.text, fontWeight: '700' },
                ]}
              >
                H1
              </Text>
            </Pressable>

            <Pressable
              style={[
                styles.toolBtn,
                //activeTextBlock?.variant === 'h2' && { backgroundColor: theme.badgeBg, borderColor: theme.accent },
              ]}
              onPress={() => handleApplyHeading('h2')}
            >
              <Text
                style={[
                  styles.toolBtnText,
                  //{ color: activeTextBlock?.variant === 'h2' ? theme.accent : theme.text, fontWeight: '700' },
                ]}
              >
                H2
              </Text>
            </Pressable>

            <Pressable
              style={[
                styles.toolBtn,
                isBoldActive && { backgroundColor: theme.badgeBg, borderColor: theme.accent },
              ]}
              onPress={() => handleApplyFormatting('bold')}
            >
              <Text
                style={[
                  styles.toolBtnText,
                  { color: isBoldActive ? theme.accent : theme.text, fontWeight: '700' },
                ]}
              >
                B
              </Text>
            </Pressable>

            <Pressable
              style={[
                styles.toolBtn,
                isItalicActive && { backgroundColor: theme.badgeBg, borderColor: theme.accent },
              ]}
              onPress={() => handleApplyFormatting('italic')}
            >
              <Text
                style={[
                  styles.toolBtnText,
                  { color: isItalicActive ? theme.accent : theme.text, fontStyle: 'italic' },
                ]}
              >
                I
              </Text>
            </Pressable>

            <Pressable
              style={[
                styles.toolBtn,
                isUnderlineActive && { backgroundColor: theme.badgeBg, borderColor: theme.accent },
              ]}
              onPress={() => handleApplyFormatting('underline')}
            >
              <Text
                style={[
                  styles.toolBtnText,
                  { color: isUnderlineActive ? theme.accent : theme.text, textDecorationLine: 'underline' },
                ]}
              >
                U
              </Text>
            </Pressable>

            <Pressable
              style={[
                styles.toolBtn,
                isStrikethroughActive && { backgroundColor: theme.badgeBg, borderColor: theme.accent },
              ]}
              onPress={() => handleApplyFormatting('strikethrough')}
            >
              <Text
                style={[
                  styles.toolBtnText,
                  { color: isStrikethroughActive ? theme.accent : theme.text, textDecorationLine: 'line-through' },
                ]}
              >
                S
              </Text>
            </Pressable>

            <Pressable
              style={[
                styles.toolBtn,
                //activeTextBlock?.isChecklist && { backgroundColor: theme.badgeBg, borderColor: theme.accent },
              ]}
              onPress={toggleActiveChecklist}
            >
              <Ionicons
                //name={activeTextBlock?.isChecklist ? 'checkbox' : 'checkbox-outline'}
                size={18}
                //color={activeTextBlock?.isChecklist ? theme.accent : theme.text}
              />
            </Pressable>

            <View style={[styles.toolbarDivider, { backgroundColor: theme.border }]} />
          </ScrollView>
        </View>

        {/* Web Link Modal */}
        <Modal visible={linkModalVisible} transparent animationType="fade" onRequestClose={() => setLinkModalVisible(false)}>
          <View style={styles.modalOverlay}>
            <View style={[styles.modalCard, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
              <Text style={[styles.modalTitle, { color: theme.text }]}>Add Web Link</Text>
              <TextInput
                value={linkUrl}
                onChangeText={setLinkUrl}
                placeholder="https://example.com"
                placeholderTextColor={theme.secondaryText}
                autoCapitalize="none"
                keyboardType="url"
                style={[styles.modalInput, { color: theme.text, borderColor: theme.border }]}
              />
              <View style={styles.modalButtons}>
                <Pressable style={[styles.modalBtn, { borderColor: theme.border }]} onPress={() => setLinkModalVisible(false)}>
                  <Text style={[styles.modalBtnText, { color: theme.secondaryText }]}>Cancel</Text>
                </Pressable>
                <Pressable style={[styles.modalBtn, { backgroundColor: theme.accent }]} onPress={handleAddLink}>
                  <Text style={[styles.modalBtnText, { color: '#ffffff' }]}>Add Link</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>

        {/* Color Picker Popover */}
        <Popover visible={showColors} onClose={() => setShowColors(false)}>
          <ColorPicker
            selectedColor={color}
            onSelectColor={(id) => {
              setColor(id);
              setShowColors(false);
            }}
          />
        </Popover>
      </KeyboardAvoidingView>
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
    padding: 6,
    borderRadius: 8,
  },
  saveBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    minWidth: 64,
    alignItems: 'center',
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
    padding: 16,
  },
  titleInput: {
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 16,
    padding: 0,
  },
  blocksContainer: {
    gap: 12,
  },
  blockWrapper: {
  },
  draggedBlock: {
    zIndex: 10,
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.25,
    shadowRadius: 10,
  },
  blockControlBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 6,
    marginBottom: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(0,0,0,0.08)',
  },
  dragHandle: {
    padding: 2,
  },
  blockTypeLabel: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    flex: 1,
    marginLeft: 6,
  },
  blockActionsRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  blockActionBtn: {
    padding: 4,
    borderRadius: 6,
  },
  disabledBtn: {
    opacity: 0.3,
  },
  textInputBlock: {
    fontSize: 16,
    lineHeight: 24,
    minHeight: 40,
    paddingVertical: 4,
  },
  h1Text: {
    fontSize: 22,
    fontWeight: '700',
    lineHeight: 28,
  },
  h2Text: {
    fontSize: 18,
    fontWeight: '700',
    lineHeight: 24,
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
  underlineStrikethrough: {
    textDecorationLine: 'underline line-through',
  },
  checklistBlock: {
    gap: 6,
  },
  checklistRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 2,
  },
  checkboxTouch: {
    padding: 2,
  },
  checklistTextInput: {
    flex: 1,
    fontSize: 15,
    paddingVertical: 4,
  },
  removeCheckItemBtn: {
    padding: 4,
  },
  addCheckItemBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: 8,
    marginTop: 4,
    alignSelf: 'flex-start',
  },
  addCheckItemText: {
    fontSize: 13,
    fontWeight: '600',
  },
  attachmentBlockContainer: {
    marginVertical: 4,
  },
  imageAttachment: {
    borderRadius: 10,
    overflow: 'hidden',
  },
  attachmentImage: {
    width: '100%',
    borderRadius: 10,
    backgroundColor: '#00000010',
  },
  attachmentCaption: {
    fontSize: 12,
    marginTop: 4,
  },
  linkAttachment: {
    gap: 6,
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
  bottomBar: {
    borderTopWidth: 1,
    paddingVertical: 8,
    paddingHorizontal: 8,
  },
  toolbarScroll: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 4,
  },
  toolBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'transparent',
    backgroundColor: 'rgba(0,0,0,0.04)',
  },
  toolBtnText: {
    fontSize: 14,
  },
  toolBtnLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  toolbarDivider: {
    width: 1,
    height: 24,
    marginHorizontal: 4,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalCard: {
    width: '100%',
    maxWidth: 380,
    borderRadius: 16,
    borderWidth: 1,
    padding: 20,
    gap: 12,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 4,
  },
  modalInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 15,
  },
  modalButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 8,
  },
  modalBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
  },
  modalBtnText: {
    fontSize: 14,
    fontWeight: '600',
  },
});
