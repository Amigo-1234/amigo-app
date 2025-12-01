import { gsap } from "gsap";

/* ---------- tiny DOM helpers ---------- */
const qs  = (s, r = document) => r.querySelector(s);
const qsa = (s, r = document) => Array.from(r.querySelectorAll(s));

const pages      = qsa(".page");
const navBtns    = qsa(".bottom-nav .nav-btn");
const floatLayer = qs(".float-emoji-layer");

/* ---------- floating emojis ---------- */
const EMOJIS = ["❤️","😂","🤯","😭","🔥","✨","🌈","⚡️","🍭","🎧","🎮","🐣","🫶","💥"];

function spawnEmojis () {
  if (!floatLayer) return;
  for (let i = 0; i < 18; i++) {
    const span = document.createElement("span");
    span.className = "float-emoji";
    span.textContent = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
    span.style.left = `${Math.random() * 100}%`;
    span.style.top  = `${Math.random() * 100}%`;
    span.style.animationDelay = `${Math.random() * 2}s`;
    floatLayer.appendChild(span);
  }
}
spawnEmojis();

/* ---------- navigation ---------- */
let currentUser = null;

function showPage (id) {
  const protectedPages = ["home", "tasks", "chat", "profile"];

  if (!currentUser && protectedPages.includes(id)) {
    id = "auth";
  }

  pages.forEach(p => p.classList.toggle("active", p.id === id));
  navBtns.forEach(b => b.classList.toggle("active", b.dataset.nav === id));

  gsap.fromTo(".brand-title", { scale: 1 }, {
    scale: 1.06,
    duration: 0.25,
    yoyo: true,
    repeat: 1
  });
}

navBtns.forEach(btn => {
  btn.addEventListener("click", () => showPage(btn.dataset.nav));
});

qsa("[data-nav]").forEach(el => {
  el.addEventListener("click", () => showPage(el.dataset.nav));
});

