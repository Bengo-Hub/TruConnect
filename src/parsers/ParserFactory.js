/**
 * ParserFactory - Factory pattern for creating indicator parsers
 * Supports built-in and custom user-defined protocols
 */

class ParserFactory {
  static parsers = new Map();

  /**
   * Register a parser class
   */
  static register(type, ParserClass) {
    ParserFactory.parsers.set(type.toUpperCase(), ParserClass);
  }

  /**
   * Create parser instance by type
   * @param {string} type - Parser type (ZM, Cardinal, Custom, etc.)
   * @param {Object} config - Parser configuration
   * @returns {ParserInterface} Parser instance
   */
  static create(type, config = {}) {
    const upperType = String(type || '').toUpperCase();
    const ParserClass = ParserFactory.parsers.get(upperType);

    if (!ParserClass) {
      throw new Error(`Unknown parser type: ${type}. Available: ${[...ParserFactory.parsers.keys()].join(', ')}`);
    }

    // Inject sensible defaults for mobile scale parsers based on protocol type
    let effectiveConfig = config;
    if (upperType === 'PAW') {
      effectiveConfig = { ...config, mode: config.mode || 'paw' };
    } else if (upperType === 'HAENNI') {
      effectiveConfig = { ...config, mode: config.mode || 'haenni' };
    } else if (upperType === 'MCGS') {
      effectiveConfig = { ...config, mode: config.mode || 'mcgs' };
    }

    return new ParserClass(effectiveConfig);
  }

  /**
   * Get all registered parser types
   */
  static getTypes() {
    return [...ParserFactory.parsers.keys()];
  }

  /**
   * Check if parser type exists
   */
  static hasType(type) {
    return ParserFactory.parsers.has(type.toUpperCase());
  }
}

// Auto-register parsers on module load
function registerParsers() {
  const ZmParser = require('./ZmParser');
  const CardinalParser = require('./CardinalParser');
  const Cardinal2Parser = require('./Cardinal2Parser');
  const I1310Parser = require('./I1310Parser');
  const MobileScaleParser = require('./MobileScaleParser');
  const CustomParser = require('./CustomParser');

  ParserFactory.register('ZM', ZmParser);
  ParserFactory.register('CARDINAL', CardinalParser);
  ParserFactory.register('CARDINAL2', Cardinal2Parser);
  ParserFactory.register('1310', I1310Parser);
  ParserFactory.register('PAW', MobileScaleParser);
  ParserFactory.register('HAENNI', MobileScaleParser);
  ParserFactory.register('MCGS', MobileScaleParser);
  ParserFactory.register('CUSTOM', CustomParser);
}

// Defer registration to avoid circular dependencies
setImmediate(registerParsers);

module.exports = ParserFactory;
