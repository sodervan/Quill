import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, Animated, Pressable } from 'react-native';
import { useColors } from '../theme/ThemeContext';
import { type as T, space, radius, shadow } from '../theme';

export type AppAlertButton = {
  text: string;
  style?: 'default' | 'cancel' | 'destructive';
  onPress?: () => void;
};

type AlertRequest = {
  title: string;
  message?: string;
  buttons: AppAlertButton[];
};

// Module-level so AppAlert.alert(...) can be called imperatively from anywhere —
// event handlers, async functions, wherever — just like the RN Alert API it replaces.
// AppAlertHost (mounted once, near the app root) registers the setter on mount.
let showRequest: ((req: AlertRequest) => void) | null = null;

export const AppAlert = {
  /** Drop-in replacement for React Native's Alert.alert — same signature. */
  alert(title: string, message?: string, buttons?: AppAlertButton[]) {
    const resolved = buttons && buttons.length > 0 ? buttons : [{ text: 'OK' }];
    if (showRequest) {
      showRequest({ title, message, buttons: resolved });
    } else if (__DEV__) {
      console.warn('AppAlert.alert() called before AppAlertHost mounted:', title);
    }
  },
};

/** Mount once near the app root (see App.tsx). Renders whatever AppAlert.alert() requests. */
export function AppAlertHost() {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const [request, setRequest] = useState<AlertRequest | null>(null);
  const [mounted, setMounted] = useState(false);
  const animY = useRef(new Animated.Value(16)).current;
  const animOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    showRequest = (req) => {
      setRequest(req);
      setMounted(true);
      animY.setValue(16);
      animOpacity.setValue(0);
      Animated.parallel([
        Animated.spring(animY, { toValue: 0, useNativeDriver: true, tension: 140, friction: 14 }),
        Animated.timing(animOpacity, { toValue: 1, duration: 160, useNativeDriver: true }),
      ]).start();
    };
    return () => { showRequest = null; };
  }, [animY, animOpacity]);

  function close(onPress?: () => void) {
    Animated.timing(animOpacity, { toValue: 0, duration: 130, useNativeDriver: true }).start(() => {
      setMounted(false);
      setRequest(null);
      onPress?.();
    });
  }

  if (!request) return null;
  const stacked = request.buttons.length > 2;

  return (
    <Modal visible={mounted} transparent animationType="none" statusBarTranslucent onRequestClose={() => close()}>
      <Animated.View style={[StyleSheet.absoluteFill, s.backdrop, { opacity: animOpacity }]}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={() => close(request.buttons.find((b) => b.style === 'cancel')?.onPress)}
        />
      </Animated.View>
      <View style={s.centerWrap} pointerEvents="box-none">
        <Animated.View style={[s.card, { opacity: animOpacity, transform: [{ translateY: animY }] }]}>
          <Text style={s.title}>{request.title}</Text>
          {request.message ? <Text style={s.message}>{request.message}</Text> : null}
          <View style={stacked ? s.btnColumn : s.btnRow}>
            {request.buttons.map((b, i) => (
              <TouchableOpacity
                key={i}
                style={[
                  s.btn,
                  !stacked && s.btnFlex,
                  b.style === 'destructive' && s.btnDestructive,
                  b.style === 'cancel' && s.btnCancel,
                ]}
                onPress={() => close(b.onPress)}
                activeOpacity={0.75}
              >
                <Text
                  style={[
                    s.btnText,
                    b.style === 'destructive' && s.btnTextDestructive,
                    b.style === 'cancel' && s.btnTextCancel,
                  ]}
                >
                  {b.text}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

function createStyles(colors: ReturnType<typeof useColors>) { return StyleSheet.create({
  backdrop: { backgroundColor: 'rgba(0,0,0,0.6)' },
  centerWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },
  card: {
    width: '100%', maxWidth: 340,
    backgroundColor: colors.surface, borderRadius: radius.xl,
    borderWidth: 1, borderColor: colors.border,
    padding: space.lg, ...shadow.card,
  },
  title: { ...T.h2, color: colors.text, marginBottom: 6, textAlign: 'center' },
  message: { ...T.body, fontSize: 14, lineHeight: 20, color: colors.textSecondary, textAlign: 'center', marginBottom: space.lg },
  btnRow: { flexDirection: 'row', gap: 10, marginTop: space.sm },
  btnColumn: { gap: 8, marginTop: space.sm },
  btn: {
    paddingVertical: 12, paddingHorizontal: space.md,
    borderRadius: radius.md, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.accent,
  },
  btnFlex: { flex: 1 },
  btnCancel: { backgroundColor: colors.surfaceHigher, borderWidth: 1, borderColor: colors.border },
  btnDestructive: { backgroundColor: colors.danger },
  btnText: { ...T.h3, color: colors.bgDeep },
  btnTextCancel: { color: colors.textSecondary },
  btnTextDestructive: { color: colors.white },
}); }
