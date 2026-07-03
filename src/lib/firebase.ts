import { initializeApp } from 'firebase/app';
import { initializeAuth, getReactNativePersistence } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import AsyncStorage from '@react-native-async-storage/async-storage';

const firebaseConfig = {
  apiKey: 'AIzaSyDDgTdSrgNPFi9sBkBaVvRDEa3JliI9mMg',
  authDomain: 'quill-557b0.firebaseapp.com',
  projectId: 'quill-557b0',
  storageBucket: 'quill-557b0.firebasestorage.app',
  messagingSenderId: '600822506944',
  appId: '1:600822506944:web:87622c5c4bfaedeff0d425',
};

const app = initializeApp(firebaseConfig);

export const auth = initializeAuth(app, {
  persistence: getReactNativePersistence(AsyncStorage),
});

export const db = getFirestore(app);

export type FirebaseUser = import('firebase/auth').User;
