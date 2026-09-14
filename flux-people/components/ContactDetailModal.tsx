import React from 'react';
import {
  Alert,
  Linking,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { ContactItem, PhoneItem, EmailItem, AddressItem, SocialProfileItem } from '../types/contact';
import { generateVCard, openPhoneDeepLink, openSocialDeepLink } from '../utils/contactUtils';
import Avatar from './Avatar';

type Props = {
  contact: ContactItem | null;
  visible: boolean;
  onClose: () => void;
  onEdit: (contact: ContactItem) => void;
  onDelete: (contact: ContactItem) => void;
  onToggleFavorite: (contact: ContactItem) => void;
};

function getSocialIconName(platform: string): keyof typeof Ionicons.glyphMap {
  const p = platform.toLowerCase();
  if (p === 'twitter' || p === 'x') return 'logo-twitter';
  if (p === 'linkedin') return 'logo-linkedin';
  if (p === 'github') return 'logo-github';
  if (p === 'instagram') return 'logo-instagram';
  if (p === 'facebook') return 'logo-facebook';
  if (p === 'whatsapp') return 'logo-whatsapp';
  if (p === 'telegram') return 'paper-plane-outline';
  return 'globe-outline';
}

export default function ContactDetailModal({
  contact,
  visible,
  onClose,
  onEdit,
  onDelete,
  onToggleFavorite,
}: Props) {
  const insets = useSafeAreaInsets();

  if (!contact) return null;

  const firstPhone = contact.phones?.[0]?.number;
  const firstEmail = contact.emails?.[0]?.email;

  // Split phones into Personal (Mobile, Home, Main, etc.) and Work
  const personalPhones = (contact.phones || []).filter((p) => p.label.toLowerCase() !== 'work');
  const workPhones = (contact.phones || []).filter((p) => p.label.toLowerCase() === 'work');

  // Split emails into Personal and Work
  const personalEmails = (contact.emails || []).filter((e) => e.label.toLowerCase() !== 'work');
  const workEmails = (contact.emails || []).filter((e) => e.label.toLowerCase() === 'work');

  // Split addresses
  const personalAddresses = (contact.addresses || []).filter((a) => a.label.toLowerCase() !== 'work');
  const workAddresses = (contact.addresses || []).filter((a) => a.label.toLowerCase() === 'work');

  const socialProfiles = contact.socialProfiles || [];
  const hasWorkSection = Boolean(contact.company || contact.jobTitle || workPhones.length > 0 || workEmails.length > 0 || workAddresses.length > 0);
  const hasPersonalSection = Boolean(personalPhones.length > 0 || personalEmails.length > 0 || socialProfiles.length > 0 || personalAddresses.length > 0);

  const handleCall = (phoneNum: string) => {
    void openPhoneDeepLink(phoneNum, 'call');
  };

  const handleSms = (phoneNum: string) => {
    void openPhoneDeepLink(phoneNum, 'sms');
  };

  const handleEmail = (emailAddr: string) => {
    void Linking.openURL(`mailto:${emailAddr}`);
  };

  const handleMap = (addr: AddressItem) => {
    const full = `${addr.street}, ${addr.city}, ${addr.state} ${addr.zip}, ${addr.country}`;
    const query = encodeURIComponent(full);
    void Linking.openURL(`https://maps.apple.com/?q=${query}`);
  };

  const handleNativeShare = async () => {
    const vcard = generateVCard(contact);
    try {
      await Share.share({
        title: contact.displayName,
        message: `${contact.displayName}\n\n${vcard}`,
      });
    } catch {
      Alert.alert('Share', vcard);
    }
  };

  const confirmDelete = () => {
    Alert.alert(
      'Delete Contact',
      `Are you sure you want to delete ${contact.displayName}? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            onDelete(contact);
            onClose();
          },
        },
      ]
    );
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.container, { paddingTop: insets.top }]}>
        {/* Header Bar */}
        <View style={styles.topBar}>
          <Pressable onPress={onClose} style={styles.topBarBtn} hitSlop={10}>
            <Ionicons name="close-outline" size={26} color="#0f172a" />
          </Pressable>

          <View style={styles.topBarRight}>
            <Pressable
              onPress={() => onToggleFavorite(contact)}
              style={styles.topBarBtn}
              hitSlop={10}
            >
              <Ionicons
                name={contact.favorite ? 'star' : 'star-outline'}
                size={24}
                color={contact.favorite ? '#eab308' : '#64748b'}
              />
            </Pressable>

            <Pressable
              onPress={() => {
                onClose();
                onEdit(contact);
              }}
              style={styles.topBarBtn}
              hitSlop={10}
            >
              <Ionicons name="create-outline" size={24} color="#2563eb" />
            </Pressable>
          </View>
        </View>

        <ScrollView contentContainerStyle={styles.scrollContent}>
          {/* Top Section: Picture, Names, Notes, Birthday */}
          <View style={styles.profileHeader}>
            <Avatar contact={contact} size={90} />
            <Text style={styles.displayName}>{contact.displayName}</Text>

            {/* Individual Name Breakdown */}
            {(contact.firstName || contact.middleName || contact.surname) ? (
              <View style={styles.nameBreakdown}>
                {contact.firstName ? <Text style={styles.namePartLabel}>First: <Text style={styles.namePartValue}>{contact.firstName}</Text></Text> : null}
                {contact.middleName ? <Text style={styles.namePartLabel}>Middle: <Text style={styles.namePartValue}>{contact.middleName}</Text></Text> : null}
                {contact.surname ? <Text style={styles.namePartLabel}>Surname: <Text style={styles.namePartValue}>{contact.surname}</Text></Text> : null}
              </View>
            ) : null}

            {/* Quick Action Buttons */}
            <View style={styles.quickActions}>
              <Pressable
                style={[styles.quickBtn, !firstPhone && styles.quickBtnDisabled]}
                disabled={!firstPhone}
                onPress={() => firstPhone && handleCall(firstPhone)}
              >
                <Ionicons name="call" size={20} color={firstPhone ? '#2563eb' : '#cbd5e1'} />
                <Text style={[styles.quickBtnLabel, !firstPhone && styles.quickBtnLabelDisabled]}>
                  Call
                </Text>
              </Pressable>

              <Pressable
                style={[styles.quickBtn, !firstPhone && styles.quickBtnDisabled]}
                disabled={!firstPhone}
                onPress={() => firstPhone && handleSms(firstPhone)}
              >
                <Ionicons name="chatbubble" size={20} color={firstPhone ? '#2563eb' : '#cbd5e1'} />
                <Text style={[styles.quickBtnLabel, !firstPhone && styles.quickBtnLabelDisabled]}>
                  Message
                </Text>
              </Pressable>

              <Pressable
                style={[styles.quickBtn, !firstEmail && styles.quickBtnDisabled]}
                disabled={!firstEmail}
                onPress={() => firstEmail && handleEmail(firstEmail)}
              >
                <Ionicons name="mail" size={20} color={firstEmail ? '#2563eb' : '#cbd5e1'} />
                <Text style={[styles.quickBtnLabel, !firstEmail && styles.quickBtnLabelDisabled]}>
                  Email
                </Text>
              </Pressable>

              <Pressable style={styles.quickBtn} onPress={handleNativeShare}>
                <Ionicons name="share-social" size={20} color="#2563eb" />
                <Text style={styles.quickBtnLabel}>Share</Text>
              </Pressable>
            </View>
          </View>

          {/* Birthday & Notes in Top Context Section */}
          {contact.birthday || contact.notes ? (
            <View style={styles.cardSection}>
              <Text style={styles.sectionHeader}>About</Text>
              {contact.birthday ? (
                <View style={styles.itemRow}>
                  <Ionicons name="calendar-outline" size={18} color="#2563eb" style={{ marginRight: 10 }} />
                  <View style={styles.itemMain}>
                    <Text style={styles.itemLabel}>Birthday</Text>
                    <Text style={styles.itemValue}>{contact.birthday}</Text>
                  </View>
                </View>
              ) : null}

              {contact.notes ? (
                <View style={[styles.itemRow, { borderBottomWidth: 0, marginTop: 4 }]}>
                  <Ionicons name="document-text-outline" size={18} color="#2563eb" style={{ marginRight: 10, marginTop: 2 }} />
                  <View style={styles.itemMain}>
                    <Text style={styles.itemLabel}>Notes</Text>
                    <Text style={styles.notesText}>{contact.notes}</Text>
                  </View>
                </View>
              ) : null}
            </View>
          ) : null}

          {/* Tags */}
          {contact.tags && contact.tags.length > 0 ? (
            <View style={styles.tagsRow}>
              {contact.tags.map((tag) => (
                <View key={tag} style={styles.tagBadge}>
                  <Ionicons name="pricetag-outline" size={12} color="#475569" />
                  <Text style={styles.tagText}>{tag}</Text>
                </View>
              ))}
            </View>
          ) : null}

          {/* Personal Context Section */}
          {hasPersonalSection ? (
            <View style={styles.cardSection}>
              <View style={styles.sectionHeaderRow}>
                <Ionicons name="person-outline" size={16} color="#2563eb" />
                <Text style={styles.sectionHeader}>Personal Information</Text>
              </View>

              {/* Personal Phones */}
              {personalPhones.map((phone: PhoneItem) => (
                <View key={phone.id} style={styles.itemRow}>
                  <View style={styles.itemMain}>
                    <Text style={styles.itemLabel}>{phone.label}</Text>
                    <Text style={styles.itemValue}>{phone.number}</Text>
                  </View>
                  <View style={styles.itemActions}>
                    <Pressable style={styles.iconBtn} onPress={() => handleCall(phone.number)} hitSlop={6}>
                      <Ionicons name="call-outline" size={20} color="#2563eb" />
                    </Pressable>
                    <Pressable style={styles.iconBtn} onPress={() => handleSms(phone.number)} hitSlop={6}>
                      <Ionicons name="chatbubble-outline" size={20} color="#2563eb" />
                    </Pressable>
                  </View>
                </View>
              ))}

              {/* Personal Emails */}
              {personalEmails.map((email: EmailItem) => (
                <View key={email.id} style={styles.itemRow}>
                  <View style={styles.itemMain}>
                    <Text style={styles.itemLabel}>{email.label}</Text>
                    <Text style={styles.itemValue}>{email.email}</Text>
                  </View>
                  <Pressable style={styles.iconBtn} onPress={() => handleEmail(email.email)} hitSlop={6}>
                    <Ionicons name="mail-outline" size={20} color="#2563eb" />
                  </Pressable>
                </View>
              ))}

              {/* Social Profiles with Deep Linking */}
              {socialProfiles.map((social: SocialProfileItem) => (
                <View key={social.id} style={styles.itemRow}>
                  <Ionicons name={getSocialIconName(social.platform)} size={20} color="#2563eb" style={{ marginRight: 10 }} />
                  <View style={styles.itemMain}>
                    <Text style={styles.itemLabel}>{social.platform}</Text>
                    <Text style={styles.itemValue}>{social.username}</Text>
                  </View>
                  <Pressable
                    style={styles.deepLinkBtn}
                    onPress={() => void openSocialDeepLink(social.platform, social.username, social.url)}
                  >
                    <Text style={styles.deepLinkBtnText}>Open</Text>
                    <Ionicons name="open-outline" size={14} color="#2563eb" />
                  </Pressable>
                </View>
              ))}

              {/* Personal Addresses */}
              {personalAddresses.map((addr: AddressItem) => {
                const fullStr = [addr.street, addr.city, addr.state, addr.zip, addr.country]
                  .filter(Boolean)
                  .join(', ');
                return (
                  <View key={addr.id} style={styles.itemRow}>
                    <View style={styles.itemMain}>
                      <Text style={styles.itemLabel}>{addr.label} Address</Text>
                      <Text style={styles.itemValue}>{fullStr}</Text>
                    </View>
                    <Pressable style={styles.iconBtn} onPress={() => handleMap(addr)} hitSlop={6}>
                      <Ionicons name="navigate-outline" size={20} color="#2563eb" />
                    </Pressable>
                  </View>
                );
              })}
            </View>
          ) : null}

          {/* Work Context Section */}
          {hasWorkSection ? (
            <View style={styles.cardSection}>
              <View style={styles.sectionHeaderRow}>
                <Ionicons name="briefcase-outline" size={16} color="#2563eb" />
                <Text style={styles.sectionHeader}>Work Information</Text>
              </View>

              {contact.company || contact.jobTitle ? (
                <View style={styles.itemRow}>
                  <View style={styles.itemMain}>
                    {contact.company ? (
                      <Text style={styles.itemValueBold}>{contact.company}</Text>
                    ) : null}
                    {contact.jobTitle ? (
                      <Text style={styles.itemLabel}>{contact.jobTitle}</Text>
                    ) : null}
                  </View>
                </View>
              ) : null}

              {/* Work Phones */}
              {workPhones.map((phone: PhoneItem) => (
                <View key={phone.id} style={styles.itemRow}>
                  <View style={styles.itemMain}>
                    <Text style={styles.itemLabel}>Work Phone</Text>
                    <Text style={styles.itemValue}>{phone.number}</Text>
                  </View>
                  <View style={styles.itemActions}>
                    <Pressable style={styles.iconBtn} onPress={() => handleCall(phone.number)} hitSlop={6}>
                      <Ionicons name="call-outline" size={20} color="#2563eb" />
                    </Pressable>
                    <Pressable style={styles.iconBtn} onPress={() => handleSms(phone.number)} hitSlop={6}>
                      <Ionicons name="chatbubble-outline" size={20} color="#2563eb" />
                    </Pressable>
                  </View>
                </View>
              ))}

              {/* Work Emails */}
              {workEmails.map((email: EmailItem) => (
                <View key={email.id} style={styles.itemRow}>
                  <View style={styles.itemMain}>
                    <Text style={styles.itemLabel}>Work Email</Text>
                    <Text style={styles.itemValue}>{email.email}</Text>
                  </View>
                  <Pressable style={styles.iconBtn} onPress={() => handleEmail(email.email)} hitSlop={6}>
                    <Ionicons name="mail-outline" size={20} color="#2563eb" />
                  </Pressable>
                </View>
              ))}

              {/* Work Addresses */}
              {workAddresses.map((addr: AddressItem) => {
                const fullStr = [addr.street, addr.city, addr.state, addr.zip, addr.country]
                  .filter(Boolean)
                  .join(', ');
                return (
                  <View key={addr.id} style={styles.itemRow}>
                    <View style={styles.itemMain}>
                      <Text style={styles.itemLabel}>Work Address</Text>
                      <Text style={styles.itemValue}>{fullStr}</Text>
                    </View>
                    <Pressable style={styles.iconBtn} onPress={() => handleMap(addr)} hitSlop={6}>
                      <Ionicons name="navigate-outline" size={20} color="#2563eb" />
                    </Pressable>
                  </View>
                );
              })}
            </View>
          ) : null}

          {/* Delete Action */}
          <Pressable style={styles.deleteBtn} onPress={confirmDelete}>
            <Ionicons name="trash-outline" size={20} color="#dc2626" />
            <Text style={styles.deleteBtnText}>Delete Contact</Text>
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
  topBarRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  topBarBtn: {
    padding: 4,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
  },
  profileHeader: {
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  displayName: {
    fontSize: 22,
    fontWeight: '700',
    color: '#0f172a',
    marginTop: 12,
    textAlign: 'center',
  },
  nameBreakdown: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 10,
    marginTop: 6,
  },
  namePartLabel: {
    fontSize: 12,
    color: '#64748b',
  },
  namePartValue: {
    color: '#0f172a',
    fontWeight: '600',
  },
  quickActions: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 16,
    marginTop: 20,
    width: '100%',
  },
  quickBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#eff6ff',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 12,
    minWidth: 70,
  },
  quickBtnDisabled: {
    backgroundColor: '#f1f5f9',
  },
  quickBtnLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#2563eb',
    marginTop: 4,
  },
  quickBtnLabelDisabled: {
    color: '#94a3b8',
  },
  tagsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 16,
  },
  tagBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#e2e8f0',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  tagText: {
    fontSize: 12,
    color: '#334155',
    fontWeight: '500',
  },
  cardSection: {
    backgroundColor: '#ffffff',
    borderRadius: 14,
    padding: 14,
    marginBottom: 14,
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
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  itemMain: {
    flex: 1,
    marginRight: 10,
  },
  itemLabel: {
    fontSize: 12,
    color: '#64748b',
  },
  itemValue: {
    fontSize: 15,
    fontWeight: '500',
    color: '#0f172a',
    marginTop: 2,
  },
  itemValueBold: {
    fontSize: 16,
    fontWeight: '700',
    color: '#0f172a',
  },
  itemActions: {
    flexDirection: 'row',
    gap: 12,
  },
  iconBtn: {
    padding: 6,
  },
  deepLinkBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#eff6ff',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  deepLinkBtnText: {
    fontSize: 12,
    color: '#2563eb',
    fontWeight: '600',
  },
  notesText: {
    fontSize: 14,
    color: '#334155',
    lineHeight: 20,
    marginTop: 2,
  },
  deleteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#fef2f2',
    borderColor: '#fca5a5',
    borderWidth: 1,
    paddingVertical: 12,
    borderRadius: 12,
    marginTop: 8,
  },
  deleteBtnText: {
    color: '#dc2626',
    fontWeight: '600',
    fontSize: 15,
  },
});

