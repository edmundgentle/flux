import React, { useState } from 'react';
import { Image, ImageStyle, StyleProp } from 'react-native';

type Props = {
  uri: string;
  style?: StyleProp<ImageStyle>;
};

export default function AspectRatioImage({ uri, style }: Props) {
  const [aspectRatio, setAspectRatio] = useState(1);

  return (
    <Image
      source={{ uri }}
      style={[{ width: '100%', aspectRatio }, style]}
      resizeMode="contain"
      onLoad={({ nativeEvent }) => {
        const { width, height } = nativeEvent.source;
        if (width > 0 && height > 0) {
          setAspectRatio(width / height);
        }
      }}
    />
  );
}