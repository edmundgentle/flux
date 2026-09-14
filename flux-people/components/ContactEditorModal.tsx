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
import * as ImagePicker from 'expo-image-picker';
import {
  ContactItem,
  PhoneItem,
  EmailItem,
  AddressItem,
  SocialProfileItem,
  PhoneLabel,
  EmailLabel,
  AddressLabel,
  SocialPlatform,
} from '../types/contact';
import Avatar from './Avatar';

type Props = {
  visible: boolean;
  contact: ContactItem | null;
  onClose: () => void;
  onSave: (contactData: Partial<ContactItem> & { firstName: string }) => Promise<void>;
};

const SUGGESTED_TAGS = ['Work', 'Family', 'Friends', 'VIP'];
const PHONE_LABELS: PhoneLabel[] = ['Mobile', 'Work', 'Home', 'Main', 'Other'];
const EMAIL_LABELS: EmailLabel[] = ['Personal', 'Work', 'Other'];
const ADDRESS_LABELS: AddressLabel[] = ['Home', 'Work', 'Other'];
const SOCIAL_PLATFORMS: SocialPlatform[] = [
  'Twitter',
  'LinkedIn',
  'GitHub',
  'Instagram',
  'Facebook',
  'Telegram',
  'WhatsApp',
  'Website',
];