/* ---------- Firebase setup ---------- */
import {
  initializeApp
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";

import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  updateProfile
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";

import {
  getFirestore,
  collection,
  addDoc,
  serverTimestamp,
  query,
  orderBy,
  onSnapshot,
  doc,
  updateDoc,
  increment,
  arrayUnion
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyA7LCr6HouDusvM0Yot261PvLidOCvG0oY",
  authDomain: "amigo-world-ebfab.firebaseapp.com",
  projectId: "amigo-world-ebfab",
  storageBucket: "amigo-world-ebfab.firebasestorage.app",
  messagingSenderId: "1071245255296",
  appId: "1:1071245255296:web:b090d0bb080402a01a3c65"
};

const fbApp = initializeApp(firebaseConfig);
const auth  = getAuth(fbApp);
const db    = getFirestore(fbApp);

/* ---------- helpers ---------- */
function usernameFromUser (user) {
  if (!user) return "amigo_user";
  if (user.displayName) return user.displayName;
  if (user.email) return user.email.split("@")[0];
  return "amigo_user";
}

function escapeHTML (str = "") {
  return str.replace(/[&<>"']/g, m => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[m]));
}

function categoryLabel (cat) {
  switch (cat) {
    case "trends": return "🔥 Trends";
    case "memes":  return "😂 Memes";
    case "music":  return "🎵 Music";
    case "videos": return "🎬 Videos";
    case "audio":  return "🎤 Audio";
    case "comics": return "🎨 Comics";
    case "chats":  return "💬 Chats";
    default:       return cat;
  }
}

function readFileAsDataURL (file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ---------- auth UI refs ---------- */
const loginEmail    = qs("#login-email");
const loginPassword = qs("#login-password");
const loginBtn      = qs("#login-btn");
const signupBtn     = qs("#go-signup");
const logoutBtn     = qs("#logout-btn");

const profileName  = qs("#profile-name");
const profileEmail = qs("#profile-email");
const profileMood  = qs("#profile-mood");
const profileBioEl = qs("#profile-bio");

const chatUsername = qs("#chat-username");

const editProfileBtn = qs("#edit-profile-btn");
const switchMoodBtn  = qs("#switch-mood-btn");

/* ---------- login / signup ---------- */
loginBtn?.addEventListener("click", async () => {
  try {
    await signInWithEmailAndPassword(auth, loginEmail.value.trim(), loginPassword.value.trim());
  } catch (err) {
    alert(err.message);
  }
});

signupBtn?.addEventListener("click", async () => {
  const email = loginEmail.value.trim();
  const pass  = loginPassword.value.trim();
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, pass);
    await updateProfile(cred.user, { displayName: email.split("@")[0] });
  } catch (err) {
    alert(err.message);
  }
});

logoutBtn?.addEventListener("click", async () => {
  try { await signOut(auth); } catch {}
});

/* ---------- XP / Tasks ---------- */
let xp = 0;
let level = 1;
let streak = 0;

const XP_PER_LEVEL = 100;
const TASKS = [
  { emoji: "💧", text: "Drink water & stop being dusty", xp: 10 },
  { emoji: "🔥", text: "Pray before scrolling", xp: 15 },
  { emoji: "👀", text: "Study small, your future dey look you", xp: 20 },
  { emoji: "❤️", text: "Text someone nice today", xp: 10 }
];

const xpFill        = qs("#xp-fill");
const xpText        = qs("#xp-text");
const levelBadge    = qs("#level-badge");
const streakDisplay = qs("#streak-display");

const profileLevel  = qs("#profile-level");
const profileXP     = qs("#profile-xp");
const profileStreak = qs("#profile-streak");

function updateXPUI () {
  const currentXP = xp % XP_PER_LEVEL;
  const pct = (currentXP / XP_PER_LEVEL) * 100;

  xpFill.style.width = pct + "%";
  xpText.textContent = `${currentXP} / ${XP_PER_LEVEL} XP`;
  levelBadge.textContent = `Lv. ${level}`;
  streakDisplay.textContent = `🔥 x${streak}`;

  profileLevel.textContent = level;
  profileXP.textContent = xp;
  profileStreak.textContent = `🔥 x${streak}`;
}

function loadTasks () {
  const list = qs("#task-list");
  list.innerHTML = "";
  TASKS.forEach(t => {
    const div = document.createElement("div");
    div.className = "task-card";
    div.innerHTML = `
      <div class="t-left">
        <span class="t-emoji">${t.emoji}</span>
        <span class="t-text">${t.text}</span>
      </div>
      <button class="glow-btn mini task-done-btn" data-xp="${t.xp}">+${t.xp}XP</button>
    `;
    list.appendChild(div);
  });
}

qs("#task-list")?.addEventListener("click", e => {
  const btn = e.target.closest(".task-done-btn");
  if (!btn) return;
  xp += parseInt(btn.dataset.xp);
  streak++;
  if (xp >= level * XP_PER_LEVEL) level++;
  btn.disabled = true;
  btn.textContent = "Done";
  updateXPUI();
});

/* ---------- Profile ---------- */
const MOODS = ["Bubble Electric", "Soft Focus", "Chaos Sunny", "Study Mode", "Calm Night"];
let moodIndex = 0;

switchMoodBtn?.addEventListener("click", () => {
  moodIndex = (moodIndex + 1) % MOODS.length;
  profileMood.textContent = MOODS[moodIndex];
});

function loadLocalBio(user) {
  const raw = localStorage.getItem("bio_" + user.uid);
  if (raw) profileBioEl.textContent = raw;
}

function saveLocalBio(user, bio) {
  localStorage.setItem("bio_" + user.uid, bio);
}

editProfileBtn?.addEventListener("click", async () => {
  if (!currentUser) return;

  const newName = prompt("Change username", usernameFromUser(currentUser));
  const newBio  = prompt("Write bio", profileBioEl.textContent);

  if (newName) await updateProfile(currentUser, { displayName: newName });
  if (newBio) {
    profileBioEl.textContent = newBio;
    saveLocalBio(currentUser, newBio);
  }
});

/* ---------- FEED / POSTS ---------- */
const postText     = qs("#post-text");
const postCategory = qs("#post-category");
const postBtn      = qs("#post-btn");
const postImage    = qs("#post-image");
const feedList     = qs("#feed-list");

const profilePostsList  = qs("#profile-posts-list");
const profilePostsEmpty = qs("#profile-posts-empty");

let activeTab  = "trends";
let postsCache = [];

postBtn?.addEventListener("click", async () => {
  if (!currentUser) return;

  const text = postText.value.trim();
  const category = postCategory.value;
  const file = postImage.files[0];

  if (!text && !file) return;

  let imageDataUrl = null;
  if (file) imageDataUrl = await readFileAsDataURL(file);

  await addDoc(collection(db, "posts"), {
    text,
    category,
    authorId: currentUser.uid,
    authorName: usernameFromUser(currentUser),
    createdAt: serverTimestamp(),
    reactions: { heart:0, lol:0, wow:0, cry:0, fire:0 },
    reacted: {},
    commentsCount: 0,
    imageDataUrl
  });

  postText.value = "";
  postImage.value = "";
  postCategory.value = "trends";
});

qsa(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    qsa(".tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    activeTab = tab.dataset.tab;
    renderFeed();
  });
});

