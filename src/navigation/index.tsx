import React, { useEffect, useState } from 'react';
import { ActivityIndicator, DeviceEventEmitter, Text, View } from 'react-native';
import { NavigationContainer, NavigatorScreenParams } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { onAuthStateChanged } from 'firebase/auth';

import { useColors } from '../theme/ThemeContext';
import { type as T, space } from '../theme';
import { getSetting } from '../data/db';
import { auth } from '../lib/firebase';

import FeedScreen from '../features/feed/FeedScreen';
import DiscoverScreen from '../features/discover/DiscoverScreen';
import LibraryScreen from '../features/library/LibraryScreen';
import ProfileScreen from '../features/profile/ProfileScreen';
import ReaderScreen from '../features/reader/ReaderScreen';
import OnboardingScreen from '../features/onboarding/OnboardingScreen';
import AuthScreen from '../features/auth/AuthScreen';
import HighlightsScreen from '../features/highlights/HighlightsScreen';
import BookshelfScreen from '../features/books/BookshelfScreen';
import BookReaderScreen from '../features/books/BookReaderScreen';
import HistoryScreen from '../features/history/HistoryScreen';

export type TabParamList = {
  Feed: undefined;
  Discover: undefined;
  Library: undefined;
  Books: undefined;
  Profile: undefined;
};

export type RootStackParamList = {
  Tabs: NavigatorScreenParams<TabParamList> | undefined;
  Reader: { articleId: string; publicationId: string; highlightId?: number };
  Highlights: undefined;
  History: undefined;
  BookReader: { bookId: string; initialPage?: number };
};

type IoniconsName = React.ComponentProps<typeof Ionicons>['name'];

const TAB_ICONS: Record<string, { active: IoniconsName; inactive: IoniconsName }> = {
  Feed:     { active: 'book',          inactive: 'book-outline' },
  Discover: { active: 'compass',       inactive: 'compass-outline' },
  Library:  { active: 'bookmark',      inactive: 'bookmark-outline' },
  Books:    { active: 'library',       inactive: 'library-outline' },
  Profile:  { active: 'person-circle', inactive: 'person-circle-outline' },
};

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<TabParamList>();

function Tabs() {
  const colors = useColors();
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
      <Tab.Screen name="Books" component={BookshelfScreen} />
      <Tab.Screen name="Profile" component={ProfileScreen} />
    </Tab.Navigator>
  );
}

type AppStage = 'loading' | 'auth' | 'onboarding' | 'app';

// The local DB doesn't know which account it currently belongs to. If the last account
// synced locally is different from the one signing in now, the local cache is stale
// data left over from someone else's (or a previous) account — wipe it before restoring,
// instead of uploading it into the new account. Same account resuming (including a
// guest session that later re-signs into the same account) still uploads normally, so
// any offline changes made in between aren't lost.
async function syncForUser(uid: string) {
  const dbMod = await import('../data/db');
  const syncMod = await import('../lib/sync');
  const lastUid = await dbMod.getSyncedUid();
  if (lastUid && lastUid !== uid) {
    await dbMod.resetLocalUserData();
  } else {
    await syncMod.uploadLocalToSupabase();
  }
  await syncMod.restoreFromSupabase();
  await dbMod.setSyncedUid(uid);
}

export default function Navigation() {
  const [stage, setStage] = useState<AppStage>('loading');
  const colors = useColors();

  useEffect(() => {
    let initialized = false;

    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (!initialized) {
        initialized = true;
        // First fire = app startup (existing session or cold start)
        if (!user) {
          const skipped = await getSetting('auth_skipped');
          if (skipped !== '1') { setStage('auth'); return; }
          const onboarded = await getSetting('onboarding_done');
          setStage(onboarded === '1' ? 'app' : 'onboarding');
        } else {
          // Already signed in — await restore before showing UI
          try {
            await syncForUser(user.uid);
          } catch {}
          const onboarded = await getSetting('onboarding_done');
          setStage(onboarded === '1' ? 'app' : 'onboarding');
        }
      } else {
        // Subsequent fires = sign-in / sign-out events
        if (user) {
          setStage('loading');
          syncForUser(user.uid).then(async () => {
            const val = await getSetting('onboarding_done');
            setStage(val === '1' ? 'app' : 'onboarding');
          }).catch(async () => {
            const val = await getSetting('onboarding_done');
            setStage(val === '1' ? 'app' : 'onboarding');
          });
        } else {
          setStage('auth');
        }
      }
    });

    const authRequestSub = DeviceEventEmitter.addListener('navigateToAuth', () => setStage('auth'));

    return () => { unsubscribe(); authRequestSub.remove(); };
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
          // Signed in: onAuthStateChanged fires and handles restore + navigation
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
        <Stack.Screen name="History" component={HistoryScreen} />
        <Stack.Screen name="BookReader" component={BookReaderScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
