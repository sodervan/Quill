import React, { useEffect, useState } from 'react';
import { ActivityIndicator, DeviceEventEmitter, Text, View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';

import { colors } from '../theme';
import { getSetting } from '../data/db';
import { supabase } from '../lib/supabase';

import FeedScreen from '../features/feed/FeedScreen';
import DiscoverScreen from '../features/discover/DiscoverScreen';
import LibraryScreen from '../features/library/LibraryScreen';
import ProfileScreen from '../features/profile/ProfileScreen';
import ReaderScreen from '../features/reader/ReaderScreen';
import OnboardingScreen from '../features/onboarding/OnboardingScreen';
import AuthScreen from '../features/auth/AuthScreen';
import HighlightsScreen from '../features/highlights/HighlightsScreen';

export type RootStackParamList = {
  Tabs: undefined;
  Reader: { articleId: string; publicationId: string };
  Highlights: undefined;
};

export type TabParamList = {
  Feed: undefined;
  Discover: undefined;
  Library: undefined;
  Profile: undefined;
};

type IoniconsName = React.ComponentProps<typeof Ionicons>['name'];

const TAB_ICONS: Record<string, { active: IoniconsName; inactive: IoniconsName }> = {
  Feed:     { active: 'book',          inactive: 'book-outline' },
  Discover: { active: 'compass',       inactive: 'compass-outline' },
  Library:  { active: 'bookmark',      inactive: 'bookmark-outline' },
  Profile:  { active: 'person-circle', inactive: 'person-circle-outline' },
};

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<TabParamList>();

function Tabs() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          height: 68,
          paddingBottom: 10,
          paddingTop: 8,
        },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarLabelStyle: { fontSize: 10, fontWeight: '600', letterSpacing: 0.3 },
        tabBarIcon: ({ focused, color }) => {
          const icons = TAB_ICONS[route.name];
          return <Ionicons name={focused ? icons.active : icons.inactive} size={26} color={color} />;
        },
      })}
    >
      <Tab.Screen name="Feed" component={FeedScreen} />
      <Tab.Screen name="Discover" component={DiscoverScreen} />
      <Tab.Screen name="Library" component={LibraryScreen} />
      <Tab.Screen name="Profile" component={ProfileScreen} />
    </Tab.Navigator>
  );
}

type AppStage = 'loading' | 'auth' | 'onboarding' | 'app';

export default function Navigation() {
  const [stage, setStage] = useState<AppStage>('loading');

  useEffect(() => {
    async function init() {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        const skipped = await getSetting('auth_skipped');
        if (skipped !== '1') { setStage('auth'); return; }
      } else {
        // Already signed in (app restart) — await restore so FeedScreen sees all follows
        try {
          const m = await import('../lib/sync');
          await m.uploadLocalToSupabase();
          await m.restoreFromSupabase();
        } catch {}
      }
      const onboarded = await getSetting('onboarding_done');
      setStage(onboarded === '1' ? 'app' : 'onboarding');
    }
    void init();

    const authRequestSub = DeviceEventEmitter.addListener('navigateToAuth', () => setStage('auth'));

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) {
        if (_event === 'SIGNED_IN') {
          // Show spinner immediately, await restore, then navigate — no onboarding flash
          setStage('loading');
          import('../lib/sync').then(async (m) => {
            await m.uploadLocalToSupabase();
            await m.restoreFromSupabase();
            const val = await getSetting('onboarding_done');
            setStage(val === '1' ? 'app' : 'onboarding');
          }).catch(async () => {
            const val = await getSetting('onboarding_done');
            setStage(val === '1' ? 'app' : 'onboarding');
          });
        } else {
          getSetting('onboarding_done').then((val) => {
            setStage(val === '1' ? 'app' : 'onboarding');
          });
        }
      } else if (_event === 'SIGNED_OUT') {
        setStage('auth');
      }
    });
    return () => { subscription.unsubscribe(); authRequestSub.remove(); };
  }, []);

  if (stage === 'loading') {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bgDeep, alignItems: 'center', justifyContent: 'center', gap: 16 }}>
        <ActivityIndicator color={colors.accent} size="large" />
        <Text style={{ color: colors.textMuted, fontSize: 14, letterSpacing: 0.3 }}>Syncing your data…</Text>
      </View>
    );
  }

  if (stage === 'auth') {
    return (
      <AuthScreen
        onDone={async (skipped = false) => {
          if (skipped) {
            const { setSetting } = await import('../data/db');
            await setSetting('auth_skipped', '1');
            const { getSetting: gs } = await import('../data/db');
            const onboarded = await gs('onboarding_done');
            setStage(onboarded === '1' ? 'app' : 'onboarding');
          }
          // Signed in: onAuthStateChange fires and handles restore + navigation
        }}
      />
    );
  }

  if (stage === 'onboarding') {
    return <OnboardingScreen onDone={() => setStage('app')} />;
  }

  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false, animation: 'slide_from_right' }}>
        <Stack.Screen name="Tabs" component={Tabs} />
        <Stack.Screen name="Reader" component={ReaderScreen} />
        <Stack.Screen name="Highlights" component={HighlightsScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
