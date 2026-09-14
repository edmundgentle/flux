import React from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';

type Props = {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
  align?: 'left' | 'right';
};

// Lightweight popover: dims the background and drops a floating card under the
// header toolbar, so color/formatting controls don't have to stay on-screen.
export default function Popover({ visible, onClose, children, align = 'right' }: Props) {
  if (!visible) return null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <View style={styles.anchor} pointerEvents="box-none">
          <Pressable
            style={[styles.card, align === 'left' ? styles.alignLeft : styles.alignRight]}
            onPress={(e) => e.stopPropagation()}
          >
            {children}
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.15)',
  },
  anchor: {
    flex: 1,
    paddingTop: 90,
    paddingHorizontal: 16,
  },
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 12,
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 16,
    elevation: 8,
    maxWidth: '92%',
  },
  alignRight: {
    alignSelf: 'flex-end',
  },
  alignLeft: {
    alignSelf: 'flex-start',
  },
});
