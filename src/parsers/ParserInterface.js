/**
 * ParserInterface - Base class for all indicator parsers
 * Defines the contract that all parsers must implement
 */

class ParserInterface {
  constructor(config = {}) {
    this.config = config;
    this.name = this.constructor.name;
  }

  /**
   * Parse raw data from indicator
   * @param {string|Buffer} data - Raw data from indicator
   * @returns {Object|null} Parsed weight data or null if invalid
   *
   * Return format:
   * {
   *   deck: number,        // Deck number (1-4)
   *   weight: number,      // Weight value in kg
   *   unit: string,        // Unit (kg, lb, t)
   *   stable: boolean,     // Weight is stable
   *   motion: boolean,     // Scale in motion
   *   overload: boolean,   // Over capacity
   *   underload: boolean,  // Under zero
   *   tare: number,        // Tare weight (if available)
   *   net: number,         // Net weight (if available)
   *   gross: number,       // Gross weight (if available)
   *   raw: string,         // Original raw data
   *   timestamp: Date      // Parse timestamp
   * }
   */
  parse(data) {
    throw new Error('parse() must be implemented by subclass');
  }

  /**
   * Validate if data is complete/parseable
   * @param {string|Buffer} data - Raw data
   * @returns {boolean} True if data is valid for parsing
   */
  validate(data) {
    return data && data.length > 0;
  }

  /**
   * Get message terminator for this protocol
   * @returns {string|Buffer} Message terminator
   */
  getTerminator() {
    return '\r\n';
  }

  /**
   * Get parser info for UI display
   * @returns {Object} Parser metadata
   */
  getInfo() {
    return {
      name: this.name,
      protocol: 'Unknown',
      description: 'Base parser interface'
    };
  }

  /**
   * Helper: Extract numeric weight from string
   * @param {string} str - String containing weight value
   * @returns {number} Parsed weight or 0
   */
  extractWeight(str) {
    if (!str) return 0;
    const cleaned = str.replace(/[^\d.-]/g, '');
    const value = parseFloat(cleaned);
    return isNaN(value) ? 0 : value;
  }

  /**
   * Helper: Create standard weight result object
   */
  createResult(overrides = {}) {
    return {
      deck: 1,
      weight: 0,
      unit: 'kg',
      stable: true,
      motion: false,
      overload: false,
      underload: false,
      tare: 0,
      net: null,
      gross: null,
      raw: '',
      timestamp: new Date(),
      ...overrides
    };
  }
}

module.exports = ParserInterface;
