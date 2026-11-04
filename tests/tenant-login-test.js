/**
 * tenant-login-test.js - Signing in to TruConnect with a TruLoad account
 *
 * Uses the real TenantLogin, BackendClient and CredentialStore with a stubbed network
 * and local user table, and a reversible stand-in for Electron's safeStorage.
 */

const CredentialStore = require('../src/backend/CredentialStore');
const ConfigManager = require('../src/config/ConfigManager');
const BackendClient = require('../src/backend/BackendClient');
const AuthManager = require('../src/auth/AuthManager');
const TenantLogin = require('../src/auth/TenantLogin');

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${message}`);
  }
}

CredentialStore.setEncryptionForTests({
  encryptString: (text) => Buffer.from(text.split('').reverse().join('')),
  decryptString: (buffer) => buffer.toString().split('').reverse().join('')
});

const requests = [];
let respond = null;
global.fetch = async (url, options = {}) => {
  requests.push({ url, options });
  return respond(url, options);
};
const json = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

const localUsers = new Map();
AuthManager.saveTenantUser = (email, password, role) => {
  localUsers.set(email, { password, role });
  return { success: true };
};
AuthManager.login = async (email, password) => {
  const user = localUsers.get(email);
  if (!user || user.password !== password) return { success: false, error: 'Invalid email or password' };
  return { success: true, token: 't', user: { id: 1, email, role: user.role } };
};

const client = BackendClient.getInstance();
client.config.baseUrl = 'https://backend.test';
client.config.authEndpoint = '/api/v1/auth/login';
ConfigManager.set('operationMode.isDemoTenant', true, false);
ConfigManager.set('backend.email', 'admin@demo.test', false);

const goodLogin = (url) => (url.includes('/organizations/current')
  ? json(200, { code: 'KURA', name: 'Kenya Urban Roads Authority' })
  : json(200, { accessToken: 'token-1', refreshToken: 'r', expiresIn: 3600, user: { email: 'op@kura.test', stationId: 's1', roles: ['WEIGHING_OPERATOR'] } }));

(async () => {
  // ── Encryption ──────────────────────────────────────────────────────────────

  const stored = CredentialStore.protect('s3cret');
  assert(stored.startsWith('enc:v1:') && !stored.includes('s3cret'), 'password is not stored in plain text');
  assert(CredentialStore.reveal(stored) === 's3cret', 'stored password can be read back');
  assert(CredentialStore.reveal('legacy-plain') === 'legacy-plain', 'older plain text values can still be read');
  assert(CredentialStore.protect(stored) === stored, 'a stored value is not encrypted twice');

  // ── Wrong password ──────────────────────────────────────────────────────────

  respond = () => json(401, { message: 'Invalid email or password' });
  let result = await TenantLogin.login({ email: 'op@kura.test', password: 'bad', orgSlug: 'KURA', environment: 'live' });
  assert(result.success === false && /Invalid/.test(result.error), 'wrong password is refused with the backend message');
  assert(ConfigManager.get('backend.email') === 'admin@demo.test', 'a failed login changes nothing on the device');
  assert(ConfigManager.get('operationMode.isDemoTenant') === true, 'a failed login leaves demo mode alone');
  assert(requests[0].options.headers['X-Org-Slug'] === 'kura', 'login names the org so the right database is used');
  assert(requests[0].options.headers['X-Env'] === 'live', 'login names the environment');

  // ── First login ─────────────────────────────────────────────────────────────

  requests.length = 0;
  respond = goodLogin;
  result = await TenantLogin.login({ email: 'op@kura.test', password: 'pw-1', orgSlug: 'Kura', environment: 'test', rememberMe: true });
  assert(result.success === true, 'correct TruLoad password signs in');
  assert(result.user.orgSlug === 'kura' && result.user.orgName === 'Kenya Urban Roads Authority', 'tenant org comes back with the user');
  assert(requests[0].options.headers['X-Env'] === 'test', 'test environment is sent');
  assert(ConfigManager.get('operationMode.isDemoTenant') === false, 'tenant login turns demo mode off');
  assert(ConfigManager.get('backend.enabled') === true, 'tenant login turns backend integration on');
  assert(ConfigManager.get('backend.email') === 'op@kura.test', 'backend calls now use this user');
  assert(ConfigManager.get('tenantBinding.orgSlug') === 'kura', 'device is bound to the org');
  const savedPassword = ConfigManager.get('backend.password');
  assert(CredentialStore.isProtected(savedPassword) && CredentialStore.reveal(savedPassword) === 'pw-1', 'password is saved encrypted');
  assert(client.auth.accessToken === 'token-1', 'the login token is used straight away');

  // ── Later backend calls carry the tenant ────────────────────────────────────

  requests.length = 0;
  respond = () => json(200, {});
  await client._fetch('https://backend.test/api/v1/Stations', { headers: { Authorization: 'Bearer x' } });
  const later = requests[0].options.headers;
  assert(later['X-Org-Slug'] === 'kura' && later['X-Env'] === 'test', 'later backend calls keep the org and environment');
  assert(later.Authorization === 'Bearer x', 'later calls keep their own headers');

  // ── What the login screen and next start see ────────────────────────────────

  const saved = TenantLogin.savedLogin();
  assert(saved.orgSlug === 'kura' && saved.environment === 'test' && saved.email === 'op@kura.test', 'login screen remembers org, environment and email');
  assert(!JSON.stringify(saved).includes('pw-1') && !('password' in saved), 'the password is never given to the login screen');
  assert(TenantLogin.restoredUser().email === 'op@kura.test', 'remembered user is restored on the next start');

  // ── Outage ──────────────────────────────────────────────────────────────────

  respond = () => { throw new Error('getaddrinfo ENOTFOUND'); };
  result = await TenantLogin.login({ email: 'op@kura.test', password: 'pw-1', orgSlug: 'kura', environment: 'test' });
  assert(result.success === true && result.offline === true, 'last good password works during an outage');
  result = await TenantLogin.login({ email: 'op@kura.test', password: 'wrong', orgSlug: 'kura', environment: 'test' });
  assert(result.success === false, 'wrong password is refused during an outage');
  result = await TenantLogin.login({ email: 'new@kura.test', password: 'pw', orgSlug: 'kura', environment: 'test' });
  assert(result.success === false && /earlier successful/.test(result.error), 'a user never signed in here cannot sign in offline');

  // ── Two-factor ──────────────────────────────────────────────────────────────

  respond = () => json(200, { requires2FA: true, twoFactorToken: 'x' });
  result = await TenantLogin.login({ email: 'op@kura.test', password: 'pw-1', orgSlug: 'kura', environment: 'test' });
  assert(result.success === false && /two-factor/i.test(result.error), 'an account needing two-factor gets a clear message');

  // ── Local accounts ──────────────────────────────────────────────────────────

  requests.length = 0;
  localUsers.set('admin@local', { password: 'local', role: 'admin' });
  result = await TenantLogin.login({ email: 'admin@local', password: 'local' });
  assert(result.success === true && requests.length === 0, 'with no org, local accounts work without calling the backend');

  // ── Parallel authentication shares one request ──────────────────────────────

  requests.length = 0;
  respond = () => json(200, { accessToken: 'shared', refreshToken: 'r', expiresIn: 3600 });
  client.config.email = 'op@kura.test';
  client.config.password = 'pw-1';
  await Promise.all([client.authenticate(), client.authenticate(), client.authenticate()]);
  assert(requests.length === 1, `parallel logins send one request (sent ${requests.length})`);
  assert(client.auth.accessToken === 'shared', 'parallel logins all get the token');

  // ── Logout ──────────────────────────────────────────────────────────────────

  TenantLogin.logout();
  assert(ConfigManager.get('backend.password') === '', 'logout removes the saved password');
  assert(TenantLogin.restoredUser() === null, 'after logout the user has to sign in again');
  assert(client.auth.accessToken === null, 'logout drops the backend token');
  assert(TenantLogin.savedLogin().orgSlug === 'kura', 'logout keeps the org for the next sign-in');

  console.log('\nAll tenant login tests complete.');
  process.exit();
})();
