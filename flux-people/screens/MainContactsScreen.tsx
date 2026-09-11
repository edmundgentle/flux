import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { ConnectionState, DiagnosticEvent, FluxClient, SearchResult, TransportMode } from '@flux-sdk/core';
import { ContactItem } from '../types/contact';
import {
  groupContactsAlphabetically,
  parseContactJson,
  serializeContactJson,
} from '../utils/contactUtils';
import ContactCard from '../components/ContactCard';
import ContactDetailModal from '../components/ContactDetailModal';
import ContactEditorModal from '../components/ContactEditorModal';

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

export default function MainContactsScreen({ client, diagnostics, onLoggedOut }: Props) {
  const insets = useSafeAreaInsets();
  const [connectionState, setConnectionState] = useState(client.getState());
  const [query, setQuery] = useState('');
  const [contacts, setContacts] = useState<ContactItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('Syncing contacts...');
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);

  // Modals state
  const [selectedContact, setSelectedContact] = useState<ContactItem | null>(null);
  const [detailModalOpen, setDetailModalOpen] = useState(false);

  const [editorModalOpen, setEditorModalOpen] = useState(false);
  const [editingContact, setEditingContact] = useState<ContactItem | null>(null);

  useEffect(() => {
    const unsubscribe = client.onStateChange(setConnectionState);
    return () => unsubscribe();
  }, [client]);

  const authSession = client.getAuthSession();

  const loadContacts = useCallback(async (searchQuery: string) => {
    setLoading(true);
    setError(null);

    try {
      await client.connect();

      // Query Tantivy via Flux SDK search API
      const searchResults: SearchResult[] = await client.search({
        q: searchQuery.trim(),
        limit: 300,
      });

      // Filter results for /Contacts/ directory or .json files under Contacts
      const contactFiles = searchResults.filter(
        (res) => res.path.includes('/Contacts/') || res.path.endsWith('.json')
      );

      // Fetch file content for each contact
      const loaded: ContactItem[] = await Promise.all(
        contactFiles.map(async (fileRes) => {
          try {
            const blob = await client.downloadFile(fileRes.path);
            const text = await blob.text();
            return parseContactJson(text, fileRes.path, fileRes.date_created);
          } catch {
            // Fallback parsing if download fails
            return parseContactJson(
              fileRes.content_preview || '{}',
              fileRes.path,
              fileRes.date_created
            );
          }
        })
      );

      setContacts(loaded);
      setStatus(
        searchQuery.trim()
          ? `${loaded.length} results matching "${searchQuery.trim()}"`
          : `${loaded.length} contacts`
      );
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : 'Failed to load contacts';
      setError(message);
      setStatus(message);
    } finally {
      setLoading(false);
    }
  }, [client]);

  // Debounced search on typing
  useEffect(() => {
    const timeout = setTimeout(() => {
      void loadContacts(query);
    }, 300);
    return () => clearTimeout(timeout);
  }, [query, loadContacts]);

  // Available tags extracted from all loaded contacts
  const availableTags = useMemo(() => {
    const set = new Set<string>();
    for (const c of contacts) {
      if (c.tags) c.tags.forEach((t) => set.add(t));
    }
    return Array.from(set);
  }, [contacts]);

  // Filter contacts by selected tag filter
  const filteredContacts = useMemo(() => {
    if (!selectedTag) return contacts;
    if (selectedTag === 'Favorites') return contacts.filter((c) => c.favorite);
    return contacts.filter((c) => c.tags && c.tags.includes(selectedTag));
  }, [contacts, selectedTag]);

  // Group contacts into Favorites section + Alphabetical sections
  const sections = useMemo(() => {
    const favorites = filteredContacts.filter((c) => c.favorite);
    const regular = selectedTag === 'Favorites' ? filteredContacts : filteredContacts.filter((c) => !c.favorite);

    const result: { title: string; data: ContactItem[] }[] = [];

    if (favorites.length > 0 && selectedTag !== 'Favorites') {
      result.push({
        title: '⭐ FAVORITES',
        data: favorites.sort((a, b) => a.displayName.localeCompare(b.displayName)),
      });
    }

    const grouped = groupContactsAlphabetically(regular);
    for (const grp of grouped) {
      result.push({
        title: grp.letter,
        data: grp.data,
      });
    }

    return result;
  }, [filteredContacts, selectedTag]);

  const handleSaveContact = async (
    contactData: Partial<ContactItem> & { firstName: string }
  ) => {
    const timestamp = Date.now();
    const cleanId = contactData.id || `contact_${timestamp}_${Math.random().toString(36).substring(2, 6)}`;
    const filename = `${cleanId}.json`;
    const filePath = contactData.path || `Contacts/${filename}`;

    const fullContactItem: ContactItem = {
      id: cleanId,
      firstName: contactData.firstName || '',
      lastName: contactData.lastName || '',
      displayName: contactData.firstName || contactData.lastName ? `${contactData.firstName || ''} ${contactData.lastName || ''}`.trim() : (contactData.company || 'Unnamed Contact'),
      company: contactData.company || '',
      jobTitle: contactData.jobTitle || '',
      phones: contactData.phones || [],
      emails: contactData.emails || [],
      addresses: contactData.addresses || [],
      notes: contactData.notes || '',
      birthday: contactData.birthday || '',
      tags: contactData.tags || [],
      favorite: Boolean(contactData.favorite),
      avatarUrl: contactData.avatarUrl || '',
      createdAt: contactData.createdAt || timestamp,
      updatedAt: timestamp,
      path: filePath,
    };

    const jsonString = serializeContactJson(fullContactItem);
    const encoder = new TextEncoder();
    const bytes = encoder.encode(jsonString);

    // Upload file to /{user}/Contacts/ in Flux server
    await client.uploadFile(bytes, {
      directory: '/Contacts',
      path: filename,
    });

    await loadContacts(query);
  };

  const handleDeleteContact = async (contact: ContactItem) => {
    try {
      await client.deleteFile(contact.path);
      await loadContacts(query);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Delete failed';
      Alert.alert('Delete failed', msg);
    }
  };

  const handleToggleFavorite = async (contact: ContactItem) => {
    const updated: ContactItem = {
      ...contact,
      favorite: !contact.favorite,
      updatedAt: Date.now(),
    };

    // Optimistic UI update
    setContacts((prev) => prev.map((c) => (c.id === contact.id ? updated : c)));
    if (selectedContact?.id === contact.id) {
      setSelectedContact(updated);
    }

    const jsonString = serializeContactJson(updated);
    const encoder = new TextEncoder();
    const bytes = encoder.encode(jsonString);

    const filename = contact.path.split('/').pop() || `${contact.id}.json`;
    await client.uploadFile(bytes, {
      directory: '/Contacts',
      path: filename,
    });
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

  const openNewContactModal = () => {
    setEditingContact(null);
    setEditorModalOpen(true);
  };

  const openEditContactModal = (contact: ContactItem) => {
    setEditingContact(contact);
    setEditorModalOpen(true);
  };

  const transport = client.getTransportMode();
  const connectionIcon = getConnectionIcon(connectionState, transport);
  const instanceLabel = authSession?.label || authSession?.instanceId || 'Flux Instance';

  return (
    <View style={styles.container}>
      {/* Top App Bar */}
      <View style={[styles.appBar, { paddingTop: insets.top + 8 }]}>
        <View style={styles.appBarLeft}>
          <View style={styles.appIconBg}>
            <Ionicons name="people" size={20} color="#2563eb" />
          </View>
          <Text style={styles.appBarTitle}>Flux People</Text>
        </View>

        <View style={styles.appBarRight}>
          <View style={styles.connectionBadge}>
            <Ionicons name={connectionIcon.name} size={15} color={connectionIcon.color} />
            <Text style={styles.connectionLabel} numberOfLines={1}>
              {transport === 'local' ? 'Local Wi-Fi' : 'Cloud Relay'}
            </Text>
          </View>

          <Pressable onPress={() => setMenuOpen(true)} hitSlop={8}>
            <Ionicons name="person-circle-outline" size={28} color="#0f172a" />
          </Pressable>
        </View>
      </View>

      {/* Account & Diagnostics Menu Modal */}
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

            <Text style={styles.menuSectionHeader}>Connection Diagnostics</Text>
            <View style={styles.diagnosticsBox}>
              {diagnostics.length === 0 ? (
                <Text style={styles.diagnosticText}>No diagnostic logs yet.</Text>
              ) : (
                diagnostics.slice(-5).map((ev) => (
                  <Text key={`${ev.timestamp}-${ev.event}`} style={ev.level === 'error' ? styles.diagnosticErr : styles.diagnosticText}>
                    {new Date(ev.timestamp).toLocaleTimeString()} {ev.event}: {ev.message}
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

      {/* Search Input & Status */}
      <View style={styles.searchContainer}>
        <View style={styles.searchBar}>
          <Ionicons name="search-outline" size={18} color="#64748b" style={styles.searchIcon} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search contacts..."
            style={styles.searchInput}
            autoCapitalize="none"
            clearButtonMode="while-editing"
          />
          {loading ? <ActivityIndicator size="small" color="#2563eb" style={{ marginLeft: 6 }} /> : null}
        </View>

        {/* Filter Pills */}
        <View style={styles.pillsRow}>
          <Pressable
            style={[styles.pill, selectedTag === null && styles.pillActive]}
            onPress={() => setSelectedTag(null)}
          >
            <Text style={[styles.pillText, selectedTag === null && styles.pillTextActive]}>All</Text>
          </Pressable>

          <Pressable
            style={[styles.pill, selectedTag === 'Favorites' && styles.pillActive]}
            onPress={() => setSelectedTag(selectedTag === 'Favorites' ? null : 'Favorites')}
          >
            <Text style={[styles.pillText, selectedTag === 'Favorites' && styles.pillTextActive]}>⭐ Favorites</Text>
          </Pressable>

          {availableTags.map((tag) => {
            const active = selectedTag === tag;
            return (
              <Pressable
                key={tag}
                style={[styles.pill, active && styles.pillActive]}
                onPress={() => setSelectedTag(active ? null : tag)}
              >
                <Text style={[styles.pillText, active && styles.pillTextActive]}>{tag}</Text>
              </Pressable>
            );
          })}
        </View>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}
      </View>

      {/* Contacts List */}
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        renderSectionHeader={({ section: { title } }) => (
          <View style={styles.sectionHeaderBg}>
            <Text style={styles.sectionHeaderText}>{title}</Text>
          </View>
        )}
        renderItem={({ item }) => (
          <ContactCard
            contact={item}
            onPress={() => {
              setSelectedContact(item);
              setDetailModalOpen(true);
            }}
            onToggleFavorite={() => handleToggleFavorite(item)}
          />
        )}
        ListEmptyComponent={
          !loading ? (
            <View style={styles.emptyContainer}>
              <Ionicons name="person-outline" size={48} color="#cbd5e1" />
              <Text style={styles.emptyTitle}>
                {query.trim() ? `No contacts matching "${query.trim()}"` : 'No contacts yet'}
              </Text>
              <Text style={styles.emptySubtitle}>
                {query.trim()
                  ? 'Try searching for a different name, company, or phone number.'
                  : 'Tap the + button below to add your first contact to Flux.'}
              </Text>
            </View>
          ) : null
        }
        onRefresh={() => void loadContacts(query)}
        refreshing={false}
      />

      {/* Floating Action Button (Add Contact) */}
      <Pressable style={styles.fab} onPress={openNewContactModal}>
        <Ionicons name="add" size={28} color="#ffffff" />
      </Pressable>

      {/* Contact Detail Modal */}
      <ContactDetailModal
        visible={detailModalOpen}
        contact={selectedContact}
        onClose={() => setDetailModalOpen(false)}
        onEdit={openEditContactModal}
        onDelete={handleDeleteContact}
        onToggleFavorite={handleToggleFavorite}
      />

      {/* Contact Editor Modal */}
      <ContactEditorModal
        visible={editorModalOpen}
        contact={editingContact}
        onClose={() => setEditorModalOpen(false)}
        onSave={handleSaveContact}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  appBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 10,
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  appBarLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  appIconBg: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: '#dbeafe',
    alignItems: 'center',
    justifyContent: 'center',
  },
  appBarTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#0f172a',
  },
  appBarRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  connectionBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#f1f5f9',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
  },
  connectionLabel: {
    fontSize: 12,
    color: '#475569',
    fontWeight: '500',
  },
  menuOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.2)',
  },
  menuCard: {
    position: 'absolute',
    right: 16,
    width: 260,
    backgroundColor: '#ffffff',
    borderRadius: 14,
    padding: 16,
    shadowColor: '#0f172a',
    shadowOpacity: 0.15,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
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
  menuSectionHeader: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748b',
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  diagnosticsBox: {
    backgroundColor: '#f1f5f9',
    borderRadius: 8,
    padding: 8,
    maxHeight: 120,
    gap: 4,
  },
  diagnosticText: {
    fontSize: 10,
    color: '#334155',
  },
  diagnosticErr: {
    fontSize: 10,
    color: '#dc2626',
  },
  menuSignOut: {
    fontSize: 14,
    fontWeight: '600',
    color: '#dc2626',
    textAlign: 'center',
  },
  searchContainer: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f1f5f9',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  searchIcon: {
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: '#0f172a',
    padding: 0,
  },
  pillsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 10,
    overflow: 'scroll',
  },
  pill: {
    backgroundColor: '#f1f5f9',
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 999,
  },
  pillActive: {
    backgroundColor: '#2563eb',
  },
  pillText: {
    fontSize: 13,
    color: '#475569',
    fontWeight: '500',
  },
  pillTextActive: {
    color: '#ffffff',
    fontWeight: '700',
  },
  errorText: {
    color: '#dc2626',
    fontSize: 12,
    marginTop: 6,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 100,
  },
  sectionHeaderBg: {
    backgroundColor: '#f8fafc',
    paddingVertical: 6,
    paddingHorizontal: 4,
    marginTop: 8,
  },
  sectionHeaderText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#64748b',
    letterSpacing: 0.5,
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
    paddingHorizontal: 20,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#334155',
    marginTop: 12,
  },
  emptySubtitle: {
    fontSize: 13,
    color: '#64748b',
    textAlign: 'center',
    marginTop: 6,
    lineHeight: 18,
  },
  fab: {
    position: 'absolute',
    right: 20,
    bottom: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#2563eb',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#2563eb',
    shadowOpacity: 0.35,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
});
