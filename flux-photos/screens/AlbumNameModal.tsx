import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

type Props = {
  visible: boolean;
  title: string;
  confirmLabel: string;
  initialName?: string;
  onCancel: () => void;
  onConfirm: (name: string) => void;
};

/** Small prompt used to create or rename an album (Alert.prompt is iOS-only). */
export default function AlbumNameModal({ visible, title, confirmLabel, initialName, onCancel, onConfirm }: Props) {
  const [name, setName] = useState('');

  useEffect(() => {
    if (visible) setName(initialName ?? '');
  }, [visible, initialName]);

  const trimmed = name.trim();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <KeyboardAvoidingView style={styles.overlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.card}>
          <Text style={styles.title}>{title}</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Album name"
            style={styles.input}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={() => {
              if (trimmed) onConfirm(trimmed);
            }}
          />
          <View style={styles.actions}>
            <Pressable onPress={onCancel} hitSlop={8}>
              <Text style={styles.cancel}>Cancel</Text>
            </Pressable>
            <Pressable onPress={() => trimmed && onConfirm(trimmed)} disabled={!trimmed} hitSlop={8}>
              <Text style={[styles.confirm, !trimmed && styles.disabled]}>{confirmLabel}</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 20,
    gap: 14,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
    color: '#0f172a',
  },
  input: {
    borderWidth: 1,
    borderColor: '#cbd5f5',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: '#0f172a',
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 20,
  },
  cancel: {
    fontSize: 15,
    color: '#475569',
  },
  confirm: {
    fontSize: 15,
    fontWeight: '700',
    color: '#2563eb',
  },
  disabled: {
    color: '#94a3b8',
  },
});
