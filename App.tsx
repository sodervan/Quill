import React, { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { initDb } from './src/data/db';
import Navigation from './src/navigation';
import { colors } from './src/theme';

export default function App() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    initDb().then(() => setReady(true));
  }, []);

  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Navigation />
    </SafeAreaProvider>
  );
}
