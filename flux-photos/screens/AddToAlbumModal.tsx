import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { FluxClient } from '@flux-sdk/core';
import { Album } from '../types/album';
import {
  addPhotosToAlbum,
  createAlbum,
  getCachedAlbums,
  loadAlbums,
  removePhotoFromAlbum,
  saveAlbum,
} from '../utils/albumStore';
import AlbumNameModal from './AlbumNameModal';

type Props = {
  client: FluxClient;
  visible: boolean;
  photoPath: string | null;
  onClose: () => void;
  onChanged?: () => void;
};

/** Adds or removes one photo from the user's albums, with an inline "new album" option. */
export default function AddToAlbumModal({ client, visible, photoPath, onClose, onChanged }: Props) {
  const [albums, setAlbums] = useState<Album[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setAlbums(await getCachedAlbums());
    try {
      setAlbums(await loadAlbums(client));
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load albums');
    }
  }, [client]);

  useEffect(() => {
    if (visible) void load();
  }, [visible, load]);

  const applyChange = async (album: Album, next: Album) => {
    setBusyId(album.id);
    setError(null);
    try {
      setAlbums(await saveAlbum(client, next));
      onChanged?.();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not update the album');
      setAlbums(await getCachedAlbums());
    } finally {
      setBusyId(null);
    }
  };

  const toggle = (album: Album) => {
    if (!photoPath || busyId) return;
    const next = album.photoPaths.includes(photoPath)
      ? removePhotoFromAlbum(album, photoPath)
      : addPhotosToAlbum(album, [photoPath]);
    void applyChange(album, next);
  };

  const create = (name: string) => {
    setCreating(false);
    if (!photoPath) return;
    const album = createAlbum(name, [photoPath]);
    void applyChange(album, album);
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>Add to album</Text>
            <Pressable onPress={onClose} hitSlop={12}>
              <Text style={styles.cancel}>Done</Text>
            </Pressable>
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <FlatList
            data={albums ?? []}
            keyExtractor={(album) => album.id}
            ListHeaderComponent={
              <Pressable style={styles.row} onPress={() => setCreating(true)}>
                <Ionicons name="add-circle-outline" size={22} color="#2563eb" />
                <Text style={[styles.rowText, styles.newAlbum]}>New album</Text>
              </Pressable>
            }
            renderItem={({ item }) => {
              const included = photoPath !== null && item.photoPaths.includes(photoPath);
              return (
                <Pressable style={styles.row} onPress={() => toggle(item)} disabled={busyId !== null}>
                  <Ionicons
                    name={included ? 'checkmark-circle' : 'ellipse-outline'}
                    size={22}
                    color={included ? '#16a34a' : '#94a3b8'}
                  />
                  <Text style={styles.rowText} numberOfLines={1}>{item.title}</Text>
                  {busyId === item.id ? (
                    <ActivityIndicator size="small" />
                  ) : (
                    <Text style={styles.rowMeta}>{item.photoPaths.length}</Text>
                  )}
                </Pressable>
              );
            }}
            ListEmptyComponent={
              albums === null ? <ActivityIndicator style={styles.loader} /> : <Text style={styles.empty}>No albums yet.</Text>
            }
          />
        </View>
      </View>

      <AlbumNameModal
        visible={creating}
        title="New album"
        confirmLabel="Create"
        onCancel={() => setCreating(false)}
        onConfirm={create}
      />
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(15, 23, 42, 0.35)',
  },
  sheet: {
    maxHeight: '70%',
    backgroundColor: '#fff',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 20,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
    color: '#0f172a',
  },
  cancel: {
    fontSize: 15,
    fontWeight: '600',
    color: '#2563eb',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  rowText: {
    flex: 1,
    fontSize: 15,
    color: '#0f172a',
  },
  newAlbum: {
    fontWeight: '600',
    color: '#2563eb',
  },
  rowMeta: {
    fontSize: 13,
    color: '#64748b',
  },
  loader: {
    marginTop: 20,
  },
  empty: {
    marginTop: 20,
    fontSize: 13,
    color: '#64748b',
    textAlign: 'center',
  },
  error: {
    backgroundColor: '#fee2e2',
    borderColor: '#fca5a5',
    borderWidth: 1,
    borderRadius: 10,
    color: '#991b1b',
    fontSize: 12,
    padding: 10,
    marginBottom: 10,
  },
});
