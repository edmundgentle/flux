import React, { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { FluxClient } from '@flux-sdk/core';
import { Ionicons } from '@expo/vector-icons';

type Props = {
  client: FluxClient;
  onRegistered: () => void;
  onNavigateToLogin: () => void;
};

export default function RegisterScreen({ client, onRegistered, onNavigateToLogin }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.register({ username, password, displayName: displayName.trim() || undefined });
      onRegistered();
    } catch (registerError) {
      const message = registerError instanceof Error ? registerError.message : 'Registration failed';
      setError(message);
      Alert.alert('Registration failed', message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <View style={styles.iconCircle}>
          <Ionicons name="person-add" size={36} color="#eab308" />
        </View>
        <Text style={styles.title}>Create Account</Text>
        <Text style={styles.subtitle}>Join Flux to sync and store your notes</Text>

        <TextInput
          value={displayName}
          onChangeText={setDisplayName}
          placeholder="Display Name (optional)"
          placeholderTextColor="#94a3b8"
          style={styles.input}
        />
        <TextInput
          value={username}
          onChangeText={setUsername}
          placeholder="Username"
          autoCapitalize="none"
          placeholderTextColor="#94a3b8"
          style={styles.input}
        />
        <TextInput
          value={password}
          onChangeText={setPassword}
          placeholder="Password"
          secureTextEntry
          placeholderTextColor="#94a3b8"
          style={styles.input}
        />

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {busy ? (
          <ActivityIndicator style={styles.loader} size="small" color="#eab308" />
        ) : (
          <Pressable
            style={[styles.primaryBtn, (!username || !password) && styles.btnDisabled]}
            onPress={() => void submit()}
            disabled={!username || !password}
          >
            <Text style={styles.primaryBtnText}>Register</Text>
          </Pressable>
        )}

        <View style={styles.footer}>
          <Text style={styles.footerText}>Already have an account?</Text>
          <Pressable onPress={onNavigateToLogin}>
            <Text style={styles.linkText}>Sign in</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#fefce8',
  },
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 20,
    padding: 28,
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 4,
    borderWidth: 1,
    borderColor: '#fef08a',
  },
  iconCircle: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: '#fef9c3',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginBottom: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: '800',
    textAlign: 'center',
    color: '#0f172a',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: '#64748b',
    textAlign: 'center',
    marginBottom: 24,
  },
  input: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: '#fff',
    fontSize: 15,
    marginBottom: 14,
  },
  error: {
    backgroundColor: '#fee2e2',
    borderColor: '#fca5a5',
    borderWidth: 1,
    borderRadius: 10,
    color: '#991b1b',
    fontSize: 12,
    padding: 10,
    marginBottom: 12,
  },
  loader: {
    marginVertical: 12,
  },
  primaryBtn: {
    backgroundColor: '#eab308',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 4,
  },
  btnDisabled: {
    opacity: 0.5,
  },
  primaryBtnText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 16,
  },
  footer: {
    marginTop: 20,
    alignItems: 'center',
    gap: 4,
  },
  footerText: {
    fontSize: 13,
    color: '#64748b',
  },
  linkText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#ca8a04',
  },
});
