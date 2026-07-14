import React, { createContext, useContext, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useColorScheme } from 'react-native';
import { darkColors, lightColors, type Colors } from './index';

export type ThemePreference = 'system' | 'light' | 'dark';

interface ThemeCtx {
  colors: Colors;
  isDark: boolean;
  preference: ThemePreference;
  setPreference: (p: ThemePreference) => void;
  /** @deprecated use setPreference — kept for backward compat */
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeCtx>({
  colors: darkColors,
  isDark: true,
  preference: 'system',
  setPreference: () => {},
  toggleTheme: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme(); // 'light' | 'dark' | null
  const [preference, setPreferenceState] = useState<ThemePreference>('system');

  // Load saved preference on mount
  React.useEffect(() => {
    AsyncStorage.getItem('quill_theme').then((v) => {
      if (v === 'light' || v === 'dark' || v === 'system') {
        setPreferenceState(v);
      } else if (v === 'light') {
        setPreferenceState('light');
      }
    });
  }, []);

  const setPreference = (p: ThemePreference) => {
    setPreferenceState(p);
    AsyncStorage.setItem('quill_theme', p);
  };

  // Resolve the actual dark/light value
  const isDark = preference === 'system'
    ? (systemScheme === 'dark' || systemScheme === null)  // default dark if unknown
    : preference === 'dark';

  // Legacy toggle — flips between light/dark (skips system)
  const toggleTheme = () => {
    setPreference(isDark ? 'light' : 'dark');
  };

  const value = useMemo<ThemeCtx>(
    () => ({ colors: isDark ? darkColors : lightColors, isDark, preference, setPreference, toggleTheme }),
    [isDark, preference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useColors(): Colors {
  return useContext(ThemeContext).colors;
}

export function useTheme(): ThemeCtx {
  return useContext(ThemeContext);
}
