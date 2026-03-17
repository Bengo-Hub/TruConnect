/**
 * AuthManager - Authentication and session management
 *
 * Features:
 * - User login/logout
 * - Password hashing with bcryptjs
 * - Session token management
 * - Role-based access control (RBAC)
 *
 * Roles:
 * - admin: Full access (settings, users, protocols)
 * - operator: Dashboard + trigger captures
 * - viewer: Read-only dashboard
 */

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const Database = require('../database/Database');
const EventBus = require('../core/EventBus');
const ConfigManager = require('../config/ConfigManager');

class AuthManager {
  constructor() {
    this.db = null;
    this.sessionTimeout = 86400000; // 24 hours default
    this.rememberMeTimeout = 604800000; // 7 days
  }

  /**
   * Initialize with database connection
   */
  initialize(database) {
    this.db = database;
    this.sessionTimeout = ConfigManager.get('auth.sessionTimeout', this.sessionTimeout);
    this.rememberMeTimeout = ConfigManager.get('auth.rememberMeTimeout', this.rememberMeTimeout);

    // Clean up expired sessions on startup
    this.cleanupExpiredSessions();

    EventBus.emit('auth:initialized');
    return this;
  }

  /**
   * Login with email and password
   * @returns {{ success: boolean, token?: string, user?: object, error?: string }}
   */
  async login(email, password, rememberMe = false) {
    if (!email || !password) {
      return { success: false, error: 'Email and password are required' };
    }

    try {
      // Find user by email
      const user = this.db.get(
        'SELECT id, email, password_hash, role, is_active FROM users WHERE email = ?',
        [email.toLowerCase()]
      );

      if (!user) {
        return { success: false, error: 'Invalid email or password' };
      }

      if (!user.is_active) {
        return { success: false, error: 'Account is disabled' };
      }

      // Verify password
      const isValid = bcrypt.compareSync(password, user.password_hash);
      if (!isValid) {
        return { success: false, error: 'Invalid email or password' };
      }

      // Generate session token
      const token = this.generateToken();
      const expiresAt = new Date(
        Date.now() + (rememberMe ? this.rememberMeTimeout : this.sessionTimeout)
      );

      // Store session
      this.db.run(
        'INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)',
        [user.id, token, expiresAt.toISOString()]
      );

      EventBus.emit('auth:login', { userId: user.id, email: user.email });

      return {
        success: true,
        token,
        user: {
          id: user.id,
          email: user.email,
          role: user.role
        }
      };

    } catch (error) {
      console.error('Login error:', error);
      return { success: false, error: 'Login failed' };
    }
  }

  /**
   * Logout - invalidate session
   */
  async logout(token) {
    if (!token) return { success: false };

    try {
      this.db.run('DELETE FROM sessions WHERE token = ?', [token]);
      EventBus.emit('auth:logout', { token });
      return { success: true };
    } catch (error) {
      console.error('Logout error:', error);
      return { success: false };
    }
  }

  /**
   * Validate token and return user
   */
  validateToken(token) {
    if (!token) return null;

    try {
      const session = this.db.get(
        `SELECT s.*, u.id as user_id, u.email, u.role, u.is_active
         FROM sessions s
         JOIN users u ON s.user_id = u.id
         WHERE s.token = ? AND s.expires_at > datetime('now')`,
        [token]
      );

      if (!session || !session.is_active) {
        return null;
      }

      return {
        id: session.user_id,
        email: session.email,
        role: session.role
      };

    } catch (error) {
      console.error('Token validation error:', error);
      return null;
    }
  }

  /**
   * Check if user has required role
   */
  hasRole(user, requiredRole) {
    if (!user) return false;

    const roleHierarchy = { admin: 3, operator: 2, viewer: 1 };
    const userLevel = roleHierarchy[user.role] || 0;
    const requiredLevel = roleHierarchy[requiredRole] || 0;

    return userLevel >= requiredLevel;
  }

  /**
   * Check if user can access resource
   */
  canAccess(user, resource) {
    if (!user) return false;

    const accessRules = {
      // Public resources
      dashboard: ['viewer', 'operator', 'admin'],
      weights: ['viewer', 'operator', 'admin'],

      // Operator resources
      capture: ['operator', 'admin'],
      plate: ['operator', 'admin'],

      // Admin resources
      settings: ['admin'],
      users: ['admin'],
      devices: ['admin'],
      protocols: ['admin'],
      logs: ['admin']
    };

    const allowedRoles = accessRules[resource];
    if (!allowedRoles) return false;

    return allowedRoles.includes(user.role);
  }

