import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, ImageStyle, StyleProp, StyleSheet, View } from 'react-native';
import { FluxClient } from '@flux-sdk/core';
import { getPhotoUri } from './photoImage';

type Props = {
  client: FluxClient;
  path: string;
  style?: StyleProp<ImageStyle>;
};

export default function PhotoThumbnail({ client, path, style }: Props) {
  const [uri, setUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setUri(null);
    setFailed(false);
    getPhotoUri(client, path)
      .then((result) => {
        if (!cancelled) setUri(result);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [client, path]);

  if (uri) {
    return <Image source={{ uri }} style={style} resizeMode="cover" />;
  }

  return (
    <View style={[styles.placeholder, style]}>
      {!failed ? <ActivityIndicator size="small" color="#94a3b8" /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  placeholder: {
    backgroundColor: '#e2e8f0',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
