import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  BackHandler,
  FlatList,
  ListRenderItemInfo,
  NativeScrollEvent,
  NativeSyntheticEvent,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { FluxClient, PhotoFace, SearchResult } from '@flux-sdk/core';
import { getPhotoUri } from './photoImage';
import AddToAlbumModal from './AddToAlbumModal';
import FaceAvatar from './FaceAvatar';
import LabelPersonModal from './LabelPersonModal';

type Props = {
  client: FluxClient;
  photos: SearchResult[];
  initialIndex: number;
  onClose: () => void;
  onPeopleChanged?: () => void;
  onAlbumsChanged?: () => void;
};

export default function PhotoViewerScreen({ client, photos, initialIndex, onClose, onPeopleChanged, onAlbumsChanged }: Props) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [showInfo, setShowInfo] = useState(false);
  const [photoFaces, setPhotoFaces] = useState<PhotoFace[]>([]);
  const [labelFace, setLabelFace] = useState<PhotoFace | null>(null);
  const [albumPickerOpen, setAlbumPickerOpen] = useState(false);
  const headerHeight = 48 + insets.top;
  const imageHeight = height - headerHeight;

  // Android hardware back button should return to the gallery, not exit the app.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => subscription.remove();
  }, [onClose]);

  const handleMomentumScrollEnd = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const index = Math.round(event.nativeEvent.contentOffset.x / width);
    setCurrentIndex(Math.max(0, Math.min(photos.length - 1, index)));
  }, [width, photos.length]);

  const renderItem = useCallback(({ item }: ListRenderItemInfo<SearchResult>) => (
    <ZoomablePhoto client={client} path={item.path} width={width} height={imageHeight} />
  ), [client, width, imageHeight]);

  const photo = photos[currentIndex];
  const photoPath = photo?.path;

  const loadFaces = useCallback(async (path: string) => {
    try {
      setPhotoFaces(await client.getPhotoFaces(path));
    } catch {
      setPhotoFaces([]);
    }
  }, [client]);

  useEffect(() => {
    setPhotoFaces([]);
    if (showInfo && photoPath) void loadFaces(photoPath);
  }, [showInfo, photoPath, loadFaces]);

  return (
    <View style={styles.container}>
      <View style={[styles.header, { height: headerHeight, paddingTop: insets.top }]}>
        <Pressable onPress={onClose} hitSlop={12}>
          <Text style={styles.headerButton}>Close</Text>
        </Pressable>
        {photos.length > 1 ? (
          <Text style={styles.headerCounter}>{currentIndex + 1} of {photos.length}</Text>
        ) : null}
        <View style={styles.headerActions}>
          <Pressable onPress={() => setAlbumPickerOpen(true)} hitSlop={12} disabled={!photoPath}>
            <Ionicons name="albums-outline" size={22} color="#fff" />
          </Pressable>
          <Pressable onPress={() => setShowInfo((current) => !current)} hitSlop={12}>
            <Text style={styles.headerButton}>{showInfo ? 'Hide info' : 'Info'}</Text>
          </Pressable>
        </View>
      </View>

      <FlatList
        data={photos}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        keyExtractor={(item) => item.path}
        initialScrollIndex={initialIndex}
        getItemLayout={(_, index) => ({ length: width, offset: width * index, index })}
        onMomentumScrollEnd={handleMomentumScrollEnd}
        renderItem={renderItem}
        style={{ height: imageHeight }}
      />

      {showInfo && photo ? (
        <View style={[styles.infoPanel, { paddingBottom: 16 + insets.bottom }]}>
          <Text style={styles.infoTitle} numberOfLines={1}>{photo.file_name}</Text>
          <Text style={styles.infoRow}>Taken {new Date(photo.date_created * 1000).toLocaleString()}</Text>
          {photo.owner ? <Text style={styles.infoRow}>Owner {photo.owner}</Text> : null}
          {photo.tags.length > 0 ? <Text style={styles.infoRow}>Tags: {photo.tags.join(', ')}</Text> : null}
          {photoFaces.length > 0 ? (
            <View style={styles.peopleRow}>
              {photoFaces.map((face) => (
                <Pressable key={face.id} style={styles.personChip} onPress={() => setLabelFace(face)}>
                  <FaceAvatar client={client} face={face} size={40} />
                  <Text style={styles.personChipText} numberOfLines={1}>{face.person_name ?? 'Add name'}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          {photo.latitude != null && photo.longitude != null ? (
            <Text style={styles.infoRow}>
              Location: {photo.latitude.toFixed(5)}, {photo.longitude.toFixed(5)}
            </Text>
          ) : null}
        </View>
      ) : null}

      <AddToAlbumModal
        client={client}
        visible={albumPickerOpen}
        photoPath={photoPath ?? null}
        onClose={() => setAlbumPickerOpen(false)}
        onChanged={onAlbumsChanged}
      />

      <LabelPersonModal
        client={client}
        visible={labelFace !== null}
        personId={labelFace?.person_id ?? null}
        currentName={labelFace?.person_name ?? null}
        face={labelFace}
        onClose={() => setLabelFace(null)}
        onLabelled={() => {
          setLabelFace(null);
          onPeopleChanged?.();
          if (photoPath) void loadFaces(photoPath);
        }}
      />
    </View>
  );
}

type ZoomablePhotoProps = {
  client: FluxClient;
  path: string;
  width: number;
  height: number;
};

const MIN_SCALE = 1;
const MAX_SCALE = 5;

function touchDistance(touches: Array<{ pageX: number; pageY: number }>): number {
  const [a, b] = touches;
  return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
}

// ScrollView's minimumZoomScale/maximumZoomScale are iOS-only, so pinch/pan is implemented
// by hand here with PanResponder. Single-finger drags only pan once zoomed in (scale > 1),
// so an unzoomed image still lets the swipe reach the pager's FlatList.
function ZoomablePhoto({ client, path, width, height }: ZoomablePhotoProps) {
  const [uri, setUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scale = useRef(new Animated.Value(1)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const gesture = useRef({
    scaleValue: 1,
    translateValue: { x: 0, y: 0 },
    startScale: 1,
    startTranslate: { x: 0, y: 0 },
    startDistance: 0,
  }).current;

  useEffect(() => {
    let cancelled = false;
    setUri(null);
    setError(null);
    getPhotoUri(client, path)
      .then((result) => {
        if (!cancelled) setUri(result);
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : 'Failed to load image');
      });
    return () => {
      cancelled = true;
    };
  }, [client, path]);

  const clampTranslate = useCallback((value: { x: number; y: number }, currentScale: number) => {
    const maxOffsetX = Math.max(0, (width * (currentScale - 1)) / 2);
    const maxOffsetY = Math.max(0, (height * (currentScale - 1)) / 2);
    return {
      x: Math.max(-maxOffsetX, Math.min(maxOffsetX, value.x)),
      y: Math.max(-maxOffsetY, Math.min(maxOffsetY, value.y)),
    };
  }, [width, height]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: (evt) => evt.nativeEvent.touches.length === 2,
      onMoveShouldSetPanResponder: (evt, gestureState) => {
        if (evt.nativeEvent.touches.length === 2) return true;
        return gesture.scaleValue > 1 && (Math.abs(gestureState.dx) > 2 || Math.abs(gestureState.dy) > 2);
      },
      onPanResponderGrant: (evt) => {
        gesture.startScale = gesture.scaleValue;
        gesture.startTranslate = gesture.translateValue;
        gesture.startDistance = evt.nativeEvent.touches.length === 2 ? touchDistance(evt.nativeEvent.touches) : 0;
      },
      onPanResponderMove: (evt, gestureState) => {
        const touches = evt.nativeEvent.touches;
        if (touches.length === 2) {
          if (!gesture.startDistance) gesture.startDistance = touchDistance(touches);
          const nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, gesture.startScale * (touchDistance(touches) / gesture.startDistance)));
          gesture.scaleValue = nextScale;
          scale.setValue(nextScale);
        } else if (touches.length === 1 && gesture.scaleValue > 1) {
          const next = clampTranslate(
            { x: gesture.startTranslate.x + gestureState.dx, y: gesture.startTranslate.y + gestureState.dy },
            gesture.scaleValue,
          );
          gesture.translateValue = next;
          translateX.setValue(next.x);
          translateY.setValue(next.y);
        }
      },
      onPanResponderRelease: () => {
        gesture.startDistance = 0;
        if (gesture.scaleValue <= 1) {
          gesture.scaleValue = 1;
          gesture.translateValue = { x: 0, y: 0 };
          Animated.parallel([
            Animated.timing(scale, { toValue: 1, duration: 150, useNativeDriver: true }),
            Animated.timing(translateX, { toValue: 0, duration: 150, useNativeDriver: true }),
            Animated.timing(translateY, { toValue: 0, duration: 150, useNativeDriver: true }),
          ]).start();
        }
      },
    }),
  ).current;

  return (
    <View style={[styles.viewerContent, { width, height, overflow: 'hidden' }]} {...panResponder.panHandlers}>
      {uri ? (
        <Animated.Image
          source={{ uri }}
          style={{ width, height, transform: [{ translateX }, { translateY }, { scale }] }}
          resizeMode="contain"
        />
      ) : error ? (
        <Text style={styles.error}>{error}</Text>
      ) : (
        <ActivityIndicator size="large" color="#fff" />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  headerButton: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  headerCounter: {
    color: '#e2e8f0',
    fontSize: 13,
  },
  viewerContent: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  error: {
    color: '#fca5a5',
    fontSize: 14,
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  infoPanel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(15, 23, 42, 0.9)',
    padding: 16,
    gap: 4,
  },
  infoTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 4,
  },
  infoRow: {
    color: '#e2e8f0',
    fontSize: 13,
  },
  peopleRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginTop: 8,
  },
  personChip: {
    alignItems: 'center',
    gap: 4,
    width: 64,
  },
  personChipText: {
    color: '#e2e8f0',
    fontSize: 11,
  },
});

