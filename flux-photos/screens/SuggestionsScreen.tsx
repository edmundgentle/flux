import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, BackHandler, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { FacePerson, FaceSuggestion, FluxClient } from '@flux-sdk/core';
import FaceAvatar from './FaceAvatar';

type Props = {
  client: FluxClient;
  onClose: () => void;
  onChanged: () => void;
};

function photoCount(person: FacePerson): string {
  return `${person.photo_count} ${person.photo_count === 1 ? 'photo' : 'photos'}`;
}

/** Works through "are these the same person?" suggestions one at a time. */
export default function SuggestionsScreen({ client, onClose, onChanged }: Props) {
  const insets = useSafeAreaInsets();
  const [suggestions, setSuggestions] = useState<FaceSuggestion[] | null>(null);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSuggestions(await client.getFaceSuggestions(50));
      setIndex(0);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load suggestions');
      setSuggestions((current) => current ?? []);
    }
  }, [client]);

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

  const current = suggestions?.[index];

  const answer = async (same: boolean) => {
    if (!current || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { person_a: a, person_b: b } = current;
      if (same) {
        // Keep the labelled person (the server puts it second), else the bigger group.
        const bIsTarget = b.name !== null || b.contact_id !== null || b.photo_count >= a.photo_count;
        const [target, source] = bIsTarget ? [b, a] : [a, b];
        await client.mergePeople(target.id, [source.id]);
        onChanged();
        // A merge moves the group's average face, so the remaining suggestions can change.
        await load();
      } else {
        await client.rejectFaceSuggestion(a.id, b.id);
        setIndex((value) => value + 1);
      }
    } catch (answerError) {
      setError(answerError instanceof Error ? answerError.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  };

  const question = current
    ? current.person_b.name
      ? `Is this ${current.person_b.name}?`
      : 'Are these the same person?'
    : '';

  return (
    <View style={styles.container}>
      <View style={[styles.appBar, { paddingTop: insets.top + 10 }]}>
        <Pressable onPress={onClose} hitSlop={12}>
          <Ionicons name="chevron-back" size={26} color="#0f172a" />
        </Pressable>
        <Text style={styles.appBarTitle}>Review people</Text>
        {suggestions && suggestions.length > 0 ? (
          <Text style={styles.counter}>{Math.min(index + 1, suggestions.length)} of {suggestions.length}</Text>
        ) : null}
      </View>

      <View style={styles.body}>
        {suggestions === null ? (
          <ActivityIndicator size="large" />
        ) : !current ? (
          <View style={styles.done}>
            <Ionicons name="checkmark-circle-outline" size={56} color="#16a34a" />
            <Text style={styles.doneText}>No more suggestions right now.</Text>
            <Pressable style={[styles.button, styles.primary]} onPress={onClose}>
              <Text style={styles.primaryText}>Done</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <Text style={styles.question}>{question}</Text>
            <View style={styles.pair}>
              {[current.person_a, current.person_b].map((person) => (
                <View key={person.id} style={styles.personCard}>
                  <FaceAvatar client={client} face={person.cover} size={128} />
                  <Text style={styles.personName} numberOfLines={1}>{person.name ?? 'Unnamed'}</Text>
                  <Text style={styles.personMeta}>{photoCount(person)}</Text>
                </View>
              ))}
            </View>
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <View style={styles.actions}>
              <Pressable style={[styles.button, styles.secondary]} onPress={() => void answer(false)} disabled={busy}>
                <Text style={styles.secondaryText}>No</Text>
              </Pressable>
              <Pressable style={[styles.button, styles.primary]} onPress={() => void answer(true)} disabled={busy}>
                <Text style={styles.primaryText}>Yes</Text>
              </Pressable>
            </View>
            <Pressable onPress={() => setIndex((value) => value + 1)} disabled={busy} hitSlop={8}>
              <Text style={styles.skip}>Not sure - skip</Text>
            </Pressable>
            {busy ? <ActivityIndicator style={styles.busy} /> : null}
          </>
        )}
      </View>
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
  counter: {
    fontSize: 13,
    color: '#64748b',
  },
  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 20,
  },
  question: {
    fontSize: 22,
    fontWeight: '700',
    color: '#0f172a',
    textAlign: 'center',
  },
  pair: {
    flexDirection: 'row',
    gap: 24,
  },
  personCard: {
    alignItems: 'center',
    gap: 6,
    width: 140,
  },
  personName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#0f172a',
  },
  personMeta: {
    fontSize: 12,
    color: '#64748b',
  },
  actions: {
    flexDirection: 'row',
    gap: 16,
  },
  button: {
    minWidth: 120,
    paddingVertical: 12,
    borderRadius: 999,
    alignItems: 'center',
  },
  primary: {
    backgroundColor: '#2563eb',
  },
  primaryText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  secondary: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#cbd5e1',
  },
  secondaryText: {
    color: '#0f172a',
    fontSize: 16,
    fontWeight: '700',
  },
  skip: {
    color: '#64748b',
    fontSize: 14,
  },
  busy: {
    marginTop: 8,
  },
  error: {
    color: '#b91c1c',
    fontSize: 13,
    textAlign: 'center',
  },
  done: {
    alignItems: 'center',
    gap: 16,
  },
  doneText: {
    fontSize: 16,
    color: '#334155',
  },
});
