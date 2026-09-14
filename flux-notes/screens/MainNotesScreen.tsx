import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useShareIntentContext } from 'expo-share-intent';
import { ConnectionState, DiagnosticEvent, FluxClient, SearchResult, TransportMode } from '@flux-sdk/core';
import { NoteAttachment, NoteItem, ViewMode } from '../types/note';
import { parseNoteMarkdown, serializeNoteMarkdown } from '../utils/markdownParser';
import { deleteCachedNote, getCachedNotes, saveCachedNotes, searchCachedNotes, upsertCachedNote } from '../utils/noteCache';
import NoteCard from '../components/NoteCard';
import NoteEditorModal from '../components/NoteEditorModal';

type Props = {
  client: FluxClient;
  diagnostics: DiagnosticEvent[];
  onLoggedOut: () => void;
};

type ConnectionIcon = {
  name: keyof typeof Ionicons.glyphMap;
  color: string;
};

function getConnectionIcon(connectionState: ConnectionState, transport: TransportMode): ConnectionIcon {
  if (connectionState !== 'connected') {
    return { name: 'cloud-offline-outline', color: '#94a3b8' };
  }
  if (transport === 'local') {
    return { name: 'home-outline', color: '#16a34a' };
  }
  return { name: 'cloud-outline', color: '#2563eb' };
}

function splitMasonryColumns(notes: NoteItem[]): [NoteItem[], NoteItem[]] {
  const columns: [NoteItem[], NoteItem[]] = [[], []];
  const heights = [0, 0];
  for (const note of notes) {
    // Keep columns balanced using a stable content-height estimate. Unlike a
    // wrapping grid, each column flows independently and never leaves row gaps.
    const estimate = 92 + Math.min(note.content.length / 2, 180)
      + Math.min(note.checklistItems.length * 28, 140)
      + (note.attachments?.length ? 28 : 0);
    const target = heights[0] <= heights[1] ? 0 : 1;
    columns[target].push(note);
    heights[target] += estimate;
  }
  return columns;
}

