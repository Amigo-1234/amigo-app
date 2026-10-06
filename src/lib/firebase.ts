import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

/**
 * Firebase web config for the existing `amigo-world-ebfab` project — the same
 * project the prototype used, so existing accounts and posts carry over.
 * These values are public identifiers, not secrets; access control lives in
 * Firestore security rules. Override per environment with VITE_FIREBASE_*.
 */
const env = import.meta.env;
const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY ?? "AIzaSyA7LCr6HouDusvM0Yot261PvLidOCvG0oY",
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN ?? "amigo-world-ebfab.firebaseapp.com",
  projectId: env.VITE_FIREBASE_PROJECT_ID ?? "amigo-world-ebfab",
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET ?? "amigo-world-ebfab.firebasestorage.app",
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? "1071245255296",
  appId: env.VITE_FIREBASE_APP_ID ?? "1:1071245255296:web:b090d0bb080402a01a3c65",
};

export const firebaseApp = initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp);
