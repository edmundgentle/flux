import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { FaceContact, FaceLabel, FaceRef, FluxClient } from '@flux-sdk/core';
import FaceAvatar from './FaceAvatar';

type Props = {
  client: FluxClient;
  visible: boolean;
  personId: string | null;
  currentName: string | null;
  face?: FaceRef | null;
  onClose: () => void;
  /** Receives the id of the person that now carries the label. */
  onLabelled: (personId: string) => void;
};

/** Names a person, either by picking one of the user's flux-people contacts or typing a name. */
export default function LabelPersonModal({ client, visible, personId, currentName, face, onClose, onLabelled }: Props) {
  const [text, setText] = useState('');
  const [contacts, setContacts] = useState<FaceContact[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setText(currentName ?? '');
    setError(null);
    let cancelled = false;
    client.listFaceContacts()
      .then((result) => {
        if (!cancelled) setContacts(result);
      })
      .catch(() => {
        if (!cancelled) setContacts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, client, currentName]);

  const trimmed = text.trim();
  const matches = useMemo(() => {
    const query = trimmed.toLowerCase();
    const list = contacts ?? [];
    return (query ? list.filter((contact) => contact.name.toLowerCase().includes(query)) : list).slice(0, 50);
  }, [contacts, trimmed]);
  const exactContactMatch = matches.some((contact) => contact.name.toLowerCase() === trimmed.toLowerCase());

  const save = async (label: FaceLabel) => {
    if (!personId || saving) return;
    setSaving(true);
    setError(null);
    try {
      onLabelled(await client.labelPerson(personId, label));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save the name');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.overlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>Who is this?</Text>
            <Pressable onPress={onClose} hitSlop={12}>
              <Text style={styles.cancel}>Cancel</Text>
            </Pressable>
          </View>

          {face ? <FaceAvatar client={client} face={face} size={72} style={styles.avatar} /> : null}

          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Type a name or search contacts"
            style={styles.input}
            autoFocus
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={() => {
              if (trimmed) void save({ name: trimmed });
            }}
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {saving ? <ActivityIndicator style={styles.saving} /> : null}

          <FlatList
            style={styles.list}
            data={matches}
            keyExtractor={(contact) => contact.id}
            keyboardShouldPersistTaps="handled"
            ListHeaderComponent={
              trimmed && !exactContactMatch ? (
                <Pressable style={styles.row} onPress={() => void save({ name: trimmed })} disabled={saving}>
                  <Ionicons name="pricetag-outline" size={22} color="#2563eb" />
                  <Text style={styles.rowText}>Use “{trimmed}”</Text>
                </Pressable>
              ) : null
            }
            renderItem={({ item }) => (
              <Pressable style={styles.row} onPress={() => void save({ name: item.name, contactId: item.id })} disabled={saving}>
                <Ionicons name="person-circle-outline" size={22} color="#475569" />
                <Text style={styles.rowText}>{item.name}</Text>
                <Text style={styles.rowMeta}>Contact</Text>
              </Pressable>
            )}
            ListEmptyComponent={
              contacts === null ? (
                <ActivityIndicator style={styles.saving} />
              ) : (
                <Text style={styles.empty}>{trimmed ? 'No matching contacts.' : 'No contacts yet.'}</Text>
              )
            }
            ListFooterComponent={
              currentName ? (
                <Pressable style={styles.row} onPress={() => void save({ name: null, contactId: null })} disabled={saving}>
                  <Ionicons name="close-circle-outline" size={22} color="#dc2626" />
                  <Text style={[styles.rowText, styles.danger]}>Remove name</Text>
                </Pressable>
              ) : null
            }
          />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(15, 23, 42, 0.4)',
  },
  sheet: {
    maxHeight: '85%',
    minHeight: '60%',
    backgroundColor: '#fff',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: '#0f172a',
  },
  cancel: {
    fontSize: 15,
    color: '#2563eb',
    fontWeight: '600',
  },
  avatar: {
    alignSelf: 'center',
    marginBottom: 12,
  },
  input: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#fff',
    marginBottom: 8,
  },
  error: {
    color: '#b91c1c',
    fontSize: 12,
    marginBottom: 8,
  },
  saving: {
    marginVertical: 8,
  },
  list: {
    flex: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  rowText: {
    flex: 1,
    fontSize: 15,
    color: '#0f172a',
  },
  rowMeta: {
    fontSize: 12,
    color: '#94a3b8',
  },
  danger: {
    color: '#dc2626',
  },
  empty: {
    color: '#64748b',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 16,
  },
});
