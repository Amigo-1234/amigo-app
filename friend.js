// friend.js  – AMIGO WORLD Friends page

import {
  getAuth,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";

import {
  getFirestore,
  collection,
  doc,
  getDocs,
  getDoc,
  setDoc,
  deleteDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";

const auth = getAuth();          // reuse default app from app.js
const db   = getFirestore();     // reuse same Firestore

// ---------- DOM refs ----------
const followingList   = document.getElementById("friends-following-list");
const followersList   = document.getElementById("friends-followers-list");
const suggestionsList = document.getElementById("friends-suggestions-list");
const searchInput     = document.getElementById("friend-search-input");

let currentUser = null;
let allUsersCache = [];          // [{id, displayName, email, avatarUrl}]
let followingIds  = new Set();
let followerIds   = new Set();

// small helper
function safeName(user) {
  return (
    user.displayName ||
    (user.email ? user.email.split("@")[0] : "") ||
    "amigo_user"
  );
}

// ---------- ensure user doc exists ----------
async function ensureUserDoc(user) {
  if (!user) return;
  const ref = doc(db, "users", user.uid);
  await setDoc(
    ref,
    {
      displayName: safeName(user),
      email: user.email || "",
      avatarUrl: null,
      updatedAt: serverTimestamp()
    },
    { merge: true }
  );
}

// ---------- load all users into cache ----------
async function loadAllUsers() {
  const snap = await getDocs(collection(db, "users"));
  allUsersCache = [];
  snap.forEach((d) => {
    allUsersCache.push({ id: d.id, ...d.data() });
  });
}

// ---------- load following / followers ----------
async function loadFollowing(uid) {
  followingIds = new Set();
  const ref = collection(db, "users", uid, "following");
  const snap = await getDocs(ref);
  snap.forEach((d) => followingIds.add(d.id));
}

async function loadFollowers(uid) {
  followerIds = new Set();
  const ref = collection(db, "users", uid, "followers");
  const snap = await getDocs(ref);
  snap.forEach((d) => followerIds.add(d.id));
}

// ---------- UI builders ----------
function renderUserList(users, container, emptyText) {
  container.innerHTML = "";
  if (!users.length) {
    container.innerHTML = `<p class="empty-hint">${emptyText}</p>`;
    return;
  }

  users.forEach((u) => {
    container.appendChild(makeFriendRow(u));
  });
}

function makeFriendRow(user) {
  const row = document.createElement("div");
  row.className = "friend-row";

  const avatarUrl =
    user.avatarUrl || "https://i.pravatar.cc/80?img=15";
  const display = safeName(user);

  const isFollowing = currentUser && followingIds.has(user.id);

  row.innerHTML = `
    <div class="friend-row-left">
      <img src="${avatarUrl}" class="friend-row-avatar" alt="">
      <span class="friend-row-name">@${display}</span>
    </div>
    ${
      currentUser && user.id !== currentUser.uid
        ? `<button class="friend-follow-btn ${isFollowing ? "following" : ""}" data-id="${user.id}">
             ${isFollowing ? "Following" : "Follow"}
           </button>`
        : ""
    }
  `;

  const btn = row.querySelector(".friend-follow-btn");
  if (btn) {
    btn.addEventListener("click", async () => {
      const targetId = btn.dataset.id;
      const nowFollowing = btn.classList.contains("following");

      if (!nowFollowing) {
        await followUser(targetId);
        btn.classList.add("following");
        btn.textContent = "Following";
      } else {
        await unfollowUser(targetId);
        btn.classList.remove("following");
        btn.textContent = "Follow";
      }

      // refresh local state
      await loadFollowing(currentUser.uid);
      renderFriendsSections();
    });
  }

  return row;
}

// ---------- follow / unfollow ----------
async function followUser(targetId) {
  if (!currentUser) return;

  const myId = currentUser.uid;

  // add to my "following"
  await setDoc(
    doc(db, "users", myId, "following", targetId),
    { followedAt: serverTimestamp() }
  );

  // add to their "followers"
  await setDoc(
    doc(db, "users", targetId, "followers", myId),
    { followedAt: serverTimestamp() }
  );
}

async function unfollowUser(targetId) {
  if (!currentUser) return;

  const myId = currentUser.uid;

  await deleteDoc(doc(db, "users", myId, "following", targetId));
  await deleteDoc(doc(db, "users", targetId, "followers", myId));
}

// ---------- render all sections ----------
function renderFriendsSections() {
  if (!currentUser) {
    followingList.innerHTML   = `<p class="empty-hint">Log in to see friends.</p>`;
    followersList.innerHTML   = `<p class="empty-hint">Log in to see friends.</p>`;
    suggestionsList.innerHTML = `<p class="empty-hint">Log in to discover people.</p>`;
    return;
  }

  // following
  const followingUsers = allUsersCache.filter((u) =>
    followingIds.has(u.id)
  );
  renderUserList(
    followingUsers,
    followingList,
    "You are not following anyone yet."
  );

  // followers
  const followerUsers = allUsersCache.filter((u) =>
    followerIds.has(u.id)
  );
  renderUserList(
    followerUsers,
    followersList,
    "You have no followers yet."
  );

  // suggestions = everyone except me + people I already follow
  const suggestions = allUsersCache.filter(
    (u) => u.id !== currentUser.uid && !followingIds.has(u.id)
  );
  renderUserList(
    suggestions,
    suggestionsList,
    "No suggestions available."
  );
}

// ---------- search logic ----------
function setupSearch() {
  if (!searchInput) return;

  searchInput.addEventListener("input", () => {
    const term = searchInput.value.trim().toLowerCase();

    if (!term) {
      // empty search → show normal suggestions again
      renderFriendsSections();
      return;
    }

    const matches = allUsersCache.filter((u) => {
      const name = safeName(u).toLowerCase();
      const email = (u.email || "").toLowerCase();
      return name.includes(term) || email.includes(term);
    });

    // use suggestions block to show search results
    renderUserList(
      matches,
      suggestionsList,
      "No users match that search."
    );
  });
}

// ---------- auth state ----------
onAuthStateChanged(auth, async (user) => {
  currentUser = user || null;

  if (!user) {
    renderFriendsSections();
    return;
  }

  // 1) make sure this user exists in /users
  await ensureUserDoc(user);

  // 2) load everything
  await loadAllUsers();
  await loadFollowing(user.uid);
  await loadFollowers(user.uid);

  // 3) render UI
  renderFriendsSections();
});

// kick off search binding
setupSearch();
