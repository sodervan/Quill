import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ── Fill these in after creating your Supabase project at supabase.com ──
const SUPABASE_URL = 'https://uoagjbfbqxvfgjyortkb.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVvYWdqYmZicXh2ZmdqeW9ydGtiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI5MjE5OTYsImV4cCI6MjA5ODQ5Nzk5Nn0.i1Nwbl-9pKBuNahsiXCI_uW6Q2DHZVh3vylqz1iQtqA';
// ────────────────────────────────────────────────────────────────────────

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

export type SupabaseUser = Awaited<ReturnType<typeof supabase.auth.getUser>>['data']['user'];
