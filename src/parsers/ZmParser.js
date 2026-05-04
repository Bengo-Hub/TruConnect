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

    // Strip non-printable control chars (STX 0x02, etc.) that some indicators prepend
    const str = data.toString().replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').trim();

    // Zedem 510 multi-deck format: "00,    00,  1100,  1000, 2100"
    // 4–5 comma-separated numeric values, no alpha header codes.
    const parts = str.split(',').map(p => p.trim());
    const isMultiDeck = parts.length >= 4 && parts.every(p => /^\d+$/.test(p));
    if (isMultiDeck) {
      return this._parseMultiDeck(parts);
    }

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

    // Parse standard ZM CSV format: HEADER, VALUE, UNIT
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
        result.weight = value;
    }

    result.unit = unit.toLowerCase();
    return result;
  }

  /**
   * Parse Zedem 510 multi-deck CSV: "00,    00,  1100,  1000, 2100"
   * Returns array of 4 deck results (GVW at index 4 is omitted; serialout recalculates it).
   */
  _parseMultiDeck(parts) {
    const decks = [];
    for (let i = 0; i < 4 && i < parts.length; i++) {
      const w = parseInt(parts[i], 10);
      decks.push(this.createResult({
        deck: i + 1,
        weight: isNaN(w) ? 0 : w,
        gross: isNaN(w) ? 0 : w,
        stable: true,
        unit: 'kg',
        raw: parts[i]
      }));
    }
    return decks;
  }

  validate(data) {
    if (!super.validate(data)) return false;
    const str = data.toString().trim();
    // Must have at least header code or be OL/UL
    return str.length >= 2;
  }

  getTerminator() {
    return '\n';
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
