import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity,
  KeyboardAvoidingView, Platform, StatusBar, ActivityIndicator, Alert,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { colors, type as T, space, radius } from '../../theme';

interface Props { onDone: (skipped?: boolean) => void }

export default function AuthScreen({ onDone }: Props) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit() {
    if (!email.trim() || !password.trim()) {
      Alert.alert('Missing fields', 'Enter email and password.');
      return;
    }
    setLoading(true);
    try {
      const { error } =
        mode === 'signup'
          ? await supabase.auth.signUp({ email: email.trim(), password })
          : await supabase.auth.signInWithPassword({ email: email.trim(), password });

      if (error) {
        Alert.alert('Auth error', error.message);
      } else {
        onDone();
      }
    } finally {
      setLoading(false);
    }
  }

  async function continueOffline() {
    onDone(true); // explicitly skipped — mark so navigation doesn't re-show auth
  }

  return (
    <KeyboardAvoidingView
      style={s.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <StatusBar barStyle="light-content" backgroundColor={colors.bgDeep} />
      <LinearGradient colors={[colors.bgDeep, colors.bg]} style={StyleSheet.absoluteFill} />

      {/* Logo */}
      <View style={s.logo}>
        <LinearGradient colors={[colors.accent + '22', 'transparent']} style={s.logoRing}>
          <Text style={s.logoGlyph}>✦</Text>
        </LinearGradient>
        <Text style={s.wordmark}>Quill</Text>
        <Text style={s.tagline}>Sync your reading across devices</Text>
      </View>

      {/* Card */}
      <View style={s.card}>
        {/* Mode toggle */}
        <View style={s.toggle}>
          <TouchableOpacity
            style={[s.toggleBtn, mode === 'signin' && s.toggleActive]}
            onPress={() => setMode('signin')}
          >
            <Text style={[s.toggleText, mode === 'signin' && s.toggleTextActive]}>Sign in</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.toggleBtn, mode === 'signup' && s.toggleActive]}
            onPress={() => setMode('signup')}
          >
            <Text style={[s.toggleText, mode === 'signup' && s.toggleTextActive]}>Create account</Text>
          </TouchableOpacity>
        </View>

        {/* Inputs */}
        <View style={s.inputGroup}>
          <View style={s.inputRow}>
            <Ionicons name="mail-outline" size={18} color={colors.textMuted} style={s.inputIcon} />
            <TextInput
              style={s.input}
              placeholder="Email address"
              placeholderTextColor={colors.textMuted}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              value={email}
              onChangeText={setEmail}
            />
          </View>
          <View style={[s.inputRow, { marginTop: 10 }]}>
            <Ionicons name="lock-closed-outline" size={18} color={colors.textMuted} style={s.inputIcon} />
            <TextInput
              style={s.input}
              placeholder="Password"
              placeholderTextColor={colors.textMuted}
              secureTextEntry
              value={password}
              onChangeText={setPassword}
            />
          </View>
        </View>

        {/* Submit */}
        <TouchableOpacity style={s.primaryBtn} onPress={submit} disabled={loading} activeOpacity={0.85}>
          <LinearGradient colors={[colors.accentBright, colors.accent]} style={s.btnGrad}>
            {loading
              ? <ActivityIndicator color={colors.bgDeep} />
              : <Text style={s.btnText}>{mode === 'signup' ? 'Create account' : 'Sign in'}</Text>
            }
          </LinearGradient>
        </TouchableOpacity>

        {/* Divider */}
        <View style={s.divider}>
          <View style={s.divLine} />
          <Text style={s.divText}>or</Text>
          <View style={s.divLine} />
        </View>

        {/* Skip */}
        <TouchableOpacity style={s.skipBtn} onPress={continueOffline}>
          <Ionicons name="phone-portrait-outline" size={16} color={colors.textMuted} style={{ marginRight: 6 }} />
          <Text style={s.skipText}>Continue offline — sync later</Text>
        </TouchableOpacity>
      </View>

      <Text style={s.footnote}>
        Your streak, library, and follows sync to your account.
      </Text>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bgDeep, alignItems: 'center', justifyContent: 'center' },
  logo: { alignItems: 'center', marginBottom: space.xl },
  logoRing: {
    width: 72, height: 72, borderRadius: 36,
    alignItems: 'center', justifyContent: 'center', marginBottom: space.md,
    borderWidth: 1, borderColor: colors.accentBorder,
  },
  logoGlyph: { fontSize: 32, color: colors.accent },
  wordmark: { ...T.d1, color: colors.text, letterSpacing: 4, marginBottom: 6 },
  tagline: { ...T.body, color: colors.textMuted },
  card: {
    width: '90%', backgroundColor: colors.surface, borderRadius: radius.xl,
    padding: space.lg, borderWidth: 1, borderColor: colors.border,
  },
  toggle: {
    flexDirection: 'row', backgroundColor: colors.surfaceHigher,
    borderRadius: radius.md, padding: 4, marginBottom: space.lg,
  },
  toggleBtn: { flex: 1, paddingVertical: 8, borderRadius: radius.sm, alignItems: 'center' },
  toggleActive: { backgroundColor: colors.accentMuted },
  toggleText: { ...T.h3, color: colors.textMuted },
  toggleTextActive: { color: colors.accent },
  inputGroup: { marginBottom: space.md },
  inputRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surfaceHigher, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border, paddingHorizontal: space.md,
  },
  inputIcon: { marginRight: space.sm },
  input: { flex: 1, ...T.body, color: colors.text, paddingVertical: 14 },
  primaryBtn: { borderRadius: radius.md, overflow: 'hidden', marginBottom: space.md },
  btnGrad: { paddingVertical: 15, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
  btnText: { ...T.h2, color: colors.bgDeep },
  divider: { flexDirection: 'row', alignItems: 'center', marginBottom: space.md, gap: space.sm },
  divLine: { flex: 1, height: 1, backgroundColor: colors.border },
  divText: { ...T.caption, color: colors.textMuted },
  skipBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 8 },
  skipText: { ...T.caption, color: colors.textMuted },
  footnote: { ...T.caption, color: colors.textMuted, textAlign: 'center', marginTop: space.xl, paddingHorizontal: space.xl },
});
