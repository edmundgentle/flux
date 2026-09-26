import { useEffect, useState } from 'react';
import { Image, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { FaceRef, FluxClient } from '@flux-sdk/core';
import { getPhotoUri } from './photoImage';

type Props = {
  client: FluxClient;
  face: FaceRef | null | undefined;
  size: number;
  style?: StyleProp<ViewStyle>;
};

// Show a little hair/chin around the detected box, which is tight to the face.
const FACE_MARGIN = 1.5;

/** Circular crop of a face, rendered by positioning the full (cached) photo behind a mask. */
export default function FaceAvatar({ client, face, size, style }: Props) {
  const [uri, setUri] = useState<string | null>(null);
  const path = face?.path;

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setUri(null);
    getPhotoUri(client, path)
      .then((result) => {
        if (!cancelled) setUri(result);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, path]);

  const frame = { width: size, height: size, borderRadius: size / 2 };

  if (!face || !uri || !face.image_width || !face.image_height) {
    return (
      <View style={[styles.frame, styles.placeholder, frame, style]}>
        <Ionicons name="person" size={size * 0.5} color="#94a3b8" />
      </View>
    );
  }

  const { box, image_width: imageWidth, image_height: imageHeight } = face;
  const side = Math.max(box.width * imageWidth, box.height * imageHeight) * FACE_MARGIN;
  const scale = size / side;
  const centerX = (box.x + box.width / 2) * imageWidth;
  const centerY = (box.y + box.height / 2) * imageHeight;

  return (
    <View style={[styles.frame, frame, style]}>
      <Image
        source={{ uri }}
        resizeMode="stretch"
        style={{
          position: 'absolute',
          width: imageWidth * scale,
          height: imageHeight * scale,
          left: size / 2 - centerX * scale,
          top: size / 2 - centerY * scale,
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    overflow: 'hidden',
    backgroundColor: '#e2e8f0',
  },
  placeholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
