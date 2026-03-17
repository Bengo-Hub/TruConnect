/**
 * PasswordUtils - Password hashing and validation utilities
 */

const bcrypt = require('bcryptjs');

/**
 * Hash a password
 * @param {string} password - Plain text password
 * @param {number} rounds - Salt rounds (default 10)
 * @returns {string} Hashed password
 */
function hashPassword(password, rounds = 10) {
  const salt = bcrypt.genSaltSync(rounds);
  return bcrypt.hashSync(password, salt);
}

/**
 * Compare password with hash
 * @param {string} password - Plain text password
 * @param {string} hash - Hashed password
 * @returns {boolean} True if password matches
 */
function comparePassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

/**
 * Validate password strength
 * @param {string} password - Password to validate
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validatePassword(password) {
  const errors = [];

  if (!password) {
    errors.push('Password is required');
    return { valid: false, errors };
  }

  if (password.length < 8) {
    errors.push('Password must be at least 8 characters');
  }

  if (password.length > 100) {
    errors.push('Password must not exceed 100 characters');
  }

  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }

  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }

  if (!/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number');
  }

  if (!/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
    errors.push('Password must contain at least one special character');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Generate a random password
 * @param {number} length - Password length (default 12)
 * @returns {string} Random password
 */
function generatePassword(length = 12) {
  const lowercase = 'abcdefghijklmnopqrstuvwxyz';
  const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const numbers = '0123456789';
  const special = '!@#$%^&*(),.?';

  const allChars = lowercase + uppercase + numbers + special;

  // Ensure at least one of each type
  let password = '';
  password += lowercase[Math.floor(Math.random() * lowercase.length)];
  password += uppercase[Math.floor(Math.random() * uppercase.length)];
  password += numbers[Math.floor(Math.random() * numbers.length)];
  password += special[Math.floor(Math.random() * special.length)];

  // Fill rest with random characters
  for (let i = password.length; i < length; i++) {
    password += allChars[Math.floor(Math.random() * allChars.length)];
  }

  // Shuffle the password
  return password.split('').sort(() => Math.random() - 0.5).join('');
}

/**
 * Check if password was compromised (placeholder)
 * In production, could check against HaveIBeenPwned API
 */
function isPasswordCompromised(password) {
  // Common weak passwords
  const weakPasswords = [
    'password', '123456', '12345678', 'qwerty',
    'abc123', 'password1', 'admin123', 'letmein'
  ];

  return weakPasswords.includes(password.toLowerCase());
}

module.exports = {
  hashPassword,
  comparePassword,
  validatePassword,
  generatePassword,
  isPasswordCompromised
};
