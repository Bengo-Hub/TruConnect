/**
 * CustomParser - User-defined protocol parser
 *
 * Supports multiple parsing modes:
 *   1. REGEX - Match groups extract weight data
 *   2. DELIMITER - Split by delimiter, pick field index
 *   3. FIXED - Fixed-width field positions
 *   4. JSON - JSON path extraction
 *
 * Configuration schema:
 * {
 *   mode: 'regex' | 'delimiter' | 'fixed' | 'json',
 *   name: 'My Custom Protocol',
 *
 *   // For REGEX mode:
 *   regex: {
 *     pattern: 'W:(\\d+)\\s*(\\w+)',
 *     groups: {
 *       weight: 1,      // Group index for weight
 *       unit: 2,        // Group index for unit
 *       deck: null,     // Optional group for deck
 *       status: null    // Optional group for status
 *     }
 *   },
 *
 *   // For DELIMITER mode:
 *   delimiter: {
 *     separator: ',',
 *     fields: {
 *       weight: 0,      // Field index for weight
 *       unit: 1,        // Field index for unit
 *       deck: null,
 *       status: null
 *     },
 *     skipLines: 0      // Lines to skip at start
 *   },
 *
 *   // For FIXED mode:
 *   fixed: {
 *     weight: { start: 0, length: 8 },
 *     unit: { start: 8, length: 2 },
 *     deck: { start: 10, length: 1 },
 *     status: { start: 11, length: 1 }
 *   },
 *
 *   // For JSON mode:
 *   json: {
 *     paths: {
 *       weight: 'data.weight',    // Dot notation path
 *       unit: 'data.unit',
 *       deck: 'scale.id',
 *       status: 'status.stable'
 *     }
 *   },
 *
 *   // Common options:
 *   defaults: {
 *     deck: 1,
 *     unit: 'kg'
 *   },
 *   statusMap: {
 *     'S': 'stable',
 *     'M': 'motion',
 *     'O': 'overload',
 *     'U': 'underload'
 *   },
 *   terminator: '\r\n'
 * }
 */

const ParserInterface = require('./ParserInterface');

class CustomParser extends ParserInterface {
  constructor(config = {}) {
    super(config);

    this.mode = config.mode || 'delimiter';
    this.protocolName = config.name || 'Custom Protocol';

    // Mode-specific config
    this.regexConfig = config.regex || {};
    this.delimiterConfig = config.delimiter || { separator: ',', fields: { weight: 0 } };
    this.fixedConfig = config.fixed || {};
    this.jsonConfig = config.json || { paths: { weight: 'weight' } };

    // Common options
    this.defaults = config.defaults || { deck: 1, unit: 'kg' };
    this.statusMap = config.statusMap || {
      'S': 'stable',
      'M': 'motion',
      'O': 'overload',
      'U': 'underload',
      'stable': 'stable',
      'motion': 'motion'
    };
    this.terminator = config.terminator || '\r\n';

    // Compile regex if provided
    if (this.mode === 'regex' && this.regexConfig.pattern) {
      this.compiledRegex = new RegExp(this.regexConfig.pattern, 'i');
    }
  }

  parse(data) {
    if (!this.validate(data)) return null;

    const str = data.toString().trim();

    switch (this.mode) {
      case 'regex':
        return this.parseRegex(str);
      case 'delimiter':
        return this.parseDelimiter(str);
      case 'fixed':
        return this.parseFixed(str);
      case 'json':
        return this.parseJson(str);
      default:
        return null;
    }
  }

  /**
   * Parse using regex pattern
   */
  parseRegex(str) {
    if (!this.compiledRegex) return null;

    const match = str.match(this.compiledRegex);
    if (!match) return null;

    const groups = this.regexConfig.groups || { weight: 1 };
    const extracted = {
      weight: groups.weight ? this.extractWeight(match[groups.weight]) : 0,
      unit: groups.unit ? match[groups.unit] : this.defaults.unit,
      deck: groups.deck ? parseInt(match[groups.deck], 10) : this.defaults.deck,
      status: groups.status ? match[groups.status] : 'stable'
    };

    return this.buildResult(extracted, str);
  }

  /**
   * Parse using delimiter
   */
  parseDelimiter(str) {
    const { separator, fields, skipLines } = this.delimiterConfig;

    // Handle multi-line data
    let line = str;
    if (skipLines > 0) {
      const lines = str.split(/\r?\n/);
      line = lines[skipLines] || lines[0];
    }

    const parts = line.split(separator).map(p => p.trim());
    const extracted = {
      weight: fields.weight !== undefined ? this.extractWeight(parts[fields.weight]) : 0,
      unit: fields.unit !== undefined ? parts[fields.unit] : this.defaults.unit,
      deck: fields.deck !== undefined ? parseInt(parts[fields.deck], 10) : this.defaults.deck,
      status: fields.status !== undefined ? parts[fields.status] : 'stable'
    };

    return this.buildResult(extracted, str);
  }

