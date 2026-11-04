/**
 * CredentialStore - Encrypts the backend password at rest
 *
 * Uses Electron safeStorage, which on Windows is tied to the signed-in user through
 * DPAPI. A password is never written in plain text: if encryption is unavailable, it
 * is kept in memory for this run only and has to be entered again next time.
 */

const PREFIX = 'enc:v1:';

let encryption = null;

function getEncryption() {
  if (encryption) return encryption;
  try {
    const { safeStorage } = require('electron');
    return safeStorage && safeStorage.isEncryptionAvailable() ? safeStorage : null;
  } catch (error) {
    return null;
  }
}

/**
 * Value to store for a password, or null when it cannot be stored safely
 */
function protect(password) {
  if (!password) return null;
  if (password.startsWith(PREFIX)) return password;

  const store = getEncryption();
  if (!store) {
    console.warn('[CredentialStore] Encryption unavailable, so the password will not be saved');
    return null;
  }
  return PREFIX + store.encryptString(password).toString('base64');
}

/**
 * Password from a stored value. Values saved by older versions are in plain text.
 */
function reveal(stored) {
  if (!stored) return '';
  if (!stored.startsWith(PREFIX)) return stored;

  const store = getEncryption();
  if (!store) return '';
  try {
    return store.decryptString(Buffer.from(stored.slice(PREFIX.length), 'base64'));
  } catch (error) {
    // Encrypted by another Windows user or machine, so the user has to log in again
    console.warn('[CredentialStore] Could not decrypt the saved password');
    return '';
  }
}

function isProtected(stored) {
  return Boolean(stored) && stored.startsWith(PREFIX);
}

// Tests run outside Electron, where safeStorage does not exist
function setEncryptionForTests(store) {
  encryption = store;
}

module.exports = { protect, reveal, isProtected, setEncryptionForTests };
