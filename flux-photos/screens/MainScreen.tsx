import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Button,
  FlatList,
  Image,
  Modal,
  Pressable,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import { FluxClient, SearchResult, DiagnosticEvent, ConnectionState, TransportMode, FacePerson } from '@flux-sdk/core';
import { Album } from '../types/album';
import { createAlbum, getCachedAlbums, loadAlbums as fetchAlbums, saveAlbum } from '../utils/albumStore';
import AlbumNameModal from './AlbumNameModal';
import AlbumScreen from './AlbumScreen';
import PhotoThumbnail from './PhotoThumbnail';
import PhotoViewerScreen from './PhotoViewerScreen';
import PersonScreen from './PersonScreen';
import SuggestionsScreen from './SuggestionsScreen';
import FaceAvatar from './FaceAvatar';
import { clearPhotoCache } from './photoImage';

type Props = {
  client: FluxClient;
  diagnostics: DiagnosticEvent[];
  onLoggedOut: () => void;
};

const GRID_COLUMNS = 3;
const GRID_GAP = 4;
const CONTAINER_PADDING = 20;
const IMAGE_FILE = /\.(jpe?g|png|webp|gif|bmp|tiff?|heic|heif)$/i;

type ConnectionIcon = {
  name: keyof typeof Ionicons.glyphMap;
  color: string;
};

type PeopleView = { kind: 'person'; personId: string } | { kind: 'suggestions' };

function getConnectionIcon(connectionState: ConnectionState, transport: TransportMode): ConnectionIcon {
  if (connectionState !== 'connected') {
    return { name: 'cloud-offline-outline', color: '#94a3b8' };
  }
  if (transport === 'local') {
    return { name: 'home-outline', color: '#16a34a' };
  }
  return { name: 'cloud-outline', color: '#2563eb' };
}