  /**
   * Change user password
   */
  async changePassword(userId, oldPassword, newPassword) {
    if (!newPassword || newPassword.length < 8) {
      return { success: false, error: 'Password must be at least 8 characters' };
    }

    try {
      const user = this.db.get('SELECT password_hash FROM users WHERE id = ?', [userId]);
      if (!user) {
        return { success: false, error: 'User not found' };
      }

      // Verify old password
      if (oldPassword && !bcrypt.compareSync(oldPassword, user.password_hash)) {
        return { success: false, error: 'Current password is incorrect' };
      }

      // Hash new password
      const salt = bcrypt.genSaltSync(10);
      const passwordHash = bcrypt.hashSync(newPassword, salt);

      // Update password
      this.db.run(
        'UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [passwordHash, userId]
      );

      // Invalidate all sessions for this user
      this.db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);

      EventBus.emit('auth:password-changed', { userId });
      return { success: true };

    } catch (error) {
      console.error('Change password error:', error);
      return { success: false, error: 'Failed to change password' };
    }
  }

  /**
   * Create new user (admin only)
   */
  createUser(email, password, role = 'operator') {
    if (!email || !password) {
      return { success: false, error: 'Email and password are required' };
    }

    if (!['admin', 'operator', 'viewer'].includes(role)) {
      return { success: false, error: 'Invalid role' };
    }

    try {
      const existing = this.db.get('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
      if (existing) {
        return { success: false, error: 'Email already exists' };
      }

      const salt = bcrypt.genSaltSync(10);
      const passwordHash = bcrypt.hashSync(password, salt);

      const result = this.db.run(
        'INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)',
        [email.toLowerCase(), passwordHash, role]
      );

      EventBus.emit('auth:user-created', { userId: result.lastInsertRowid, email });

      return {
        success: true,
        user: {
          id: result.lastInsertRowid,
          email: email.toLowerCase(),
          role
        }
      };

    } catch (error) {
      console.error('Create user error:', error);
      return { success: false, error: 'Failed to create user' };
    }
  }

  /**
   * Get all users (without password hash)
   */
  getUsers() {
    return this.db.all(
      'SELECT id, email, role, is_active, created_at, updated_at FROM users ORDER BY email'
    );
  }

  /**
   * Update user role/status
   */
  updateUser(userId, updates) {
    const { role, isActive } = updates;
    const setClauses = [];
    const params = [];

    if (role && ['admin', 'operator', 'viewer'].includes(role)) {
      setClauses.push('role = ?');
      params.push(role);
    }

    if (isActive !== undefined) {
      setClauses.push('is_active = ?');
      params.push(isActive ? 1 : 0);
    }

    if (setClauses.length === 0) {
      return { success: false, error: 'No valid updates provided' };
    }

    setClauses.push('updated_at = CURRENT_TIMESTAMP');
    params.push(userId);

    try {
      this.db.run(
        `UPDATE users SET ${setClauses.join(', ')} WHERE id = ?`,
        params
      );

      return { success: true };
    } catch (error) {
      console.error('Update user error:', error);
      return { success: false, error: 'Failed to update user' };
    }
  }

  /**
   * Delete user
   */
  deleteUser(userId) {
    try {
      // Don't allow deleting the last admin
      const adminCount = this.db.get(
        "SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND is_active = 1"
      );

      const user = this.db.get('SELECT role FROM users WHERE id = ?', [userId]);

      if (user?.role === 'admin' && adminCount?.count <= 1) {
        return { success: false, error: 'Cannot delete the last admin user' };
      }

      this.db.run('DELETE FROM users WHERE id = ?', [userId]);
      EventBus.emit('auth:user-deleted', { userId });

      return { success: true };
    } catch (error) {
      console.error('Delete user error:', error);
      return { success: false, error: 'Failed to delete user' };
    }
  }

  /**
   * Generate secure random token
   */
  generateToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Clean up expired sessions
   */
  cleanupExpiredSessions() {
    try {
      const result = this.db.run("DELETE FROM sessions WHERE expires_at < datetime('now')");
      if (result.changes > 0) {
        console.log(`Cleaned up ${result.changes} expired sessions`);
      }
    } catch (error) {
      console.error('Session cleanup error:', error);
    }
  }

  /**
   * Get session info
   */
  getSessionInfo(token) {
    if (!token) return null;

    return this.db.get(
      'SELECT created_at, expires_at FROM sessions WHERE token = ?',
      [token]
    );
  }
}

// Singleton instance
let instance = null;

module.exports = {
  getInstance() {
    if (!instance) {
      instance = new AuthManager();
    }
    return instance;
  },

  initialize(database) {
    return this.getInstance().initialize(database);
  },

  login(email, password, rememberMe) {
    return this.getInstance().login(email, password, rememberMe);
  },

  logout(token) {
    return this.getInstance().logout(token);
  },

  validateToken(token) {
    return this.getInstance().validateToken(token);
  },

  hasRole(user, role) {
    return this.getInstance().hasRole(user, role);
  },

  canAccess(user, resource) {
    return this.getInstance().canAccess(user, resource);
  },

  AuthManager
};
