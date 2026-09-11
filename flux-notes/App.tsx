import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DiagnosticEvent, FluxClient } from '@flux-sdk/core';
import LoginScreen from './screens/LoginScreen';
import RegisterScreen from './screens/RegisterScreen';
import MainNotesScreen from './screens/MainNotesScreen';

type Screen = 'login' | 'register';

export default function App() {
  return (
    <SafeAreaProvider>
      <AppContent />
    </SafeAreaProvider>
  );
}

function AppContent() {
  const [diagnostics, setDiagnostics] = useState<DiagnosticEvent[]>([]);
  const client = useMemo(
    () =>
      new FluxClient({
        instanceId: '',
        storage: AsyncStorage,
        onDiagnostic: (event) => setDiagnostics((current) => [...current, event].slice(-30)),
        autoConnect: false,
      }),
    []
  );

  const [restoring, setRestoring] = useState(true);
  const [loggedIn, setLoggedIn] = useState(false);
  const [screen, setScreen] = useState<Screen>('login');

  useEffect(() => {
    let cancelled = false;
    void client.ready.then(() => {
      if (cancelled) return;
      setLoggedIn(client.isLoggedIn());
      setRestoring(false);
    });
    return () => {
      cancelled = true;
    };
  }, [client]);

  if (restoring) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#eab308" />
      </View>
    );
  }

  if (!loggedIn) {
    return screen === 'login' ? (
      <LoginScreen
        client={client}
        onLoggedIn={() => setLoggedIn(true)}
        onNavigateToRegister={() => setScreen('register')}
      />
    ) : (
      <RegisterScreen
        client={client}
        onRegistered={() => setLoggedIn(true)}
        onNavigateToLogin={() => setScreen('login')}
      />
    );
  }

  return (
    <MainNotesScreen
      client={client}
      diagnostics={diagnostics}
      onLoggedOut={() => {
        setLoggedIn(false);
        setScreen('login');
      }}
    />
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fefce8',
  },
});