export default function MainNotesScreen({ client, diagnostics, onLoggedOut }: Props) {
  const insets = useSafeAreaInsets();
  const [connectionState, setConnectionState] = useState(client.getState());
  const [query, setQuery] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [cachedNotes, setCachedNotes] = useState<NoteItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('Syncing notes...');
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);

  // Editor Modal State
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingNote, setEditingNote] = useState<NoteItem | null>(null);
  const [initialIsChecklist, setInitialIsChecklist] = useState(false);
  const [sharedDraft, setSharedDraft] = useState<{ title?: string; content?: string; attachments?: NoteAttachment[] } | null>(null);

  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();

  // A note shared in from another app opens a prefilled draft in the editor.
  useEffect(() => {
    if (!hasShareIntent) return;
    const sharedAttachments: NoteAttachment[] = (shareIntent.files || []).map((file, index) => ({
      id: `shared_${Date.now()}_${index}`,
      name: file.fileName || `shared-${index}`,
      uri: file.path,
      mimeType: file.mimeType || 'application/octet-stream',
      kind: file.mimeType?.startsWith('image/') ? 'image' : file.mimeType?.startsWith('video/') ? 'video' : file.mimeType?.startsWith('audio/') ? 'audio' : 'file',
    }));
    setSharedDraft({
      title: shareIntent.meta?.title,
      content: shareIntent.text || shareIntent.webUrl || '',
      attachments: sharedAttachments,
    });
    setEditingNote(null);
    setInitialIsChecklist(false);
    setEditorOpen(true);
    resetShareIntent();
  }, [hasShareIntent, shareIntent, resetShareIntent]);

  useEffect(() => {
    const unsubscribe = client.onStateChange(setConnectionState);
    return () => unsubscribe();
  }, [client]);

  const authSession = client.getAuthSession();

  useEffect(() => {
    void getCachedNotes().then((cached) => {
      setCachedNotes(cached);
      if (cached.length > 0) setNotes(searchCachedNotes(cached, query));
    });
  }, []);

  const loadNotes = useCallback(async (searchQuery: string) => {
    setLoading(true);
    setError(null);
    setNotes(searchCachedNotes(cachedNotes, searchQuery));

    try {
      await client.connect();

      // Query Tantivy via Flux SDK search API
      const searchResults: SearchResult[] = await client.search({
        q: searchQuery.trim(),
        limit: 200,
      });

      // Filter results for notes directory or .md files
      const noteFiles = searchResults.filter(
        (res) => res.path.includes('/Notes/') || res.path.endsWith('.md') || res.tags.includes('md')
      );

      // Fetch file content for each note
      const results = await Promise.all(
        noteFiles.map(async (fileRes) => {
          try {
            // Download raw Markdown text
            const blob = await client.downloadFile(fileRes.path);
            const text = await blob.text();
            return parseNoteMarkdown(text, fileRes.path, fileRes.date_created);
          } catch (downloadErr) {
            // Previews are often truncated; do not manufacture a corrupt note.
            return null;
          }
        })
      );
      const loadedNotes = results.filter((note): note is NoteItem => note !== null);

      // Sort notes: pinned first, then by updatedAt / createdAt descending
      const sorted = loadedNotes.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt);
      });

      if (!searchQuery.trim() && loadedNotes.length === noteFiles.length) {
        await saveCachedNotes(sorted);
        setCachedNotes(sorted);
        setNotes(sorted);
      } else if (!searchQuery.trim()) {
        const merged = [...sorted, ...cachedNotes.filter((cached) =>
          !sorted.some((server) => server.id === cached.id || server.path === cached.path)
        )];
        setNotes(merged);
      } else {
        setNotes(sorted);
      }
      setStatus(
        searchQuery.trim()
          ? `${sorted.length} notes matching "${searchQuery.trim()}"`
          : `${sorted.length} notes synced`
      );
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : 'Failed to load notes';
      setError(message);
      setStatus(message);
    } finally {
      setLoading(false);
    }
  }, [client, cachedNotes]);

  // Debounced search on typing
  useEffect(() => {
    const timeout = setTimeout(() => {
      void loadNotes(query);
    }, 300);
    return () => clearTimeout(timeout);
  }, [query, loadNotes]);

  // All extracted labels from active notes
  const availableTags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const note of notes) {
      if (note.labels) {
        note.labels.forEach((l: string) => tagSet.add(l));
      }
    }
    return Array.from(tagSet);
  }, [notes]);

  // Filter notes by tag if tag is selected
  const filteredNotes = useMemo(() => {
    if (!selectedTag) return notes;
    return notes.filter((n: NoteItem) => n.labels && n.labels.includes(selectedTag));
  }, [notes, selectedTag]);

  const pinnedNotes = useMemo(() => filteredNotes.filter((n: NoteItem) => n.pinned), [filteredNotes]);
  const otherNotes = useMemo(() => filteredNotes.filter((n: NoteItem) => !n.pinned), [filteredNotes]);

  const handleSaveNote = async (noteData: Partial<NoteItem> & { title: string }) => {
    const isNew = !noteData.path;
    const timestamp = Date.now();
    const cleanId = noteData.id || `note_${timestamp}_${Math.random().toString(36).substring(2, 6)}`;
    const filename = `${cleanId}.md`;
    const filePath = isNew ? `Notes/${filename}` : noteData.path!;

    let attachments = noteData.attachments || [];
    let content = noteData.content || '';
    try {
      attachments = await Promise.all(attachments.map(async (attachment) => {
        if (!attachment.uri.startsWith('file:') && !attachment.uri.startsWith('content:')) return attachment;
        const blob = await (await fetch(attachment.uri)).blob();
        const uploaded = await client.uploadFile(blob, { directory: `/Notes/${cleanId}`, path: attachment.name });
        content = content.split(attachment.uri).join(uploaded.path);
        return { ...attachment, uri: uploaded.path };
      }));
    } catch (error) {
      console.warn('Some attachments will remain local until the next save:', error);
    }

    const markdownString = serializeNoteMarkdown({ ...noteData, content, attachments, id: cleanId, path: filePath });

    const encoder = new TextEncoder();
    const bytes = encoder.encode(markdownString);

    // Save to /{user}/Notes on Flux deployment
    const savedNote: NoteItem = {
      id: cleanId, path: filePath, title: noteData.title, content,
      isChecklist: Boolean(noteData.isChecklist), checklistItems: noteData.checklistItems || [],
      pinned: Boolean(noteData.pinned), color: noteData.color || 'default', labels: noteData.labels || [],
      createdAt: noteData.createdAt || timestamp, updatedAt: timestamp, attachments,
    };
    const updatedCache = await upsertCachedNote(savedNote);
    setCachedNotes(updatedCache);
    setNotes(searchCachedNotes(updatedCache, query));

    try {
      await client.uploadFile(bytes, { directory: '/Notes', path: filename });
    } catch (error) {
      console.warn('Saved note locally; upload will retry on the next sync:', error);
    }
  };

  const handleDeleteNote = async (noteId: string, filePath: string) => {
    const note = notes.find((item) => item.id === noteId || item.path === filePath);
    if (note) {
      const updatedCache = await deleteCachedNote(note);
      setCachedNotes(updatedCache);
      setNotes(searchCachedNotes(updatedCache, query));
    }
    try {
      await client.deleteFile(filePath);
    } catch (error) {
      console.warn('Deleted note locally; remote delete failed:', error);
    }
  };

  const handleTogglePin = async (note: NoteItem) => {
    const updatedPinned = !note.pinned;
    const updatedNote: NoteItem = { ...note, pinned: updatedPinned, updatedAt: Date.now() };

    // Update local state immediately for instant feedback
    setNotes((prev: NoteItem[]) =>
      prev.map((n: NoteItem) => (n.id === note.id ? updatedNote : n))
    );
    const updatedCache = await upsertCachedNote(updatedNote);
    setCachedNotes(updatedCache);

    const markdownString = serializeNoteMarkdown(updatedNote);
    const encoder = new TextEncoder();
    const bytes = encoder.encode(markdownString);

    const filename = note.path.split('/').pop() || `${note.id}.md`;
    try { await client.uploadFile(bytes, { directory: '/Notes', path: filename }); } catch (error) { console.warn('Pin updated locally:', error); }
  };

  const handleToggleCheckItem = async (note: NoteItem, itemId: string) => {
    const updatedItems = note.checklistItems.map((item) =>
      item.id === itemId ? { ...item, completed: !item.completed } : item
    );
    const updatedNote: NoteItem = { ...note, checklistItems: updatedItems, updatedAt: Date.now() };

    setNotes((prev: NoteItem[]) =>
      prev.map((n: NoteItem) => (n.id === note.id ? updatedNote : n))
    );
    const updatedCache = await upsertCachedNote(updatedNote);
    setCachedNotes(updatedCache);

    const markdownString = serializeNoteMarkdown(updatedNote);
    const encoder = new TextEncoder();
    const bytes = encoder.encode(markdownString);

    const filename = note.path.split('/').pop() || `${note.id}.md`;
    try { await client.uploadFile(bytes, { directory: '/Notes', path: filename }); } catch (error) { console.warn('Checklist updated locally:', error); }
  };

  const signOut = async () => {
    setLoggingOut(true);
    try {
      await client.logout();
      onLoggedOut();
    } catch (logoutError) {
      const message = logoutError instanceof Error ? logoutError.message : 'Sign out failed';
      Alert.alert('Sign out failed', message);
    } finally {
      setLoggingOut(false);
    }
  };

  const transport = client.getTransportMode();
  const connectionIcon = getConnectionIcon(connectionState, transport);
  const instanceLabel = authSession?.label || authSession?.instanceId || 'Flux Instance';

  const isGrid = viewMode === 'grid';

  const openNewNoteModal = (isChecklist: boolean = false) => {
    setEditingNote(null);
    setInitialIsChecklist(isChecklist);
    setEditorOpen(true);
  };

  const openEditNoteModal = (note: NoteItem) => {
    setEditingNote(note);
    setInitialIsChecklist(note.isChecklist);
    setEditorOpen(true);
  };

  const renderNotes = (items: NoteItem[]) => {
    if (!isGrid) return <View style={styles.listContainer}>{items.map(renderNote)}</View>;
    const [left, right] = splitMasonryColumns(items);
    return <View style={styles.masonryContainer}>
      <View style={styles.masonryColumn}>{left.map(renderNote)}</View>
      <View style={styles.masonryColumn}>{right.map(renderNote)}</View>
    </View>;
  };

  function renderNote(note: NoteItem) {
    return <NoteCard
      key={note.id}
      note={note}
      cardWidth={isGrid ? '100%' : '100%'}
      onPress={() => openEditNoteModal(note)}
      onTogglePin={() => void handleTogglePin(note)}
      onToggleCheckItem={(itemId: string) => void handleToggleCheckItem(note, itemId)}
    />;
  }

  return (
    <View style={styles.container}>
      {/* Top Header Bar */}
      <View style={[styles.appBar, { paddingTop: insets.top + 10 }]}>
        <View style={styles.appBarLeft}>
          <Ionicons name="journal" size={26} color="#eab308" />
          <Text style={styles.appBarTitle}>Flux Notes</Text>
        </View>

        <View style={styles.appBarRight}>
          <View style={styles.connectionBadge}>
            <Ionicons name={connectionIcon.name} size={16} color={connectionIcon.color} />
            <Text style={styles.connectionLabel} numberOfLines={1}>
              {transport === 'local' ? 'Local' : 'Cloud'}
            </Text>
          </View>

          <Pressable onPress={() => setViewMode((prev: ViewMode) => (prev === 'grid' ? 'list' : 'grid'))} hitSlop={8}>
            <Ionicons name={isGrid ? 'list-outline' : 'grid-outline'} size={24} color="#0f172a" />
          </Pressable>

          <Pressable onPress={() => setMenuOpen(true)} hitSlop={8}>
            <Ionicons name="person-circle-outline" size={28} color="#0f172a" />
          </Pressable>
        </View>
      </View>

      {/* Account / Diagnostics Dropdown Modal */}
      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={styles.menuOverlay} onPress={() => setMenuOpen(false)}>
          <View style={[styles.menuCard, { top: insets.top + 56 }]}>
            <Text style={styles.menuName}>{authSession?.user ?? 'Flux User'}</Text>
            <Text style={styles.menuMeta}>{instanceLabel}</Text>
            <Text style={styles.menuMeta}>
              {connectionState === 'connected'
                ? transport === 'local'
                  ? 'Connected via Local Wi-Fi'
                  : 'Connected via Cloud Relay'
                : connectionState}
            </Text>
            <View style={styles.menuDivider} />

            <Text style={styles.diagnosticsTitle}>Connection Diagnostics</Text>
            <View style={styles.diagnosticsPanel}>
              {diagnostics.length === 0 ? (
                <Text style={styles.emptyDiag}>No logs recorded.</Text>
              ) : (
                diagnostics.slice(-5).map((event) => (
                  <Text key={`${event.timestamp}-${event.event}`} style={styles.diagLine} numberOfLines={1}>
                    {event.event}: {event.message}
                  </Text>
                ))
              )}
            </View>

            <View style={styles.menuDivider} />
            <Pressable
              onPress={() => {
                setMenuOpen(false);
                void signOut();
              }}
              disabled={loggingOut}
              hitSlop={8}
            >
              <Text style={styles.menuSignOut}>{loggingOut ? 'Signing out...' : 'Sign out'}</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      {/* Search Input */}
      <View style={styles.searchBarContainer}>
        <Ionicons name="search-outline" size={20} color="#64748b" style={styles.searchIcon} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search your notes (title, text, tags)..."
          placeholderTextColor="#94a3b8"
          style={styles.searchInput}
          autoCapitalize="none"
          clearButtonMode="while-editing"
        />
        {loading ? <ActivityIndicator size="small" color="#eab308" style={styles.searchLoader} /> : null}
      </View>

      {/* Tag filter bar */}
      {availableTags.length > 0 ? (
        <View style={styles.tagsBar}>
          <Pressable
            style={[styles.tagChip, selectedTag === null && styles.tagChipSelected]}
            onPress={() => setSelectedTag(null)}
          >
            <Text style={[styles.tagChipText, selectedTag === null && styles.tagChipTextSelected]}>
              All Notes
            </Text>
          </Pressable>
          {availableTags.map((tag: string) => (
            <Pressable
              key={tag}
              style={[styles.tagChip, selectedTag === tag && styles.tagChipSelected]}
              onPress={() => setSelectedTag(selectedTag === tag ? null : tag)}
            >
              <Text style={[styles.tagChipText, selectedTag === tag && styles.tagChipTextSelected]}>
                #{tag}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      {/* Notes List / Grid */}
      <FlatList
        style={styles.notesList}
        contentContainerStyle={styles.notesContent}
        data={[]}
        renderItem={null}
        onRefresh={() => void loadNotes(query)}
        refreshing={false}
        ListHeaderComponent={
          <View>
            {/* PINNED SECTION */}
            {pinnedNotes.length > 0 ? (
              <View style={styles.sectionContainer}>
                <Text style={styles.sectionTitle}>PINNED</Text>
                {renderNotes(pinnedNotes)}
              </View>
            ) : null}

            {/* OTHERS SECTION */}
            {otherNotes.length > 0 ? (
              <View style={styles.sectionContainer}>
                {pinnedNotes.length > 0 ? <Text style={styles.sectionTitle}>OTHERS</Text> : null}
                {renderNotes(otherNotes)}
              </View>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          !loading && notes.length === 0 ? (
            <View style={styles.emptyContainer}>
              <Ionicons name="bulb-outline" size={64} color="#cbd5e1" />
              <Text style={styles.emptyTitle}>
                {query.trim() ? `No notes match "${query.trim()}"` : 'Notes you add appear here'}
              </Text>
              <Text style={styles.emptySubtitle}>
                Tap the bottom bar to create a text note or shopping list.
              </Text>
            </View>
          ) : null
        }
      />

      {/* Quick Action Footer Bar (Google Keep style) */}
      <View style={[styles.bottomBar, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <Pressable style={styles.quickInputBar} onPress={() => openNewNoteModal(false)}>
          <Text style={styles.quickInputPlaceholder}>Take a note...</Text>
        </Pressable>
        <Pressable
          style={styles.quickChecklistBtn}
          onPress={() => openNewNoteModal(true)}
          hitSlop={8}
        >
          <Ionicons name="checkbox-outline" size={24} color="#ca8a04" />
        </Pressable>
      </View>

      {/* Editor Modal */}
      <NoteEditorModal
        visible={editorOpen}
        initialNote={editingNote}
        initialIsChecklist={initialIsChecklist}
        initialDraft={sharedDraft || undefined}
        client={client}
        onClose={() => { setEditorOpen(false); setSharedDraft(null); }}
        onSave={handleSaveNote}
        onDelete={handleDeleteNote}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fefce8',
  },
  appBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 10,
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#fef08a',
  },
  appBarLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  appBarTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#0f172a',
  },
  appBarRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  connectionBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#fef9c3',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
  },
  connectionLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#475569',
  },
  menuOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.25)',
  },
  menuCard: {
    position: 'absolute',
    right: 16,
    width: 260,
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 16,
    shadowColor: '#0f172a',
    shadowOpacity: 0.15,
    shadowRadius: 16,
    elevation: 8,
  },
  menuName: {
    fontSize: 16,
    fontWeight: '700',
    color: '#0f172a',
  },
  menuMeta: {
    fontSize: 12,
    color: '#64748b',
    marginTop: 2,
  },
  menuDivider: {
    height: 1,
    backgroundColor: '#e2e8f0',
    marginVertical: 10,
  },
  diagnosticsTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#94a3b8',
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  diagnosticsPanel: {
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    padding: 8,
    gap: 2,
  },
  emptyDiag: {
    fontSize: 11,
    color: '#94a3b8',
  },
  diagLine: {
    fontSize: 10,
    color: '#475569',
    fontFamily: 'monospace',
  },
  menuSignOut: {
    fontSize: 14,
    fontWeight: '700',
    color: '#dc2626',
  },
  searchBarContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ffffff',
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 8,
    borderRadius: 24,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#fef08a',
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 6,
    elevation: 2,
  },
  searchIcon: {
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: '#0f172a',
  },
  searchLoader: {
    marginLeft: 6,
  },
  tagsBar: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 6,
    gap: 8,
  },
  tagChip: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 16,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  tagChipSelected: {
    backgroundColor: '#eab308',
    borderColor: '#ca8a04',
  },
  tagChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#475569',
  },
  tagChipTextSelected: {
    color: '#ffffff',
  },
  errorText: {
    color: '#dc2626',
    backgroundColor: '#fee2e2',
    marginHorizontal: 16,
    padding: 10,
    borderRadius: 8,
    fontSize: 12,
  },
  notesList: {
    flex: 1,
  },
  notesContent: {
    paddingHorizontal: 16,
    paddingBottom: 80,
  },
  sectionContainer: {
    marginTop: 12,
    marginBottom: 8,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748b',
    letterSpacing: 1,
    marginBottom: 8,
  },
  masonryContainer: {
    flexDirection: 'row',
    gap: 12,
  },
  masonryColumn: { flex: 1 },
  listContainer: {
    flexDirection: 'column',
    gap: 12,
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 60,
    paddingHorizontal: 32,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#64748b',
    marginTop: 16,
    textAlign: 'center',
  },
  emptySubtitle: {
    fontSize: 13,
    color: '#94a3b8',
    marginTop: 6,
    textAlign: 'center',
  },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#ffffff',
    borderTopWidth: 1,
    borderTopColor: '#fef08a',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 10,
    gap: 12,
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 8,
  },
  quickInputBar: {
    flex: 1,
    height: 42,
    backgroundColor: '#fefce8',
    borderRadius: 21,
    borderWidth: 1,
    borderColor: '#fef08a',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  quickInputPlaceholder: {
    color: '#64748b',
    fontSize: 14,
    fontWeight: '500',
  },
  quickChecklistBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#fef9c3',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
