import React, { createContext, useContext, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { darkColors, lightColors, type Colors } from './index';

interface ThemeCtx {
  colors: Colors;
  isDark: boolean;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeCtx>({
  colors: darkColors,
  isDark: true,
  toggleTheme: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [isDark, setIsDark] = useState(true);

  React.useEffect(() => {
    AsyncStorage.getItem('quill_theme').then((v) => {
      if (v === 'light') setIsDark(false);
    });
  }, []);

  const toggleTheme = () => {
    setIsDark((prev) => {
      const next = !prev;
      AsyncStorage.setItem('quill_theme', next ? 'dark' : 'light');
      return next;
    });
  };

  const value = useMemo<ThemeCtx>(
    () => ({ colors: isDark ? darkColors : lightColors, isDark, toggleTheme }),
    [isDark],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useColors(): Colors {
  return useContext(ThemeContext).colors;
}

export function useTheme(): ThemeCtx {
  return useContext(ThemeContext);
}
