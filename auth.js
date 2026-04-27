// PromptLens Auth Module
// Uses chrome.identity + Firebase Auth REST API
// No Firebase SDK needed — pure REST calls

const FIREBASE_API_KEY = "AIzaSyCQpfo6qQZ7YzDlJt5NZqUAnAW4UKq2v4M";
const FIREBASE_PROJECT = "promptlens-ae5f3";
const AUTH_TOKEN_TIMEOUT_MS = 15000;

function getExtensionId() {
  return chrome?.runtime?.id || "unknown";
}

function getManifestClientId() {
  return chrome?.runtime?.getManifest?.()?.oauth2?.client_id || "missing";
}

function logOAuthSetupHelp(reason) {
  try {
    console.groupCollapsed("PromptLens: Google OAuth setup needed");
    if (reason) console.log("Reason:", reason);
    console.log("Extension ID:", getExtensionId());
    console.log("manifest oauth2.client_id:", getManifestClientId());
    console.log("Fix:");
    console.log("1) Open chrome://extensions and copy your Extension ID (Developer mode).");
    console.log("2) In Google Cloud Console -> APIs & Services -> Credentials:");
    console.log("   Create OAuth client ID -> Application type: Chrome Extension (or Chrome App in older consoles).");
    console.log("   Set the Application ID / Item ID to the Extension ID above.");
    console.log("3) Replace oauth2.client_id in manifest.json with the new Client ID.");
    console.log("4) Reload the extension.");
    console.groupEnd();
  } catch (_) {
    // Ignore logging failures.
  }
}

function formatChromeIdentityErrorMessage(rawMessage) {
  const message = String(rawMessage || "");
  if (/bad client id/i.test(message) || /invalid client/i.test(message)) {
    logOAuthSetupHelp(message);
    return `Google OAuth client_id is invalid for this extension. Create a Chrome App OAuth client for extension ID ${getExtensionId()} and update manifest.json oauth2.client_id.`;
  }
  if (/user did not approve/i.test(message) || /canceled/i.test(message)) {
    return "Sign-in canceled.";
  }
  return message || "Auth failed";
}

function getAuthTokenWithTimeout({ interactive = true, timeoutMs = AUTH_TOKEN_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      reject(new Error("Google sign-in timed out. Please try again."));
    }, timeoutMs);

    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      if (chrome.runtime.lastError || !token) {
        const msg = formatChromeIdentityErrorMessage(chrome.runtime.lastError?.message);
        reject(new Error(msg));
        return;
      }
      resolve(token);
    });
  });
}

// ── Sign in with Google via chrome.identity ───────────────────────────────────
async function signInWithGoogle() {
  const token = await getAuthTokenWithTimeout({ interactive: true });
  // Exchange Google token for Firebase ID token
  const firebaseUser = await exchangeTokenWithFirebase(token);
  // Store user info
  await chrome.storage.local.set({ plUser: firebaseUser });
  return firebaseUser;
}

// ── Exchange Google OAuth token with Firebase ─────────────────────────────────
async function exchangeTokenWithFirebase(googleToken) {
  const resp = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${FIREBASE_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        postBody: `access_token=${googleToken}&providerId=google.com`,
        requestUri: "https://promptlens-ae5f3.firebaseapp.com/__/auth/handler",
        returnIdpCredential: true,
        returnSecureToken: true
      })
    }
  );

  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(err?.error?.message || "Firebase auth failed");
  }

  const data = await resp.json();
  return {
    uid: data.localId,
    email: data.email,
    displayName: data.displayName || data.email,
    photoURL: data.photoUrl || null,
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    tokenExpiry: Date.now() + (parseInt(data.expiresIn) * 1000)
  };
}

// ── Refresh token if expired ──────────────────────────────────────────────────
async function getValidIdToken() {
  const { plUser } = await chrome.storage.local.get("plUser");
  if (!plUser) return null;

  // If token still valid (with 5min buffer), return it
  if (plUser.tokenExpiry && Date.now() < plUser.tokenExpiry - 300000) {
    return plUser.idToken;
  }

  // Refresh the token
  try {
    const resp = await fetch(
      `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: plUser.refreshToken
        })
      }
    );
    if (!resp.ok) throw new Error("Token refresh failed");
    const data = await resp.json();
    const updated = {
      ...plUser,
      idToken: data.id_token,
      refreshToken: data.refresh_token,
      tokenExpiry: Date.now() + (parseInt(data.expires_in) * 1000)
    };
    await chrome.storage.local.set({ plUser: updated });
    return updated.idToken;
  } catch {
    // Token refresh failed — user needs to re-login
    await chrome.storage.local.remove("plUser");
    return null;
  }
}

// ── Sign out ──────────────────────────────────────────────────────────────────
async function signOut() {
  return new Promise((resolve) => {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (token) chrome.identity.removeCachedAuthToken({ token });
      chrome.storage.local.remove("plUser", resolve);
    });
  });
}

// ── Firestore REST helpers ────────────────────────────────────────────────────
async function firestoreWrite(collection, docId, data, idToken) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${collection}/${docId}`;
  const body = { fields: toFirestoreFields(data) };

  const resp = await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${idToken}`
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err?.error?.message || "Firestore write failed");
  }
  return resp.json();
}

async function firestoreAdd(collection, data, idToken) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${collection}`;
  const body = { fields: toFirestoreFields(data) };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${idToken}`
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err?.error?.message || "Firestore add failed");
  }
  return resp.json();
}

async function firestoreQuery(collection, idToken) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${collection}?orderBy=timestamp+desc&pageSize=100`;
  const resp = await fetch(url, {
    headers: { "Authorization": `Bearer ${idToken}` }
  });
  if (!resp.ok) return [];
  const data = await resp.json();
  return (data.documents || []).map(doc => fromFirestoreFields(doc.fields, doc.name));
}

// ── Firestore type converters ─────────────────────────────────────────────────
function toFirestoreFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string")  fields[k] = { stringValue: v };
    else if (typeof v === "number") fields[k] = { integerValue: String(Math.round(v)) };
    else if (typeof v === "boolean") fields[k] = { booleanValue: v };
    else if (typeof v === "object") fields[k] = { stringValue: JSON.stringify(v) };
  }
  return fields;
}

function fromFirestoreFields(fields, name) {
  if (!fields) return {};
  const obj = { _id: name?.split("/").pop() };
  for (const [k, v] of Object.entries(fields)) {
    if (v.stringValue !== undefined) obj[k] = v.stringValue;
    else if (v.integerValue !== undefined) obj[k] = parseInt(v.integerValue);
    else if (v.booleanValue !== undefined) obj[k] = v.booleanValue;
  }
  return obj;
}