export default function MainScreen({ client, diagnostics, onLoggedOut }: Props) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [connectionState, setConnectionState] = useState(client.getState());
  const [query, setQuery] = useState('');
  const [selectedAsset, setSelectedAsset] = useState<ImagePicker.ImagePickerAsset | null>(null);
  const [photos, setPhotos] = useState<SearchResult[]>([]);
  const [loadingPhotos, setLoadingPhotos] = useState(false);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [status, setStatus] = useState('Ready');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [people, setPeople] = useState<FacePerson[]>([]);
  const [suggestionCount, setSuggestionCount] = useState(0);
  const [peopleView, setPeopleView] = useState<PeopleView | null>(null);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [openAlbumId, setOpenAlbumId] = useState<string | null>(null);
  const [creatingAlbum, setCreatingAlbum] = useState(false);

  const knownPhotos = useMemo(() => new Map(photos.map((photo) => [photo.path, photo])), [photos]);

  const loadAlbums = useCallback(async () => {
    setAlbums(await getCachedAlbums());
    try {
      setAlbums(await fetchAlbums(client));
    } catch {
      // Albums stay on their cached copy until the instance is reachable again.
    }
  }, [client]);

  useEffect(() => {
    void loadAlbums();
  }, [loadAlbums]);

  const loadPeople = useCallback(async () => {
    try {
      const [nextPeople, suggestions] = await Promise.all([
        client.listPeople(),
        client.getFaceSuggestions(50),
      ]);
      setPeople(nextPeople);
      setSuggestionCount(suggestions.length);
    } catch {
      // Face grouping is optional; older instances don't serve these endpoints.
    }
  }, [client]);

  useEffect(() => {
    void loadPeople();
  }, [loadPeople]);

  useEffect(() => {
    const unsubscribe = client.onStateChange(setConnectionState);
    return () => unsubscribe();
  }, [client]);

  const authSession = client.getAuthSession();

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

  const loadPhotos = useCallback(async (searchQuery: string) => {
    setLoadingPhotos(true);
    setError(null);

    try {
      await client.connect();
      const items = await client.search({ q: searchQuery.trim(), limit: 300 });
      // Search also returns notes, contacts and album manifests stored in the same workspace.
      const sorted = items.filter((item) => IMAGE_FILE.test(item.path)).sort((a, b) => b.date_created - a.date_created);
      setPhotos(sorted);
      setStatus(searchQuery.trim() ? `${sorted.length} results for “${searchQuery.trim()}”` : `${sorted.length} photos`);
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : 'Failed to load photos';
      setError(message);
      setStatus(message);
    } finally {
      setLoadingPhotos(false);
    }
  }, [client]);

  // Debounce so the grid refines as the user types instead of firing a request per keystroke.
  useEffect(() => {
    const timeout = setTimeout(() => {
      void loadPhotos(query);
    }, 300);
    return () => clearTimeout(timeout);
  }, [query, loadPhotos]);

  const pickImage = async () => {
    setError(null);

    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      const message = 'Please allow access to your photo library.';
      setError(message);
      Alert.alert('Permission required', message);
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.8,
      allowsEditing: false,
    });

    if (result.canceled || result.assets.length === 0) {
      return;
    }

    const asset = result.assets[0];
    const info = await FileSystem.getInfoAsync(asset.uri);
    setSelectedAsset(asset);
    setStatus(info.exists ? `Selected ${asset.fileName ?? 'image'}` : 'Image selected');
  };

  const uploadSelectedImage = async () => {
    if (!selectedAsset) {
      Alert.alert('Nothing selected', 'Pick an image before uploading.');
      return;
    }

    setBusy(true);
    setError(null);
    setUploadProgress(8);
    setStatus('Preparing upload...');

    try {
      await client.connect();
      setUploadProgress(32);

      const fileInfo = await FileSystem.getInfoAsync(selectedAsset.uri);
      if (!fileInfo.exists) {
        throw new Error('The selected file could not be found on disk.');
      }

      setUploadProgress(52);
      const uploadData = Platform.OS === 'web' && selectedAsset.file
        ? selectedAsset.file
        : await FileSystem.readAsStringAsync(selectedAsset.uri, {
            encoding: FileSystem.EncodingType.Base64,
          });
      if (!uploadData) {
        throw new Error('No image bytes were available for upload.');
      }

      const file = typeof uploadData === 'string'
        ? Uint8Array.from(atob(uploadData), (character) => character.charCodeAt(0))
        : uploadData;

      const fileName = selectedAsset.fileName ?? `flux-upload-${Date.now()}.jpg`;
      setUploadProgress(76);

      const uploaded = await client.uploadFile(file, {
        path: fileName,
        directory: '/Photos',
      });

      setUploadProgress(100);
      setStatus(`Uploaded ${uploaded.path}`);
      setSelectedAsset(null);
      await loadPhotos(query);
      void loadPeople();
    } catch (uploadError) {
      const message = uploadError instanceof Error ? uploadError.message : 'Upload failed';
      setError(message);
      setStatus(message);
      Alert.alert('Upload failed', message);
    } finally {
      setBusy(false);
      setTimeout(() => setUploadProgress(null), 900);
    }
  };

  if (viewerIndex !== null) {
    return (
      <PhotoViewerScreen
        client={client}
        photos={photos}
        initialIndex={viewerIndex}
        onClose={() => setViewerIndex(null)}
        onPeopleChanged={() => void loadPeople()}
        onAlbumsChanged={() => void loadAlbums()}
      />
    );
  }

  const openAlbum = albums.find((album) => album.id === openAlbumId);
  if (openAlbum) {
    return (
      <AlbumScreen
        client={client}
        album={openAlbum}
        knownPhotos={knownPhotos}
        onClose={() => setOpenAlbumId(null)}
        onChanged={setAlbums}
      />
    );
  }

  if (peopleView?.kind === 'person') {
    return (
      <PersonScreen
        client={client}
        personId={peopleView.personId}
        knownPhotos={knownPhotos}
        onClose={() => setPeopleView(null)}
        onChanged={() => void loadPeople()}
      />
    );
  }

  if (peopleView?.kind === 'suggestions') {
    return (
      <SuggestionsScreen
        client={client}
        onClose={() => setPeopleView(null)}
        onChanged={() => void loadPeople()}
      />
    );
  }

  const cellSize = (width - CONTAINER_PADDING * 2 - GRID_GAP * (GRID_COLUMNS - 1)) / GRID_COLUMNS;
  const transport = client.getTransportMode();
  const connectionIcon = getConnectionIcon(connectionState, transport);
  const instanceLabel = authSession?.label || authSession?.instanceId || 'Unknown instance';

  return (
    <View style={styles.container}>
      <View style={[styles.appBar, { paddingTop: insets.top + 10 }]}>
        <Text style={styles.appBarTitle}>Flux Photos</Text>
        <View style={styles.appBarRight}>
          <View style={styles.connectionBadge}>
            <Ionicons name={connectionIcon.name} size={16} color={connectionIcon.color} />
            <Text style={styles.connectionLabel} numberOfLines={1}>{instanceLabel}</Text>
          </View>
          <Pressable onPress={() => setMenuOpen(true)} hitSlop={12}>
            <Ionicons name="person-circle-outline" size={30} color="#0f172a" />
          </Pressable>
        </View>
      </View>

      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={styles.menuOverlay} onPress={() => setMenuOpen(false)}>
          <View style={[styles.menuCard, { top: insets.top + 56 }]}>
            <Text style={styles.menuName}>{authSession?.user ?? 'Unknown user'}</Text>
            <Text style={styles.menuMeta}>{instanceLabel}</Text>
            <Text style={styles.menuMeta}>
              {connectionState === 'connected' ? (transport === 'local' ? 'Local network' : 'Cloud relay') : connectionState}
            </Text>
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

      <FlatList
        style={styles.list}
        contentContainerStyle={styles.listContent}
        data={photos}
        numColumns={GRID_COLUMNS}
        keyExtractor={(item) => item.path}
        columnWrapperStyle={styles.gridRow}
        renderItem={({ item, index }) => (
          <Pressable onPress={() => setViewerIndex(index)}>
            <PhotoThumbnail
              client={client}
              path={item.path}
              style={{ width: cellSize, height: cellSize, borderRadius: 8 }}
            />
          </Pressable>
        )}
        ListHeaderComponent={
          <View>
            <Text style={styles.sectionTitle}>Connection diagnostics</Text>
            <View style={styles.diagnosticsPanel}>
              {diagnostics.length === 0 ? (
                <Text style={styles.empty}>No connection events yet.</Text>
              ) : diagnostics.slice(-8).map((event) => (
                <Text key={`${event.timestamp}-${event.event}`} style={event.level === 'error' ? styles.diagnosticError : styles.diagnosticText}>
                  {new Date(event.timestamp).toLocaleTimeString()} {event.event}: {event.message}
                </Text>
              ))}
            </View>

            <Text style={styles.status}>{status}</Text>
            {error ? <Text style={styles.error}>{error}</Text> : null}

            {uploadProgress !== null ? (
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${uploadProgress}%` }]} />
              </View>
            ) : null}

            {selectedAsset ? (
              <Image source={{ uri: selectedAsset.uri }} style={styles.preview} resizeMode="cover" />
            ) : null}

            <View style={styles.actionsRow}>
              <Button title="Pick image" onPress={() => void pickImage()} />
              <Button title="Upload" onPress={() => void uploadSelectedImage()} disabled={!selectedAsset || busy} />
            </View>

            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search photos"
              style={styles.input}
              autoCapitalize="none"
              clearButtonMode="while-editing"
            />

            {loadingPhotos ? <ActivityIndicator style={styles.loader} size="small" /> : null}

            {people.length > 0 ? (
              <View>
                <View style={styles.sectionHeader}>
                  <Text style={styles.sectionTitle}>People</Text>
                  {suggestionCount > 0 ? (
                    <Pressable style={styles.reviewButton} onPress={() => setPeopleView({ kind: 'suggestions' })} hitSlop={8}>
                      <Ionicons name="people-outline" size={16} color="#2563eb" />
                      <Text style={styles.reviewText}>
                        Review {suggestionCount} {suggestionCount === 1 ? 'suggestion' : 'suggestions'}
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.peopleStrip}>
                  {people.map((person) => (
                    <Pressable
                      key={person.id}
                      style={styles.personItem}
                      onPress={() => setPeopleView({ kind: 'person', personId: person.id })}
                    >
                      <FaceAvatar client={client} face={person.cover} size={64} />
                      <Text style={[styles.personName, !person.name && styles.personUnnamed]} numberOfLines={1}>
                        {person.name ?? 'Add name'}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </View>
            ) : null}

            <Text style={styles.sectionTitle}>Photos</Text>
          </View>
        }
        ListEmptyComponent={
          !loadingPhotos ? (
            <Text style={styles.empty}>
              {query.trim() ? `No photos match “${query.trim()}”.` : 'No photos yet.'}
            </Text>
          ) : null
        }
        onRefresh={() => {
          clearPhotoCache();
          void loadPhotos(query);
          void loadPeople();
        }}
        refreshing={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f7fb',
  },
  appBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 10,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
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
    maxWidth: 160,
  },
  connectionLabel: {
    fontSize: 12,
    color: '#475569',
  },
  menuOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.2)',
  },
  menuCard: {
    position: 'absolute',
    right: 16,
    minWidth: 200,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    gap: 4,
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
  },
  menuDivider: {
    height: 1,
    backgroundColor: '#e2e8f0',
    marginVertical: 8,
  },
  menuSignOut: {
    fontSize: 14,
    fontWeight: '600',
    color: '#dc2626',
  },
  list: {
    flex: 1,
  },
  listContent: {
    padding: CONTAINER_PADDING,
    flexGrow: 1,
  },
  gridRow: {
    gap: GRID_GAP,
    marginBottom: GRID_GAP,
  },
  status: {
    fontSize: 13,
    color: '#0f172a',
    marginBottom: 8,
  },
  error: {
    backgroundColor: '#fee2e2',
    borderColor: '#fca5a5',
    borderWidth: 1,
    borderRadius: 10,
    color: '#991b1b',
    fontSize: 12,
    padding: 10,
    marginBottom: 12,
  },
  progressTrack: {
    height: 10,
    borderRadius: 999,
    backgroundColor: '#dbeafe',
    overflow: 'hidden',
    marginBottom: 12,
  },
  progressFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: '#2563eb',
  },
  preview: {
    width: '100%',
    height: 200,
    borderRadius: 16,
    backgroundColor: '#dbeafe',
    marginBottom: 16,
  },
  actionsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 16,
  },
  input: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#fff',
    marginBottom: 12,
  },
  loader: {
    marginVertical: 8,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    marginTop: 8,
    marginBottom: 8,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  reviewButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  reviewText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#2563eb',
  },
  peopleStrip: {
    gap: 12,
    paddingBottom: 8,
  },
  personItem: {
    alignItems: 'center',
    width: 72,
    gap: 4,
  },
  personName: {
    fontSize: 12,
    color: '#0f172a',
  },
  personUnnamed: {
    color: '#94a3b8',
  },
  diagnosticsPanel: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    backgroundColor: '#f8fafc',
    padding: 10,
    gap: 4,
    marginBottom: 8,
  },
  diagnosticText: {
    color: '#334155',
    fontSize: 11,
  },
  diagnosticError: {
    color: '#b91c1c',
    fontSize: 11,
  },
  empty: {
    color: '#64748b',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 24,
  },
});

