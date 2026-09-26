import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  BackHandler,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { FluxClient, SearchResult } from '@flux-sdk/core';
import { Album } from '../types/album';
import { deleteAlbum, removePhotoFromAlbum, renameAlbum, saveAlbum } from '../utils/albumStore';
import AlbumNameModal from './AlbumNameModal';
import PhotoThumbnail from './PhotoThumbnail';
import PhotoViewerScreen from './PhotoViewerScreen';

type Props = {
  client: FluxClient;
  album: Album;
  /** Search results already loaded by the gallery, reused so the viewer has full metadata. */
  knownPhotos: Map<string, SearchResult>;
  onClose: () => void;
  onChanged: (albums: Album[]) => void;
};

const GRID_COLUMNS = 3;
const GRID_GAP = 4;
const PADDING = 16;

function toSearchResult(path: string): SearchResult {
  return {
    path,
    file_name: path.split('/').pop() || path,
    content_preview: '',
    tags: [],
    faces: [],
    date_created: 0,
    owner: '',
    allowed_users: [],
    score: 0,
  };
}

function confirmDestructive(title: string, message: string, confirmLabel: string, onConfirm: () => void): void {
  // Alert buttons are ignored by react-native-web.
  if (Platform.OS === 'web') {
    if (globalThis.confirm?.(`${title} ${message}`)) onConfirm();
    return;
  }
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: confirmLabel, style: 'destructive', onPress: onConfirm },
  ]);
}

export default function AlbumScreen({ client, album: initialAlbum, knownPhotos, onClose, onChanged }: Props) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [album, setAlbum] = useState(initialAlbum);
  const [renaming, setRenaming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => subscription.remove();
  }, [onClose]);

  const photos = useMemo(
    () => album.photoPaths.map((path) => knownPhotos.get(path) ?? toSearchResult(path)),
    [album.photoPaths, knownPhotos],
  );

  const persist = async (next: Album, previousPath?: string) => {
    setBusy(true);
    setError(null);
    const rollback = album;
    setAlbum(next);
    try {
      onChanged(await saveAlbum(client, next, previousPath));
    } catch (saveError) {
      setAlbum(rollback);
      setError(saveError instanceof Error ? saveError.message : 'Could not save the album');
    } finally {
      setBusy(false);
    }
  };

  const removePhoto = (path: string) => {
    confirmDestructive('Remove from album?', 'The photo stays in your library.', 'Remove', () => {
      void persist(removePhotoFromAlbum(album, path));
    });
  };

  const remove = () => {
    confirmDestructive('Delete album?', 'The photos in it stay in your library.', 'Delete', () => {
      void (async () => {
        setBusy(true);
        try {
          onChanged(await deleteAlbum(client, album));
          onClose();
        } catch (deleteError) {
          setError(deleteError instanceof Error ? deleteError.message : 'Could not delete the album');
        } finally {
          setBusy(false);
        }
      })();
    });
  };

  if (viewerIndex !== null) {
    return (
      <PhotoViewerScreen
        client={client}
        photos={photos}
        initialIndex={viewerIndex}
        onClose={() => setViewerIndex(null)}
      />
    );
  }

  const cellSize = (width - PADDING * 2 - GRID_GAP * (GRID_COLUMNS - 1)) / GRID_COLUMNS;

  return (
    <View style={styles.container}>
      <View style={[styles.appBar, { paddingTop: insets.top + 10 }]}>
        <Pressable onPress={onClose} hitSlop={12}>
          <Ionicons name="chevron-back" size={26} color="#0f172a" />
        </Pressable>
        <Text style={styles.appBarTitle} numberOfLines={1}>{album.title}</Text>
        <Pressable onPress={() => setRenaming(true)} hitSlop={12} disabled={busy}>
          <Text style={styles.appBarAction}>Rename</Text>
        </Pressable>
        <Pressable onPress={remove} hitSlop={12} disabled={busy}>
          <Ionicons name="trash-outline" size={22} color="#dc2626" />
        </Pressable>
      </View>

      <FlatList
        data={album.photoPaths}
        numColumns={GRID_COLUMNS}
        keyExtractor={(path) => path}
        contentContainerStyle={styles.listContent}
        columnWrapperStyle={styles.gridRow}
        ListHeaderComponent={
          <View style={styles.summary}>
            <Text style={styles.summaryMeta}>
              {album.photoPaths.length} {album.photoPaths.length === 1 ? 'photo' : 'photos'}
            </Text>
            <Text style={styles.hint}>Long-press a photo to remove it from this album.</Text>
            {error ? <Text style={styles.error}>{error}</Text> : null}
          </View>
        }
        renderItem={({ item, index }) => (
          <Pressable onPress={() => setViewerIndex(index)} onLongPress={() => removePhoto(item)}>
            <PhotoThumbnail client={client} path={item} style={{ width: cellSize, height: cellSize, borderRadius: 8 }} />
          </Pressable>
        )}
        ListEmptyComponent={<Text style={styles.empty}>This album is empty.</Text>}
      />

      <AlbumNameModal
        visible={renaming}
        title="Rename album"
        confirmLabel="Save"
        initialName={album.title}
        onCancel={() => setRenaming(false)}
        onConfirm={(name) => {
          setRenaming(false);
          void persist(renameAlbum(album, name), album.path);
        }}
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
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingBottom: 10,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  appBarTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: '700',
    color: '#0f172a',
  },
  appBarAction: {
    fontSize: 14,
    fontWeight: '600',
    color: '#2563eb',
  },
  listContent: {
    padding: PADDING,
    flexGrow: 1,
  },
  gridRow: {
    gap: GRID_GAP,
    marginBottom: GRID_GAP,
  },
  summary: {
    marginBottom: 12,
    gap: 4,
  },
  summaryMeta: {
    fontSize: 14,
    color: '#0f172a',
  },
  hint: {
    fontSize: 12,
    color: '#64748b',
  },
  empty: {
    fontSize: 13,
    color: '#64748b',
    textAlign: 'center',
    marginTop: 24,
  },
  error: {
    backgroundColor: '#fee2e2',
    borderColor: '#fca5a5',
    borderWidth: 1,
    borderRadius: 10,
    color: '#991b1b',
    fontSize: 12,
    padding: 10,
    marginTop: 8,
  },
});
