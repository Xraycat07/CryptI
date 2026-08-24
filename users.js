// Registered Luno-tab accounts (created on first Google sign-in) and their
// own Luno API credentials, so each person trades their own Luno account
// instead of everyone sharing the server's env-var keys. Same on-disk JSON
// pattern as history.js/luno-bot.js — no database.
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");

async function loadUsers() {
  try {
    return JSON.parse(await fs.readFile(USERS_FILE, "utf8"));
  } catch {
    return [];
  }
}

async function saveUsers(users) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
}

// AES-256-GCM, key derived from CREDENTIAL_ENCRYPTION_KEY (any string) with
// a fixed salt — the env var itself is the actual secret/entropy, same
// approach as deriving a key from a passphrase. Never logged, never sent
// back to the frontend.
function getEncryptionKey() {
  const passphrase = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!passphrase) return null;
  return crypto.scryptSync(passphrase, "luno-user-creds", 32);
}

function encryptSecret(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decryptSecret(payload, key) {
  const [ivHex, authTagHex, dataHex] = payload.split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
}

async function getUsers() {
  return loadUsers();
}

async function findOrCreateUser(email) {
  const users = await loadUsers();
  let user = users.find((u) => u.email === email);
  if (user) return user;
  user = { id: `u_${crypto.randomBytes(8).toString("hex")}`, email, createdAt: Date.now(), luno: null };
  users.push(user);
  await saveUsers(users);
  return user;
}

async function getUserById(id) {
  const users = await loadUsers();
  return users.find((u) => u.id === id) || null;
}

// Returns { keyId, secret } (decrypted) or null if this user hasn't saved
// Luno keys yet, or the encryption key is missing/wrong (treated the same
// as "not configured" rather than throwing, so a bad decrypt just prompts
// the user to re-enter their keys instead of crashing the request).
async function getUserCredentials(id) {
  const user = await getUserById(id);
  if (!user || !user.luno) return null;
  const key = getEncryptionKey();
  if (!key) return null;
  try {
    return { keyId: user.luno.keyId, secret: decryptSecret(user.luno.secretEncrypted, key) };
  } catch {
    return null;
  }
}

async function setUserLunoKeys(id, { keyId, secret }) {
  const key = getEncryptionKey();
  if (!key) {
    const err = new Error("CREDENTIAL_ENCRYPTION_KEY is not configured on the server");
    err.status = 500;
    throw err;
  }
  const users = await loadUsers();
  const user = users.find((u) => u.id === id);
  if (!user) {
    const err = new Error("User not found");
    err.status = 404;
    throw err;
  }
  user.luno = { keyId, secretEncrypted: encryptSecret(secret, key) };
  await saveUsers(users);
  return user;
}

async function clearUserLunoKeys(id) {
  const users = await loadUsers();
  const user = users.find((u) => u.id === id);
  if (!user) {
    const err = new Error("User not found");
    err.status = 404;
    throw err;
  }
  user.luno = null;
  await saveUsers(users);
  return user;
}

module.exports = { getUsers, findOrCreateUser, getUserById, getUserCredentials, setUserLunoKeys, clearUserLunoKeys };
