/**
 * ZmParser - Avery Weigh-Tronix ZM series indicator protocol
 *
 * Format: CSV-like with header prefixes
 * Examples:
 *   GS,     2540,kg    (Gross stable)
 *   NT,     1250,kg    (Net stable)
 *   GU,     2545,kg    (Gross unstable/motion)
 *   TR,      150,kg    (Tare)
 *   OL              (Overload)
 *   UL              (Underload)
 *
 * Header codes:
 *   GS = Gross Stable, GU = Gross Unstable
 *   NS = Net Stable, NU = Net Unstable
 *   NT = Net (stable implied)
 *   TR = Tare
 *   OL = Overload, UL = Underload
 */

const ParserInterface = require('./ParserInterface');

class ZmParser extends ParserInterface {
  constructor(config = {}) {
    super(config);
    this.deckNumber = config.deck || 1;
  }

  parse(data) {
    if (!this.validate(data)) return null;

    const str = data.toString().trim();
    const result = this.createResult({ raw: str, deck: this.deckNumber });

    // Check for overload/underload
    if (str.includes('OL')) {
      result.overload = true;
      result.weight = 0;
      return result;
    }

    if (str.includes('UL')) {
      result.underload = true;
      result.weight = 0;
      return result;
    }

    // Parse CSV format: HEADER, VALUE, UNIT
    const parts = str.split(',').map(p => p.trim());

    if (parts.length < 2) return null;

    const header = parts[0].toUpperCase();
    const value = this.extractWeight(parts[1]);
    const unit = parts[2] || 'kg';

    // Determine weight type and stability
    switch (header) {
      case 'GS':
        result.weight = value;
        result.gross = value;
        result.stable = true;
        break;
      case 'GU':
        result.weight = value;
        result.gross = value;
        result.stable = false;
        result.motion = true;
        break;
      case 'NS':
      case 'NT':
        result.weight = value;
        result.net = value;
        result.stable = true;
        break;
      case 'NU':
        result.weight = value;
        result.net = value;
        result.stable = false;
        result.motion = true;
        break;
      case 'TR':
        result.tare = value;
        result.weight = 0;
        break;
      default:
        // Unknown header, try to extract weight anyway
        result.weight = value;
    }

    result.unit = unit.toLowerCase();
    return result;
  }

  validate(data) {
    if (!super.validate(data)) return false;
    const str = data.toString().trim();
    // Must have at least header code or be OL/UL
    return str.length >= 2;
  }

  getTerminator() {
    return '\r\n';
  }

  getInfo() {
    return {
      name: 'ZmParser',
      protocol: 'Avery Weigh-Tronix ZM',
      description: 'CSV format with header codes (GS, GU, NS, NT, TR, OL, UL)'
    };
  }
}

module.exports = ZmParser;
