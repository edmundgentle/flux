import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { ContactItem } from '../types/contact';
import { parseVCard, getDisplayName } from '../utils/contactUtils';

type Props = {
  visible: boolean;
  initialSharedContent?: string;
  onClose: () => void;
  onImport: (contactData: Partial<ContactItem> & { firstName: string }) => Promise<void>;
};

export default function ImportSharedContactModal({
  visible,
  initialSharedContent = '',
  onClose,
  onImport,
}: Props) {
  const insets = useSafeAreaInsets();
  const [inputText, setInputText] = useState(initialSharedContent);
  const [parsedPreview, setParsedPreview] = useState<Partial<ContactItem> | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setInputText(initialSharedContent);
    if (initialSharedContent) {
      handleParseText(initialSharedContent);
    } else {
      setParsedPreview(null);
    }
  }, [initialSharedContent, visible]);

  const handleParseText = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      setParsedPreview(null);
      return;
    }

    if (trimmed.startsWith('BEGIN:VCARD') || trimmed.includes('VCARD')) {
      const parsed = parseVCard(trimmed);
      setParsedPreview(parsed);
    } else if (trimmed.startsWith('{')) {
      setParsedPreview(null);
    } else {
      // Treat plain text line-by-line as basic details
      const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
      const name = lines[0] || 'Shared Contact';
      const parts = name.split(' ');
      const firstName = parts[0] || '';
      const surname = parts.slice(1).join(' ') || '';
      setParsedPreview({
        firstName,
        surname,
        lastName: surname,
        displayName: name,
        notes: lines.slice(1).join('\n'),
      });
    }
  };

  const handleSaveImport = async () => {
    if (!parsedPreview) {
      Alert.alert('No valid content', 'Please paste a valid vCard or contact text first.');
      return;
    }

    const firstName = (parsedPreview.firstName || parsedPreview.displayName || 'Shared Contact').trim();
    setBusy(true);
    try {
      await onImport({
        ...parsedPreview,
        id: undefined,
        path: undefined,
        firstName,
        displayName: getDisplayName({ ...parsedPreview, firstName }),
      });
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Import failed';
      Alert.alert('Import Error', msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.topBar}>
          <Pressable onPress={onClose} hitSlop={10} disabled={busy}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>

          <Text style={styles.modalTitle}>Import Shared Contact</Text>

          <Pressable onPress={handleSaveImport} hitSlop={10} disabled={busy || !parsedPreview}>
            {busy ? (
              <ActivityIndicator size="small" color="#2563eb" />
            ) : (
              <Text style={[styles.saveText, !parsedPreview && styles.saveTextDisabled]}>Import</Text>
            )}
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.scrollContent}>
          <View style={styles.infoBanner}>
            <Ionicons name="share-social-outline" size={24} color="#2563eb" style={{ marginRight: 10 }} />
            <Text style={styles.infoText}>
              Paste a shared vCard string or contact text received from external apps.
            </Text>
          </View>

          <Text style={styles.sectionTitle}>Shared Content / vCard Text</Text>
          <TextInput
            style={styles.textArea}
            multiline
            numberOfLines={6}
            placeholder="Paste BEGIN:VCARD ... END:VCARD or contact text here..."
            value={inputText}
            onChangeText={(val) => {
              setInputText(val);
              handleParseText(val);
            }}
            textAlignVertical="top"
          />

          {parsedPreview ? (
            <View style={styles.previewCard}>
              <Text style={styles.previewHeader}>Detected Contact Card</Text>

              <Text style={styles.previewName}>{getDisplayName(parsedPreview)}</Text>
              
              {parsedPreview.company || parsedPreview.jobTitle ? (
                <Text style={styles.previewSub}>
                  {[parsedPreview.jobTitle, parsedPreview.company].filter(Boolean).join(' • ')}
                </Text>
              ) : null}

              {parsedPreview.phones && parsedPreview.phones.length > 0 ? (
                <View style={styles.previewRow}>
                  <Ionicons name="call-outline" size={16} color="#64748b" />
                  <Text style={styles.previewRowText}>
                    {parsedPreview.phones.map((p) => `${p.label}: ${p.number}`).join(' | ')}
                  </Text>
                </View>
              ) : null}

              {parsedPreview.emails && parsedPreview.emails.length > 0 ? (
                <View style={styles.previewRow}>
                  <Ionicons name="mail-outline" size={16} color="#64748b" />
                  <Text style={styles.previewRowText}>
                    {parsedPreview.emails.map((e) => e.email).join(', ')}
                  </Text>
                </View>
              ) : null}

              {parsedPreview.socialProfiles && parsedPreview.socialProfiles.length > 0 ? (
                <View style={styles.previewRow}>
                  <Ionicons name="logo-twitter" size={16} color="#64748b" />
                  <Text style={styles.previewRowText}>
                    {parsedPreview.socialProfiles.map((s) => `${s.platform}: ${s.username}`).join(', ')}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    backgroundColor: '#ffffff',
  },
  cancelText: {
    fontSize: 16,
    color: '#64748b',
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#0f172a',
  },
  saveText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#2563eb',
  },
  saveTextDisabled: {
    color: '#cbd5e1',
  },
  scrollContent: {
    padding: 16,
  },
  infoBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#eff6ff',
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#bfdbfe',
  },
  infoText: {
    flex: 1,
    fontSize: 13,
    color: '#1e40af',
    lineHeight: 18,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#64748b',
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  textArea: {
    backgroundColor: '#ffffff',
    borderColor: '#cbd5e1',
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    fontSize: 14,
    color: '#0f172a',
    minHeight: 120,
    marginBottom: 16,
  },
  previewCard: {
    backgroundColor: '#ffffff',
    borderColor: '#e2e8f0',
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
  },
  previewHeader: {
    fontSize: 12,
    fontWeight: '700',
    color: '#2563eb',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  previewName: {
    fontSize: 18,
    fontWeight: '700',
    color: '#0f172a',
  },
  previewSub: {
    fontSize: 13,
    color: '#64748b',
    marginTop: 2,
  },
  previewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  previewRowText: {
    fontSize: 13,
    color: '#334155',
    flex: 1,
  },
});
