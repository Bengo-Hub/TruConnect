/**
 * AuthMiddleware - Route protection and RBAC middleware
 *
 * Provides Express middleware for API authentication
 * and IPC handler protection for Electron.
 */

const AuthManager = require('./AuthManager');

/**
 * Express middleware for API authentication
 */
function apiAuth(req, res, next) {
  const token = extractToken(req);

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required'
    });
  }

  const user = AuthManager.validateToken(token);

  if (!user) {
    return res.status(401).json({
      success: false,
      error: 'Invalid or expired token'
    });
  }

  // Attach user to request
  req.user = user;
  next();
}

/**
 * Express middleware for role-based access
 */
function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
    }

    if (!AuthManager.hasRole(req.user, role)) {
      return res.status(403).json({
        success: false,
        error: 'Insufficient permissions'
      });
    }

    next();
  };
}

/**
 * Express middleware for resource access
 */
function requireAccess(resource) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
    }

    if (!AuthManager.canAccess(req.user, resource)) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    next();
  };
}

/**
 * Extract token from request
 */
function extractToken(req) {
  // Check Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  // Check query parameter
  if (req.query && req.query.token) {
    return req.query.token;
  }

  // Check cookies
  if (req.cookies && req.cookies.auth_token) {
    return req.cookies.auth_token;
  }

  return null;
}

/**
 * IPC auth wrapper for Electron handlers
 * Protects IPC channels that require authentication
 */
function protectIpc(handler, options = {}) {
  const { requireAuth = true, requiredRole = null, resource = null } = options;

  return async (event, ...args) => {
    // Check for token in args (convention: last arg if object with token property)
    let token = null;
    const lastArg = args[args.length - 1];

    if (lastArg && typeof lastArg === 'object' && lastArg.token) {
      token = lastArg.token;
    }

    if (requireAuth && !token) {
      return { success: false, error: 'Authentication required' };
    }

    if (token) {
      const user = AuthManager.validateToken(token);

      if (requireAuth && !user) {
        return { success: false, error: 'Invalid or expired token' };
      }

      if (requiredRole && !AuthManager.hasRole(user, requiredRole)) {
        return { success: false, error: 'Insufficient permissions' };
      }

      if (resource && !AuthManager.canAccess(user, resource)) {
        return { success: false, error: 'Access denied' };
      }

      // Attach user to event for handler use
      event.user = user;
    }

    return handler(event, ...args);
  };
}

/**
 * Check if page requires authentication
 */
function isProtectedPage(pagePath) {
  const protectedPages = [
    '/settings',
    '/settings.html',
    '/devices',
    '/devices.html',
    '/users',
    '/users.html',
    '/logs',
    '/logs.html'
  ];

  return protectedPages.some(p => pagePath.includes(p));
}

/**
 * Check if page is public
 */
function isPublicPage(pagePath) {
  const publicPages = [
    '/',
    '/index.html',
    '/login',
    '/login.html',
    '/dashboard',
    '/dashboard.html'
  ];

  return publicPages.some(p => pagePath === p || pagePath.endsWith(p));
}

/**
 * Get required role for page
 */
function getPageRole(pagePath) {
  const pageRoles = {
    '/settings': 'admin',
    '/settings.html': 'admin',
    '/users': 'admin',
    '/users.html': 'admin',
    '/devices': 'admin',
    '/devices.html': 'admin',
    '/logs': 'admin',
    '/logs.html': 'admin'
  };

  for (const [path, role] of Object.entries(pageRoles)) {
    if (pagePath.includes(path)) {
      return role;
    }
  }

  return 'viewer'; // Default to viewer for any protected page
}

module.exports = {
  apiAuth,
  requireRole,
  requireAccess,
  extractToken,
  protectIpc,
  isProtectedPage,
  isPublicPage,
  getPageRole
};
