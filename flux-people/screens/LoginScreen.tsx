import React, { useState } from 'react';
import { ActivityIndicator, Alert, Button, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { FluxClient } from '@flux-sdk/core';

type Props = {
  client: FluxClient;
  onLoggedIn: () => void;
  onNavigateToRegister: () => void;
};

export default function LoginScreen({ client, onLoggedIn, onNavigateToRegister }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.login({ username, password });
      onLoggedIn();
    } catch (loginError) {
      const message = loginError instanceof Error ? loginError.message : 'Sign in failed';
      setError(message);
      Alert.alert('Sign in failed', message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.brandHeader}>
        <View style={styles.iconCircle}>
          <Ionicons name="people" size={40} color="#2563eb" />
        </View>
        <Text style={styles.title}>Flux People</Text>
        <Text style={styles.subtitle}>Sign in to manage your contacts</Text>
      </View>

      <TextInput
        value={username}
        onChangeText={setUsername}
        placeholder="Username"
        autoCapitalize="none"
        style={styles.input}
      />
      <TextInput
        value={password}
        onChangeText={setPassword}
        placeholder="Password"
        secureTextEntry
        style={styles.input}
      />

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {busy ? (
        <ActivityIndicator style={styles.loader} size="small" />
      ) : (
        <Button title="Sign in" onPress={() => void submit()} disabled={!username || !password} />
      )}

      <View style={styles.footer}>
        <Text style={styles.footerText}>Don't have an account?</Text>
        <Button title="Create one" onPress={onNavigateToRegister} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#f5f7fb',
  },
  brandHeader: {
    alignItems: 'center',
    marginBottom: 28,
  },
  iconCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#dbeafe',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  title: {
    fontSize: 32,
    fontWeight: '700',
    textAlign: 'center',
    color: '#0f172a',
  },
  subtitle: {
    fontSize: 14,
    color: '#475569',
    textAlign: 'center',
    marginTop: 4,
  },
  input: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#fff',
    marginBottom: 12,
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
    marginVertical: 8,
  },
  footer: {
    marginTop: 24,
    alignItems: 'center',
    gap: 4,
  },
  footerText: {
    fontSize: 13,
    color: '#475569',
  },
});