export default function ContactEditorModal({ visible, contact, onClose, onSave }: Props) {
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);

  const [firstName, setFirstName] = useState('');
  const [middleName, setMiddleName] = useState('');
  const [surname, setSurname] = useState('');
  const [company, setCompany] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [birthday, setBirthday] = useState('');
  const [notes, setNotes] = useState('');
  const [favorite, setFavorite] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [customTagInput, setCustomTagInput] = useState('');

  const [phones, setPhones] = useState<PhoneItem[]>([]);
  const [emails, setEmails] = useState<EmailItem[]>([]);
  const [socialProfiles, setSocialProfiles] = useState<SocialProfileItem[]>([]);
  const [addresses, setAddresses] = useState<AddressItem[]>([]);

  useEffect(() => {
    if (contact) {
      setFirstName(contact.firstName || '');
      setMiddleName(contact.middleName || '');
      setSurname(contact.surname || contact.lastName || '');
      setCompany(contact.company || '');
      setJobTitle(contact.jobTitle || '');
      setAvatarUrl(contact.avatarUrl || '');
      setBirthday(contact.birthday || '');
      setNotes(contact.notes || '');
      setFavorite(Boolean(contact.favorite));
      setTags(contact.tags || []);
      setPhones(contact.phones && contact.phones.length > 0 ? [...contact.phones] : [{ id: 'p_0', label: 'Mobile', number: '' }]);
      setEmails(contact.emails && contact.emails.length > 0 ? [...contact.emails] : [{ id: 'e_0', label: 'Personal', email: '' }]);
      setSocialProfiles(contact.socialProfiles ? [...contact.socialProfiles] : []);
      setAddresses(contact.addresses ? [...contact.addresses] : []);
    } else {
      setFirstName('');
      setMiddleName('');
      setSurname('');
      setCompany('');
      setJobTitle('');
      setAvatarUrl('');
      setBirthday('');
      setNotes('');
      setFavorite(false);
      setTags([]);
      setPhones([{ id: `p_${Date.now()}`, label: 'Mobile', number: '' }]);
      setEmails([{ id: `e_${Date.now()}`, label: 'Personal', email: '' }]);
      setSocialProfiles([]);
      setAddresses([]);
    }
  }, [contact, visible]);

  const handlePickPhoto = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission required', 'Please allow access to your photo library.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.7,
      allowsEditing: true,
      aspect: [1, 1],
      base64: true,
    });

    if (result.canceled || result.assets.length === 0) return;
    const asset = result.assets[0];

    if (asset.base64) {
      const mime = asset.mimeType || 'image/jpeg';
      setAvatarUrl(`data:${mime};base64,${asset.base64}`);
    } else if (asset.uri) {
      setAvatarUrl(asset.uri);
    }
  };

  // Phones
  const addPhone = () => {
    setPhones((prev) => [...prev, { id: `p_${Date.now()}`, label: 'Mobile', number: '' }]);
  };
  const updatePhone = (id: string, field: keyof PhoneItem, val: string) => {
    setPhones((prev) => prev.map((p) => (p.id === id ? { ...p, [field]: val } : p)));
  };
  const removePhone = (id: string) => {
    setPhones((prev) => prev.filter((p) => p.id !== id));
  };

  // Emails
  const addEmail = () => {
    setEmails((prev) => [...prev, { id: `e_${Date.now()}`, label: 'Personal', email: '' }]);
  };
  const updateEmail = (id: string, field: keyof EmailItem, val: string) => {
    setEmails((prev) => prev.map((e) => (e.id === id ? { ...e, [field]: val } : e)));
  };
  const removeEmail = (id: string) => {
    setEmails((prev) => prev.filter((e) => e.id !== id));
  };

  // Social Profiles
  const addSocialProfile = () => {
    setSocialProfiles((prev) => [
      ...prev,
      { id: `s_${Date.now()}`, platform: 'Twitter', username: '', url: '' },
    ]);
  };
  const updateSocialProfile = (id: string, field: keyof SocialProfileItem, val: string) => {
    setSocialProfiles((prev) => prev.map((s) => (s.id === id ? { ...s, [field]: val } : s)));
  };
  const removeSocialProfile = (id: string) => {
    setSocialProfiles((prev) => prev.filter((s) => s.id !== id));
  };

  // Addresses
  const addAddress = () => {
    setAddresses((prev) => [
      ...prev,
      { id: `a_${Date.now()}`, label: 'Home', street: '', city: '', state: '', zip: '', country: '' },
    ]);
  };
  const updateAddress = (id: string, field: keyof AddressItem, val: string) => {
    setAddresses((prev) => prev.map((a) => (a.id === id ? { ...a, [field]: val } : a)));
  };
  const removeAddress = (id: string) => {
    setAddresses((prev) => prev.filter((a) => a.id !== id));
  };

  // Tags
  const toggleTag = (tag: string) => {
    setTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  };
  const addCustomTag = () => {
    const trimmed = customTagInput.trim();
    if (trimmed && !tags.includes(trimmed)) {
      setTags((prev) => [...prev, trimmed]);
      setCustomTagInput('');
    }
  };

  const handleSave = async () => {
    if (!firstName.trim() && !surname.trim() && !company.trim()) {
      Alert.alert('Required field missing', 'Please enter a first name, surname, or company.');
      return;
    }

    setBusy(true);
    try {
      const cleanPhones = phones.filter((p) => p.number.trim());
      const cleanEmails = emails.filter((e) => e.email.trim());
      const cleanSocials = socialProfiles.filter((s) => s.username.trim() || (s.url && s.url.trim()));
      const cleanAddresses = addresses.filter(
        (a) => a.street.trim() || a.city.trim() || a.country.trim()
      );

      await onSave({
        id: contact?.id,
        path: contact?.path,
        firstName: firstName.trim(),
        middleName: middleName.trim(),
        surname: surname.trim(),
        lastName: surname.trim(),
        company: company.trim(),
        jobTitle: jobTitle.trim(),
        avatarUrl,
        birthday: birthday.trim(),
        notes: notes.trim(),
        favorite,
        tags,
        phones: cleanPhones,
        emails: cleanEmails,
        socialProfiles: cleanSocials,
        addresses: cleanAddresses,
        createdAt: contact?.createdAt || Date.now(),
      });
      onClose();
    } catch (saveErr) {
      const msg = saveErr instanceof Error ? saveErr.message : 'Save failed';
      Alert.alert('Save failed', msg);
    } finally {
      setBusy(false);
    }
  };

  const currentContactPreview = { firstName, middleName, surname, company, avatarUrl };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.container, { paddingTop: insets.top }]}>
        {/* Navigation Bar */}
        <View style={styles.topBar}>
          <Pressable onPress={onClose} disabled={busy} hitSlop={10}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>

          <Text style={styles.modalTitle}>{contact ? 'Edit Contact' : 'New Contact'}</Text>

          <Pressable onPress={handleSave} disabled={busy} hitSlop={10}>
            {busy ? (
              <ActivityIndicator size="small" color="#2563eb" />
            ) : (
              <Text style={styles.saveText}>Save</Text>
            )}
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.scrollContent}>
          {/* Top Section: Avatar & Name Information */}
          <View style={styles.avatarSection}>
            <Avatar contact={currentContactPreview} size={84} />
            <Pressable style={styles.photoPickerBtn} onPress={handlePickPhoto}>
              <Ionicons name="camera-outline" size={16} color="#2563eb" />
              <Text style={styles.photoPickerText}>
                {avatarUrl ? 'Change Photo' : 'Add Photo'}
              </Text>
            </Pressable>
          </View>

          <View style={styles.cardSection}>
            <View style={styles.sectionHeaderRow}>
              <Ionicons name="person-outline" size={16} color="#2563eb" />
              <Text style={styles.sectionHeader}>Name Details</Text>
            </View>
            <TextInput
              style={styles.input}
              placeholder="First name"
              value={firstName}
              onChangeText={setFirstName}
              autoCapitalize="words"
            />
            <View style={styles.inputDivider} />
            <TextInput
              style={styles.input}
              placeholder="Middle names"
              value={middleName}
              onChangeText={setMiddleName}
              autoCapitalize="words"
            />
            <View style={styles.inputDivider} />
            <TextInput
              style={styles.input}
              placeholder="Surname / Last name"
              value={surname}
              onChangeText={setSurname}
              autoCapitalize="words"
            />
          </View>

          {/* Birthday & Notes */}
          <View style={styles.cardSection}>
            <View style={styles.sectionHeaderRow}>
              <Ionicons name="calendar-outline" size={16} color="#2563eb" />
              <Text style={styles.sectionHeader}>Birthday & Notes</Text>
            </View>
            <TextInput
              style={styles.input}
              placeholder="Birthday (YYYY-MM-DD)"
              value={birthday}
              onChangeText={setBirthday}
            />
            <View style={styles.inputDivider} />
            <TextInput
              style={[styles.input, styles.textArea]}
              placeholder="Notes..."
              value={notes}
              onChangeText={setNotes}
              multiline
              numberOfLines={4}
              textAlignVertical="top"
            />
          </View>

          {/* Personal Information (Phones, Emails, Social Profiles) */}
          <View style={styles.cardSection}>
            <View style={styles.sectionHeaderRow}>
              <Ionicons name="call-outline" size={16} color="#2563eb" />
              <Text style={styles.sectionHeader}>Personal Contact Details</Text>
            </View>

            {/* Phone Numbers */}
            {phones.map((phone) => (
              <View key={phone.id} style={styles.dynamicRow}>
                <View style={styles.labelSelectorRow}>
                  {PHONE_LABELS.map((lbl) => (
                    <Pressable
                      key={lbl}
                      style={[styles.miniPill, phone.label === lbl && styles.miniPillActive]}
                      onPress={() => updatePhone(phone.id, 'label', lbl)}
                    >
                      <Text style={[styles.miniPillText, phone.label === lbl && styles.miniPillTextActive]}>
                        {lbl}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <View style={styles.rowInputWithDelete}>
                  <TextInput
                    style={[styles.input, { flex: 1 }]}
                    placeholder="Phone number"
                    value={phone.number}
                    onChangeText={(val) => updatePhone(phone.id, 'number', val)}
                    keyboardType="phone-pad"
                  />
                  {phones.length > 1 ? (
                    <Pressable onPress={() => removePhone(phone.id)} hitSlop={6}>
                      <Ionicons name="remove-circle-outline" size={22} color="#dc2626" />
                    </Pressable>
                  ) : null}
                </View>
              </View>
            ))}

            <Pressable style={styles.addMoreBtn} onPress={addPhone}>
              <Ionicons name="add-circle-outline" size={20} color="#2563eb" />
              <Text style={styles.addMoreText}>Add Phone</Text>
            </Pressable>

            <View style={styles.sectionDivider} />

            {/* Email Addresses */}
            <Text style={styles.subSectionHeader}>Email Addresses</Text>
            {emails.map((email) => (
              <View key={email.id} style={styles.dynamicRow}>
                <View style={styles.labelSelectorRow}>
                  {EMAIL_LABELS.map((lbl) => (
                    <Pressable
                      key={lbl}
                      style={[styles.miniPill, email.label === lbl && styles.miniPillActive]}
                      onPress={() => updateEmail(email.id, 'label', lbl)}
                    >
                      <Text style={[styles.miniPillText, email.label === lbl && styles.miniPillTextActive]}>
                        {lbl}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <View style={styles.rowInputWithDelete}>
                  <TextInput
                    style={[styles.input, { flex: 1 }]}
                    placeholder="Email address"
                    value={email.email}
                    onChangeText={(val) => updateEmail(email.id, 'email', val)}
                    keyboardType="email-address"
                    autoCapitalize="none"
                  />
                  {emails.length > 1 ? (
                    <Pressable onPress={() => removeEmail(email.id)} hitSlop={6}>
                      <Ionicons name="remove-circle-outline" size={22} color="#dc2626" />
                    </Pressable>
                  ) : null}
                </View>
              </View>
            ))}

            <Pressable style={styles.addMoreBtn} onPress={addEmail}>
              <Ionicons name="add-circle-outline" size={20} color="#2563eb" />
              <Text style={styles.addMoreText}>Add Email</Text>
            </Pressable>

            <View style={styles.sectionDivider} />

            {/* Social Profiles */}
            <Text style={styles.subSectionHeader}>Social Profiles</Text>
            {socialProfiles.map((social) => (
              <View key={social.id} style={styles.dynamicRow}>
                <View style={styles.labelSelectorRow}>
                  {SOCIAL_PLATFORMS.map((plat) => (
                    <Pressable
                      key={plat}
                      style={[styles.miniPill, social.platform === plat && styles.miniPillActive]}
                      onPress={() => updateSocialProfile(social.id, 'platform', plat)}
                    >
                      <Text style={[styles.miniPillText, social.platform === plat && styles.miniPillTextActive]}>
                        {plat}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <View style={styles.rowInputWithDelete}>
                  <TextInput
                    style={[styles.input, { flex: 1 }]}
                    placeholder="Username / Handle (e.g. @john_doe)"
                    value={social.username}
                    onChangeText={(val) => updateSocialProfile(social.id, 'username', val)}
                    autoCapitalize="none"
                  />
                  <Pressable onPress={() => removeSocialProfile(social.id)} hitSlop={6}>
                    <Ionicons name="remove-circle-outline" size={22} color="#dc2626" />
                  </Pressable>
                </View>
              </View>
            ))}

            <Pressable style={styles.addMoreBtn} onPress={addSocialProfile}>
              <Ionicons name="logo-twitter" size={18} color="#2563eb" />
              <Text style={styles.addMoreText}>Add Social Profile</Text>
            </Pressable>
          </View>

          {/* Work Section */}
          <View style={styles.cardSection}>
            <View style={styles.sectionHeaderRow}>
              <Ionicons name="briefcase-outline" size={16} color="#2563eb" />
              <Text style={styles.sectionHeader}>Work Information</Text>
            </View>
            <TextInput
              style={styles.input}
              placeholder="Company / Organization"
              value={company}
              onChangeText={setCompany}
              autoCapitalize="words"
            />
            <View style={styles.inputDivider} />
            <TextInput
              style={styles.input}
              placeholder="Job Title"
              value={jobTitle}
              onChangeText={setJobTitle}
              autoCapitalize="words"
            />
          </View>

          {/* Addresses */}
          <View style={styles.cardSection}>
            <View style={styles.sectionHeaderRow}>
              <Ionicons name="location-outline" size={16} color="#2563eb" />
              <Text style={styles.sectionHeader}>Addresses</Text>
            </View>
            {addresses.map((addr) => (
              <View key={addr.id} style={styles.dynamicRow}>
                <View style={styles.labelSelectorRow}>
                  {ADDRESS_LABELS.map((lbl) => (
                    <Pressable
                      key={lbl}
                      style={[styles.miniPill, addr.label === lbl && styles.miniPillActive]}
                      onPress={() => updateAddress(addr.id, 'label', lbl)}
                    >
                      <Text style={[styles.miniPillText, addr.label === lbl && styles.miniPillTextActive]}>
                        {lbl}
                      </Text>
                    </Pressable>
                  ))}
                  <Pressable onPress={() => removeAddress(addr.id)} hitSlop={6} style={{ marginLeft: 'auto' }}>
                    <Ionicons name="remove-circle-outline" size={22} color="#dc2626" />
                  </Pressable>
                </View>

                <TextInput
                  style={styles.input}
                  placeholder="Street"
                  value={addr.street}
                  onChangeText={(val) => updateAddress(addr.id, 'street', val)}
                />
                <View style={styles.inputDivider} />
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TextInput
                    style={[styles.input, { flex: 1 }]}
                    placeholder="City"
                    value={addr.city}
                    onChangeText={(val) => updateAddress(addr.id, 'city', val)}
                  />
                  <TextInput
                    style={[styles.input, { flex: 1 }]}
                    placeholder="State"
                    value={addr.state}
                    onChangeText={(val) => updateAddress(addr.id, 'state', val)}
                  />
                </View>
                <View style={styles.inputDivider} />
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TextInput
                    style={[styles.input, { flex: 1 }]}
                    placeholder="ZIP / Postal Code"
                    value={addr.zip}
                    onChangeText={(val) => updateAddress(addr.id, 'zip', val)}
                  />
                  <TextInput
                    style={[styles.input, { flex: 1 }]}
                    placeholder="Country"
                    value={addr.country}
                    onChangeText={(val) => updateAddress(addr.id, 'country', val)}
                  />
                </View>
              </View>
            ))}

            <Pressable style={styles.addMoreBtn} onPress={addAddress}>
              <Ionicons name="add-circle-outline" size={20} color="#2563eb" />
              <Text style={styles.addMoreText}>Add Address</Text>
            </Pressable>
          </View>

          {/* Tags / Groups */}
          <View style={styles.cardSection}>
            <Text style={styles.sectionHeader}>Groups & Tags</Text>
            <View style={styles.tagsContainer}>
              {SUGGESTED_TAGS.map((t) => {
                const active = tags.includes(t);
                return (
                  <Pressable
                    key={t}
                    style={[styles.tagPill, active && styles.tagPillActive]}
                    onPress={() => toggleTag(t)}
                  >
                    <Text style={[styles.tagPillText, active && styles.tagPillTextActive]}>{t}</Text>
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.customTagRow}>
              <TextInput
                style={[styles.input, { flex: 1 }]}
                placeholder="Add custom tag..."
                value={customTagInput}
                onChangeText={setCustomTagInput}
                onSubmitEditing={addCustomTag}
              />
              <Pressable style={styles.addTagBtn} onPress={addCustomTag}>
                <Text style={styles.addTagBtnText}>Add</Text>
              </Pressable>
            </View>

            {tags.length > 0 ? (
              <View style={styles.activeTagsList}>
                {tags.map((t) => (
                  <View key={t} style={styles.activeTagBadge}>
                    <Text style={styles.activeTagText}>{t}</Text>
                    <Pressable onPress={() => toggleTag(t)} hitSlop={4}>
                      <Ionicons name="close-circle" size={16} color="#64748b" />
                    </Pressable>
                  </View>
                ))}
              </View>
            ) : null}
          </View>

          {/* Favorite Toggle */}
          <Pressable
            style={styles.favoriteRow}
            onPress={() => setFavorite(!favorite)}
          >
            <Ionicons
              name={favorite ? 'star' : 'star-outline'}
              size={22}
              color={favorite ? '#eab308' : '#64748b'}
            />
            <Text style={styles.favoriteText}>
              {favorite ? 'Favorite Contact' : 'Add to Favorites'}
            </Text>
          </Pressable>
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
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
  },
  avatarSection: {
    alignItems: 'center',
    marginBottom: 20,
  },
  photoPickerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
    backgroundColor: '#eff6ff',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  photoPickerText: {
    color: '#2563eb',
    fontSize: 13,
    fontWeight: '600',
  },
  cardSection: {
    backgroundColor: '#ffffff',
    borderRadius: 14,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 10,
  },
  sectionHeader: {
    fontSize: 13,
    fontWeight: '700',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  subSectionHeader: {
    fontSize: 12,
    fontWeight: '700',
    color: '#475569',
    marginTop: 8,
    marginBottom: 6,
  },
  sectionDivider: {
    height: 1,
    backgroundColor: '#e2e8f0',
    marginVertical: 12,
  },
  input: {
    fontSize: 15,
    color: '#0f172a',
    paddingVertical: 8,
  },
  inputDivider: {
    height: 1,
    backgroundColor: '#f1f5f9',
    marginVertical: 4,
  },
  textArea: {
    minHeight: 80,
  },
  dynamicRow: {
    marginBottom: 12,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  labelSelectorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 6,
  },
  miniPill: {
    backgroundColor: '#f1f5f9',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  miniPillActive: {
    backgroundColor: '#dbeafe',
  },
  miniPillText: {
    fontSize: 11,
    color: '#64748b',
    fontWeight: '500',
  },
  miniPillTextActive: {
    color: '#2563eb',
    fontWeight: '700',
  },
  rowInputWithDelete: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  addMoreBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
  },
  addMoreText: {
    fontSize: 14,
    color: '#2563eb',
    fontWeight: '600',
  },
  tagsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 10,
  },
  tagPill: {
    backgroundColor: '#f1f5f9',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  tagPillActive: {
    backgroundColor: '#2563eb',
  },
  tagPillText: {
    fontSize: 13,
    color: '#475569',
    fontWeight: '500',
  },
  tagPillTextActive: {
    color: '#ffffff',
    fontWeight: '600',
  },
  customTagRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
  },
  addTagBtn: {
    backgroundColor: '#eff6ff',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  addTagBtnText: {
    color: '#2563eb',
    fontWeight: '600',
    fontSize: 13,
  },
  activeTagsList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 10,
  },
  activeTagBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#e2e8f0',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  activeTagText: {
    fontSize: 12,
    color: '#1e293b',
  },
  favoriteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#ffffff',
    paddingVertical: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  favoriteText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#0f172a',
  },
});

