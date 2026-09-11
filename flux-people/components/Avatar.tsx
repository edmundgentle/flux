import { Image, ImageStyle, StyleProp, StyleSheet, Text, View } from 'react-native';
import { ContactItem } from '../types/contact';
import { getAvatarBgColor, getInitials } from '../utils/contactUtils';

type Props = {
  contact: Partial<ContactItem>;
  size?: number;
  style?: StyleProp<ImageStyle>;
};

export default function Avatar({ contact, size = 48, style }: Props) {
  const initials = getInitials(contact);
  const bgColor = getAvatarBgColor(contact.displayName || contact.firstName || 'C');

  if (contact.avatarUrl) {
    return (
      <Image
        source={{ uri: contact.avatarUrl }}
        style={[
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: '#e2e8f0',
          },
          style,
        ]}
      />
    );
  }

  const fontSize = size * 0.42;

  return (
    <View
      style={[
        styles.container,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: bgColor,
        },
        style,
      ]}
    >
      <Text style={[styles.initials, { fontSize }]}>{initials}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  initials: {
    color: '#ffffff',
    fontWeight: '700',
  },
});