  /**
   * Parse using fixed-width fields
   */
  parseFixed(str) {
    const extracted = {
      weight: 0,
      unit: this.defaults.unit,
      deck: this.defaults.deck,
      status: 'stable'
    };

    for (const [field, pos] of Object.entries(this.fixedConfig)) {
      if (pos && pos.start !== undefined && pos.length) {
        const value = str.substring(pos.start, pos.start + pos.length).trim();
        switch (field) {
          case 'weight':
            extracted.weight = this.extractWeight(value);
            break;
          case 'unit':
            extracted.unit = value || this.defaults.unit;
            break;
          case 'deck':
            extracted.deck = parseInt(value, 10) || this.defaults.deck;
            break;
          case 'status':
            extracted.status = value || 'stable';
            break;
        }
      }
    }

    return this.buildResult(extracted, str);
  }

  /**
   * Parse JSON with dot-notation paths
   */
  parseJson(str) {
    try {
      const json = JSON.parse(str);
      const paths = this.jsonConfig.paths || { weight: 'weight' };

      const extracted = {
        weight: this.getJsonPath(json, paths.weight) || 0,
        unit: this.getJsonPath(json, paths.unit) || this.defaults.unit,
        deck: this.getJsonPath(json, paths.deck) || this.defaults.deck,
        status: this.getJsonPath(json, paths.status) || 'stable'
      };

      // Convert weight to number
      extracted.weight = this.extractWeight(String(extracted.weight));
      extracted.deck = parseInt(extracted.deck, 10) || 1;

      return this.buildResult(extracted, str);
    } catch (e) {
      return null;
    }
  }

  /**
   * Get nested JSON value by dot path
   */
  getJsonPath(obj, path) {
    if (!path) return undefined;
    return path.split('.').reduce((o, k) => (o || {})[k], obj);
  }

  /**
   * Build final result from extracted values
   */
  buildResult(extracted, raw) {
    const status = this.normalizeStatus(extracted.status);

    return this.createResult({
      deck: extracted.deck || 1,
      weight: extracted.weight,
      gross: extracted.weight,
      unit: (extracted.unit || 'kg').toLowerCase(),
      stable: status === 'stable',
      motion: status === 'motion',
      overload: status === 'overload',
      underload: status === 'underload',
      raw: raw
    });
  }

  /**
   * Normalize status string using status map
   */
  normalizeStatus(status) {
    if (!status) return 'stable';
    const normalized = String(status).trim().toUpperCase();
    return this.statusMap[normalized] || this.statusMap[status.toLowerCase()] || 'stable';
  }

  validate(data) {
    if (!super.validate(data)) return false;

    const str = data.toString().trim();

    switch (this.mode) {
      case 'regex':
        return this.compiledRegex ? this.compiledRegex.test(str) : false;
      case 'json':
        try {
          JSON.parse(str);
          return true;
        } catch {
          return false;
        }
      default:
        return str.length > 0;
    }
  }

  getTerminator() {
    return this.terminator;
  }

  getInfo() {
    return {
      name: 'CustomParser',
      protocol: this.protocolName,
      description: `User-defined ${this.mode} parsing protocol`,
      mode: this.mode,
      config: this.config
    };
  }

  /**
   * Static: Create parser from saved protocol config
   */
  static fromProtocol(protocol) {
    return new CustomParser({
      name: protocol.name,
      mode: protocol.mode,
      ...protocol.config
    });
  }

  /**
   * Static: Validate protocol configuration
   */
  static validateConfig(config) {
    const errors = [];

    if (!config.mode) {
      errors.push('Mode is required (regex, delimiter, fixed, json)');
    }

    if (config.mode === 'regex' && !config.regex?.pattern) {
      errors.push('Regex pattern is required for regex mode');
    }

    if (config.mode === 'delimiter') {
      if (!config.delimiter?.separator) {
        errors.push('Separator is required for delimiter mode');
      }
      if (config.delimiter?.fields?.weight === undefined) {
        errors.push('Weight field index is required for delimiter mode');
      }
    }

    if (config.mode === 'fixed' && !config.fixed?.weight) {
      errors.push('Weight field position is required for fixed mode');
    }

    if (config.mode === 'json' && !config.json?.paths?.weight) {
      errors.push('Weight path is required for json mode');
    }

    return {
      valid: errors.length === 0,
      errors: errors
    };
  }
}

module.exports = CustomParser;