function renderFeed () {
  feedList.innerHTML = "";

  let items = postsCache.filter(p => p.category === activeTab);

  if (!items.length) {
    feedList.innerHTML = `<p class="empty-hint">No chaos yet 🌀</p>`;
    return;
  }

  items.forEach(post => {
    const card = document.createElement("article");
    card.className = "holo-card";

    const createdAt = post.createdAt?.toDate?.() || new Date();
    const timeStr = createdAt.toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });

    const img = post.imageDataUrl
      ? `<div class="card-media"><img src="${post.imageDataUrl}" class="post-image"></div>`
      : "";

    card.innerHTML = `
      <div class="meta">
        <span>@${escapeHTML(post.authorName)}</span>
        <span>${categoryLabel(post.category)}</span>
      </div>

      <p>${escapeHTML(post.text)}</p>
      ${img}

      <div class="meta small">${timeStr}</div>

      <div class="reactions" data-post-id="${post.id}">
        <button class="reaction-btn" data-type="heart">❤️ ${post.reactions.heart}</button>
        <button class="reaction-btn" data-type="lol">😂 ${post.reactions.lol}</button>
        <button class="reaction-btn" data-type="wow">🤯 ${post.reactions.wow}</button>
        <button class="reaction-btn" data-type="cry">😭 ${post.reactions.cry}</button>
        <button class="reaction-btn" data-type="fire">🔥 ${post.reactions.fire}</button>
      </div>

      <button class="comment-toggle" data-post-id="${post.id}">
        💬 Comments (${post.commentsCount})
      </button>

      <div class="comments-panel" data-post-id="${post.id}" style="display:none;">
        <div class="comments-list"></div>
        <div class="comments-input-row">
          <input type="text" placeholder="Drop a comment...">
          <button class="comment-send-btn">Send</button>
        </div>
      </div>
    `;

    feedList.appendChild(card);
  });

  renderProfilePosts();
}

/* ---------- Profile Posts ---------- */
function renderProfilePosts () {
  if (!currentUser) {
    profilePostsEmpty.style.display = "block";
    profilePostsList.innerHTML = "";
    return;
  }

  const mine = postsCache.filter(p => p.authorId === currentUser.uid);

  if (!mine.length) {
    profilePostsEmpty.style.display = "block";
    profilePostsList.innerHTML = "";
    return;
  }

  profilePostsEmpty.style.display = "none";
  profilePostsList.innerHTML = "";

  mine.forEach(p => {
    const createdAt = p.createdAt?.toDate?.() || new Date();
    const timeStr = createdAt.toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });

    const li = document.createElement("li");
    li.className = "profile-post-row";
    li.innerHTML = `
      <div class="profile-post-main">
        <div class="profile-post-text">${escapeHTML(p.text)}</div>
        <div class="profile-post-meta">
          <span>${categoryLabel(p.category)}</span>
          <span>${timeStr}</span>
        </div>
      </div>
    `;
    profilePostsList.appendChild(li);
  });
}

/* ---------- reactions ---------- */
async function handleReaction (postId, type) {
  const post = postsCache.find(p => p.id === postId);
  if (!post || !currentUser) return;

  const reacted = post.reacted?.[type] || [];

  if (reacted.includes(currentUser.uid)) return;

  await updateDoc(doc(db, "posts", postId), {
    [`reactions.${type}`]: increment(1),
    [`reacted.${type}`]: arrayUnion(currentUser.uid)
  });
}

feedList?.addEventListener("click", async e => {
  const btn = e.target.closest(".reaction-btn");
  if (btn) {
    await handleReaction(btn.closest(".reactions").dataset.postId, btn.dataset.type);
    return;
  }

  const toggle = e.target.closest(".comment-toggle");
  if (toggle) {
    const postId = toggle.dataset.postId;
    const panel = qs(`.comments-panel[data-post-id="${postId}"]`);
    panel.style.display = panel.style.display === "block" ? "none" : "block";
    if (panel.style.display === "block") loadComments(postId, panel);
    return;
  }

  const sendBtn = e.target.closest(".comment-send-btn");
  if (sendBtn) {
    const panel = sendBtn.closest(".comments-panel");
    const postId = panel.dataset.postId;
    const input = qs("input", panel);
    const text = input.value.trim();
    if (!text) return;

    await addDoc(collection(db, "posts", postId, "comments"), {
      text,
      authorId: currentUser.uid,
      authorName: usernameFromUser(currentUser),
      createdAt: serverTimestamp()
    });

    await updateDoc(doc(db, "posts", postId), {
      commentsCount: increment(1)
    });

    input.value = "";
  }
});

