import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
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
import { FacePersonDetail, FaceRef, FluxClient, SearchResult } from '@flux-sdk/core';
import FaceAvatar from './FaceAvatar';
import LabelPersonModal from './LabelPersonModal';
import PhotoThumbnail from './PhotoThumbnail';
import PhotoViewerScreen from './PhotoViewerScreen';

type Props = {
  client: FluxClient;
  personId: string;
  /** Search results already loaded by the gallery, reused so the viewer has full metadata. */
  knownPhotos: Map<string, SearchResult>;
  onClose: () => void;
  onChanged: () => void;
};

const GRID_COLUMNS = 3;
const GRID_GAP = 4;
const PADDING = 16;

function toSearchResult(face: FaceRef): SearchResult {
  return {
    path: face.path,
    file_name: face.path.split('/').pop() || face.path,
    content_preview: '',
    tags: [],
    faces: [],
    date_created: face.date_created,
    owner: '',
    allowed_users: [],
    score: 0,
  };
}

export default function PersonScreen({ client, personId, knownPhotos, onClose, onChanged }: Props) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [currentId, setCurrentId] = useState(personId);
  const [person, setPerson] = useState<FacePersonDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [labelOpen, setLabelOpen] = useState(false);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPerson(await client.getPerson(currentId));
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load person');
    } finally {
      setLoading(false);
    }
  }, [client, currentId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => subscription.remove();
  }, [onClose]);

  // One entry per photo, even if the same person was (wrongly) grouped twice in one photo.
  const photoFaces = useMemo(() => {
    const seen = new Set<string>();
    return (person?.faces ?? []).filter((face) => {
      if (seen.has(face.path)) return false;
      seen.add(face.path);
      return true;
    });
  }, [person]);
  const photos = useMemo(
    () => photoFaces.map((face) => knownPhotos.get(face.path) ?? toSearchResult(face)),
    [photoFaces, knownPhotos],
  );

  const displayName = person?.name ?? null;

  const removeFace = (face: FaceRef) => {
    const remaining = person?.faces.length ?? 0;
    const remove = async () => {
      try {
        await client.assignFace(face.id, null);
        onChanged();
        if (remaining <= 1) onClose();
        else await load();
      } catch (assignError) {
        Alert.alert('Could not remove', assignError instanceof Error ? assignError.message : 'Request failed');
      }
    };
    const message = displayName ? `This photo isn't ${displayName}.` : "This photo isn't the same person.";
    // Alert buttons are ignored by react-native-web.
    if (Platform.OS === 'web') {
      if (globalThis.confirm?.(`Remove from this person? ${message}`)) void remove();
      return;
    }
    Alert.alert('Remove from this person?', message, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => void remove() },
    ]);
  };

  if (viewerIndex !== null) {
    return (
      <PhotoViewerScreen
        client={client}
        photos={photos}
        initialIndex={viewerIndex}
        onClose={() => setViewerIndex(null)}
        onPeopleChanged={() => {
          onChanged();
          void load();
        }}
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
        <Text style={styles.appBarTitle} numberOfLines={1}>{displayName ?? 'Unnamed person'}</Text>
        <Pressable onPress={() => setLabelOpen(true)} hitSlop={12} disabled={!person}>
          <Text style={styles.appBarAction}>{displayName ? 'Rename' : 'Add name'}</Text>
        </Pressable>
      </View>

      <FlatList
        data={photoFaces}
        numColumns={GRID_COLUMNS}
        keyExtractor={(face) => face.id}
        contentContainerStyle={styles.listContent}
        columnWrapperStyle={styles.gridRow}
        onRefresh={() => void load()}
        refreshing={false}
        ListHeaderComponent={
          <View style={styles.summary}>
            <FaceAvatar client={client} face={person?.cover} size={88} />
            <View style={styles.summaryText}>
              <Text style={styles.summaryName}>{displayName ?? 'Who is this?'}</Text>
              {person ? (
                <Text style={styles.summaryMeta}>
                  {person.photo_count} {person.photo_count === 1 ? 'photo' : 'photos'}
                  {person.contact_id ? ' · Linked to contact' : ''}
                </Text>
              ) : null}
              <Text style={styles.hint}>Long-press a photo that isn't this person to remove it.</Text>
            </View>
            {loading && !person ? <ActivityIndicator /> : null}
            {error ? <Text style={styles.error}>{error}</Text> : null}
          </View>
        }
        renderItem={({ item, index }) => (
          <Pressable onPress={() => setViewerIndex(index)} onLongPress={() => removeFace(item)}>
            <PhotoThumbnail client={client} path={item.path} style={{ width: cellSize, height: cellSize, borderRadius: 8 }} />
          </Pressable>
        )}
      />

      <LabelPersonModal
        client={client}
        visible={labelOpen}
        personId={person?.id ?? null}
        currentName={displayName}
        face={person?.cover}
        onClose={() => setLabelOpen(false)}
        onLabelled={(id) => {
          setLabelOpen(false);
          setCurrentId(id);
          onChanged();
          void load();
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
    fontSize: 15,
    fontWeight: '600',
    color: '#2563eb',
  },
  listContent: {
    padding: PADDING,
  },
  gridRow: {
    gap: GRID_GAP,
    marginBottom: GRID_GAP,
  },
  summary: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 16,
    marginBottom: 16,
  },
  summaryText: {
    flex: 1,
    gap: 4,
  },
  summaryName: {
    fontSize: 20,
    fontWeight: '700',
    color: '#0f172a',
  },
  summaryMeta: {
    fontSize: 13,
    color: '#475569',
  },
  hint: {
    fontSize: 12,
    color: '#94a3b8',
  },
  error: {
    width: '100%',
    color: '#b91c1c',
    fontSize: 12,
  },
});
