// ------------------ FIREBASE SETUP (same config) ------------------

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";
import { 
  getFirestore, doc, getDoc, updateDoc, arrayUnion, arrayRemove 
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";
import {
  getAuth, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyA7LCr6HouDusvMVYot261PvLidOCvG0oY",
  authDomain: "amigo-world-ebfab.firebaseapp.com",
  projectId: "amigo-world-ebfab",
  storageBucket: "amigo-world-ebfab.firebasestorage.app",
  messagingSenderId: "1071245255296",
  appId: "1:1071245255296:web:b090d0bb080402a01a3c65"
};

// init firebase
const app = initializeApp(firebaseConfig);
const db  = getFirestore(app);
const auth = getAuth(app);

// ------------------ GLOBAL STATE ------------------
let currentUser = null;

// ------------------ FOLLOW USER ------------------
export async function followUser(targetUserId) {
  if (!currentUser) return alert("Login first 💀");

  const myRef = doc(db, "users", currentUser.uid);
  const targetRef = doc(db, "users", targetUserId);

  try {
    await updateDoc(myRef, {
      following: arrayUnion(targetUserId)
    });

    await updateDoc(targetRef, {
      followers: arrayUnion(currentUser.uid)
    });

    console.log("Followed:", targetUserId);
    return true;
  } catch (err) {
    console.error("FOLLOW ERROR:", err);
    return false;
  }
}

// ------------------ UNFOLLOW USER ------------------
export async function unfollowUser(targetUserId) {
  if (!currentUser) return alert("Login first 💀");

  const myRef = doc(db, "users", currentUser.uid);
  const targetRef = doc(db, "users", targetUserId);

  try {
    await updateDoc(myRef, {
      following: arrayRemove(targetUserId)
    });

    await updateDoc(targetRef, {
      followers: arrayRemove(currentUser.uid)
    });

    console.log("Unfollowed:", targetUserId);
    return true;
  } catch (err) {
    console.error("UNFOLLOW ERROR:", err);
    return false;
  }
}

// ------------------ LOAD FOLLOWING LIST ------------------
export async function getMyFollowing() {
  if (!currentUser) return [];

  const ref = doc(db, "users", currentUser.uid);
  const snap = await getDoc(ref);
  
  if (!snap.exists()) return [];
  return snap.data().following || [];
}

// ------------------ LOAD FOLLOWERS ------------------
export async function getMyFollowers() {
  if (!currentUser) return [];

  const ref = doc(db, "users", currentUser.uid);
  const snap = await getDoc(ref);
  
  if (!snap.exists()) return [];
  return snap.data().followers || [];
}

// ------------------ LOAD ANY USER PROFILE ------------------
export async function getUserProfile(uid) {
  const ref = doc(db, "users", uid);
  const snap = await getDoc(ref);

  if (!snap.exists()) return null;
  return snap.data();
}

// ------------------ RENDER FRIENDS LIST (OPTIONAL UI) ------------------
export async function renderFriendsUI() {
  const container = document.querySelector("#friends-list");
  if (!container) return;

  container.innerHTML = `<p>Loading friends...</p>`;
  
  const following = await getMyFollowing();

  if (following.length === 0) {
    container.innerHTML = `<p>You aren't following anyone yet 👀</p>`;
    return;
  }

  container.innerHTML = "";

  for (let uid of following) {
    const data = await getUserProfile(uid);
    if (!data) continue;

    const div = document.createElement("div");
    div.className = "friend-row";

    div.innerHTML = `
      <div class="friend-avatar">${(data.displayName || "?")[0]}</div>
      <div class="friend-name">@${data.displayName}</div>
    `;

    container.appendChild(div);
  }
}

// ------------------ AUTH LISTENER ------------------
onAuthStateChanged(auth, (user) => {
  currentUser = user || null;

  if (currentUser) {
    console.log("FRIENDS.JS: Logged in as", currentUser.uid);
    renderFriendsUI();
  } else {
    console.log("FRIENDS.JS: Logged out");
  }
});
