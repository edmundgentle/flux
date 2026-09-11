import React from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ContactItem } from '../types/contact';
import Avatar from './Avatar';

type Props = {
  contact: ContactItem;
  onPress: () => void;
  onToggleFavorite: () => void;
};

export default function ContactCard({ contact, onPress, onToggleFavorite }: Props) {
  const primaryPhone = contact.phones[0]?.number;
  const primaryEmail = contact.emails[0]?.email;
  const subText = contact.company || contact.jobTitle || primaryPhone || primaryEmail || '';

  const callPrimaryPhone = (e: any) => {
    e.stopPropagation();
    if (primaryPhone) {
      void Linking.openURL(`tel:${primaryPhone.replace(/\s+/g, '')}`);
    }
  };

  const emailPrimaryAddress = (e: any) => {
    e.stopPropagation();
    if (primaryEmail) {
      void Linking.openURL(`mailto:${primaryEmail}`);
    }
  };

  const handleFavoritePress = (e: any) => {
    e.stopPropagation();
    onToggleFavorite();
  };

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
      onPress={onPress}
    >
      <Avatar contact={contact} size={46} />

      <View style={styles.info}>
        <View style={styles.nameRow}>
          <Text style={styles.name} numberOfLines={1}>
            {contact.displayName}
          </Text>
        </View>

        {subText ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {subText}
          </Text>
        ) : null}
      </View>

      <View style={styles.actions}>
        {primaryPhone ? (
          <Pressable style={styles.actionBtn} onPress={callPrimaryPhone} hitSlop={6}>
            <Ionicons name="call-outline" size={18} color="#2563eb" />
          </Pressable>
        ) : null}

        {primaryEmail ? (
          <Pressable style={styles.actionBtn} onPress={emailPrimaryAddress} hitSlop={6}>
            <Ionicons name="mail-outline" size={18} color="#2563eb" />
          </Pressable>
        ) : null}

        <Pressable style={styles.actionBtn} onPress={handleFavoritePress} hitSlop={6}>
          <Ionicons
            name={contact.favorite ? 'star' : 'star-outline'}
            size={20}
            color={contact.favorite ? '#eab308' : '#cbd5e1'}
          />
        </Pressable>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ffffff',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    shadowColor: '#0f172a',
    shadowOpacity: 0.04,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  pressed: {
    backgroundColor: '#f8fafc',
    opacity: 0.9,
  },
  info: {
    flex: 1,
    marginLeft: 12,
    marginRight: 8,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  name: {
    fontSize: 16,
    fontWeight: '600',
    color: '#0f172a',
  },
  subtitle: {
    fontSize: 13,
    color: '#64748b',
    marginTop: 2,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  actionBtn: {
    padding: 6,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
  },
});