/* ---------- comments loader ---------- */
function loadComments (postId, panel) {
  const list = qs(".comments-list", panel);
  list.innerHTML = "Loading...";

  const q2 = query(
    collection(db, "posts", postId, "comments"),
    orderBy("createdAt", "asc")
  );

  onSnapshot(q2, snap => {
    list.innerHTML = "";
    snap.forEach(docSnap => {
      const c = docSnap.data();
      const createdAt = c.createdAt?.toDate?.() || new Date();
      const timeStr = createdAt.toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });
      const div = document.createElement("div");
      div.className = "comment";
      div.innerHTML = `
        <b>@${escapeHTML(c.authorName)}</b>
        <span>${escapeHTML(c.text)}</span>
        <small>${timeStr}</small>
      `;
      list.appendChild(div);
    });
  });
}

/* ---------- live feed listener ---------- */
onSnapshot(
  query(collection(db, "posts"), orderBy("createdAt", "desc")),
  snap => {
    postsCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderFeed();
  }
);

/* ---------- global chat ---------- */
const chatWindow  = qs("#chat-window");
const chatInput   = qs("#chat-input");
const chatSendBtn = qs("#chat-send-btn");

onSnapshot(
  query(collection(db, "globalChat"), orderBy("createdAt", "asc")),
  snap => {
    chatWindow.innerHTML = "";
    snap.forEach(docSnap => {
      const m = docSnap.data();
      const me = currentUser && m.authorId === currentUser.uid;

      const div = document.createElement("div");
      div.className = "message " + (me ? "me" : "other");

      const createdAt = m.createdAt?.toDate?.() || new Date();
      const timeStr = createdAt.toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });

      div.innerHTML = `
        <div class="bubble">
          <strong>@${escapeHTML(m.authorName)}</strong> ${escapeHTML(m.text)}
          <br><span class="time">${timeStr}</span>
        </div>
      `;
      chatWindow.appendChild(div);
    });

    chatWindow.scrollTop = chatWindow.scrollHeight;
  }
);

chatSendBtn?.addEventListener("click", sendChatMessage);
chatInput?.addEventListener("keydown", e => {
  if (e.key === "Enter") {
    e.preventDefault();
    sendChatMessage();
  }
});

async function sendChatMessage() {
  if (!currentUser) return;
  const text = chatInput.value.trim();
  if (!text) return;

  await addDoc(collection(db, "globalChat"), {
    text,
    authorId: currentUser.uid,
    authorName: usernameFromUser(currentUser),
    createdAt: serverTimestamp()
  });

  chatInput.value = "";
}

/* ---------- Image Viewer ---------- */
const viewer         = qs("#image-viewer");
const viewerImg      = qs("#image-viewer-img");
const viewerClose    = qs("#image-viewer-close");
const viewerBackdrop = qs(".image-viewer-backdrop");

document.addEventListener("click", e => {
  const img = e.target.closest(".post-image");
  if (!img) return;
  viewerImg.src = img.src;
  viewer.classList.add("show");
});

[viewerClose, viewerBackdrop].forEach(el => {
  el?.addEventListener("click", () => {
    viewer.classList.remove("show");
  });
});

/* ---------- auth state ---------- */
onAuthStateChanged(auth, user => {
  currentUser = user;

  if (user) {
    profileName.textContent  = "@" + usernameFromUser(user);
    profileEmail.textContent = user.email;
    chatUsername.textContent = "@" + usernameFromUser(user);
    profileMood.textContent  = MOODS[moodIndex];

    loadLocalBio(user);
    loadTasks();
    updateXPUI();

    showPage("home");
  } else {
    profileName.textContent = "@amigo_user";
    profileEmail.textContent = "you@vibes.com";
    profileBioEl.textContent = "No bio yet.";
    showPage("landing");
  }
});

/* ---------- start ---------- */
showPage("landing");

