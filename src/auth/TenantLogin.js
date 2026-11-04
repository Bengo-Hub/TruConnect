/**
 * TenantLogin - Sign in to TruConnect with a TruLoad account
 *
 * The user's TruLoad password is checked by the TruLoad backend. On success this device
 * remembers the org and encrypted password, and uses that login for its backend calls.
 * A salted hash is kept in the local users table so the same user can sign in during an
 * outage. With no organization entered, the local accounts work as they always have.
 */

const AuthManager = require('./AuthManager');
const BackendClient = require('../backend/BackendClient');
const CredentialStore = require('../backend/CredentialStore');
const ConfigManager = require('../config/ConfigManager');
const TenantBinding = require('../core/TenantBinding');

const ADMIN_ROLES = ['SUPERUSER', 'SYSTEM_ADMIN', 'STATION_MANAGER', 'COMMERCIAL_MANAGER'];

const roleCode = (role) => String((role && (role.code || role.name)) || role || '').toUpperCase();

function localRoleFor(user) {
  const roles = (user && user.roles) || [];
  return roles.some((role) => ADMIN_ROLES.includes(roleCode(role))) ? 'admin' : 'operator';
}

function rememberLogin({ email, password, orgSlug, environment, rememberMe, orgName }) {
  const previousOrg = ConfigManager.get('tenantBinding.orgSlug', null);
  if (previousOrg && previousOrg !== orgSlug) {
    ConfigManager.set('tenantBinding.stationCode', null);
  }
  TenantBinding.bind(orgSlug);

  ConfigManager.set('tenantLogin.orgSlug', orgSlug);
  ConfigManager.set('tenantLogin.environment', environment);
  ConfigManager.set('tenantLogin.email', email);
  ConfigManager.set('tenantLogin.orgName', orgName || null);
  ConfigManager.set('tenantLogin.remember', rememberMe !== false);

  // A real tenant login replaces any demo setup on this device
  ConfigManager.set('operationMode.isDemoTenant', false);
  ConfigManager.set('backend.enabled', true);
  ConfigManager.set('backend.email', email);

  const stored = CredentialStore.protect(password);
  if (stored) {
    ConfigManager.set('backend.password', stored);
  } else {
    ConfigManager.set('backend.password', '');
  }
}

async function login({ email, password, orgSlug, environment, rememberMe } = {}) {
  const org = String(orgSlug || '').trim().toLowerCase();
  const env = environment === 'test' ? 'test' : 'live';

  if (!org) {
    return AuthManager.login(email, password, rememberMe);
  }
  if (!email || !password) {
    return { success: false, error: 'Email and password are required' };
  }

  const client = BackendClient.getInstance();
  const remote = await client.loginUser({ email, password, orgSlug: org, environment: env });

  if (remote.unreachable) {
    const local = await AuthManager.login(email, password, rememberMe);
    if (local.success) {
      return { ...local, offline: true };
    }
    return {
      success: false,
      error: 'Cannot reach TruLoad. Check the connection. Signing in offline needs one earlier successful sign-in with this password.'
    };
  }

  if (!remote.success) {
    return { success: false, error: remote.error };
  }

  rememberLogin({ email, password, orgSlug: org, environment: env, rememberMe, orgName: remote.orgName });
  client.configure({ enabled: true, email, password });
  client.useSession(remote);

  const saved = AuthManager.saveTenantUser(email, password, localRoleFor(remote.user));
  if (!saved.success) {
    return saved;
  }

  const session = await AuthManager.login(email, password, rememberMe);
  if (session.success) {
    session.user = { ...session.user, orgSlug: org, orgName: remote.orgName || null, stationId: remote.user && remote.user.stationId };
  }
  return session;
}

function logout() {
  if (!ConfigManager.get('tenantLogin.email', null)) return;
  ConfigManager.set('tenantLogin.remember', false);
  ConfigManager.set('backend.password', '');
  BackendClient.getInstance().clearCredentials();
}

/**
 * The login form's saved values. The password is never sent to a page.
 */
function savedLogin() {
  return {
    orgSlug: ConfigManager.get('tenantLogin.orgSlug', null) || ConfigManager.get('tenantBinding.orgSlug', null) || '',
    environment: ConfigManager.get('tenantLogin.environment', 'live'),
    email: ConfigManager.get('tenantLogin.email', null) || '',
    remember: ConfigManager.get('tenantLogin.remember', false) === true
  };
}

/**
 * The remembered user for this start, or null if they have to sign in
 */
function restoredUser() {
  const email = ConfigManager.get('tenantLogin.email', null);
  if (!email || ConfigManager.get('tenantLogin.remember', false) !== true) return null;
  if (!CredentialStore.reveal(ConfigManager.get('backend.password', ''))) return null;
  return {
    email,
    role: 'operator',
    orgSlug: ConfigManager.get('tenantLogin.orgSlug', null),
    orgName: ConfigManager.get('tenantLogin.orgName', null)
  };
}

module.exports = { login, logout, savedLogin, restoredUser };
