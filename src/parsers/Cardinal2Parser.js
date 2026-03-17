/**
 * Cardinal2Parser - Cardinal Scale per-deck message protocol
 *
 * Format: Individual messages per deck
 * Example:
 *   D1:  1250 kg S    (Deck 1, 1250 kg, Stable)
 *   D2:  1340 kg S    (Deck 2, 1340 kg, Stable)
 *   D3:  1180 kg M    (Deck 3, 1180 kg, Motion)
 *   D4:  1420 kg S    (Deck 4, 1420 kg, Stable)
 *   GVW: 5190 kg S    (Total weight)
 *
 * Status codes: S=Stable, M=Motion, O=Overload, U=Underload
 */

const ParserInterface = require('./ParserInterface');

class Cardinal2Parser extends ParserInterface {
  constructor(config = {}) {
    super(config);

    // Regex patterns for parsing
    this.patterns = {
      deck: /D(\d):\s*([\d.]+)\s*(\w+)?\s*([SMOU])?/i,
      gvw: /GVW:\s*([\d.]+)\s*(\w+)?\s*([SMOU])?/i,
      total: /TOTAL:\s*([\d.]+)\s*(\w+)?\s*([SMOU])?/i
    };
  }

  parse(data) {
    if (!this.validate(data)) return null;

    const str = data.toString().trim();
    const raw = str;

    // Try deck pattern first
    let match = str.match(this.patterns.deck);
    if (match) {
      const deckNum = parseInt(match[1], 10);
      const weight = this.extractWeight(match[2]);
      const unit = match[3] || 'kg';
      const status = (match[4] || 'S').toUpperCase();

      return this.createResult({
        deck: deckNum,
        weight: weight,
        gross: weight,
        unit: unit.toLowerCase(),
        stable: status === 'S',
        motion: status === 'M',
        overload: status === 'O',
        underload: status === 'U',
        raw: raw
      });
    }

    // Try GVW pattern
    match = str.match(this.patterns.gvw) || str.match(this.patterns.total);
    if (match) {
      const weight = this.extractWeight(match[1]);
      const unit = match[2] || 'kg';
      const status = (match[3] || 'S').toUpperCase();

      return this.createResult({
        deck: 0, // Deck 0 = GVW/Total
        weight: weight,
        gross: weight,
        unit: unit.toLowerCase(),
        stable: status === 'S',
        motion: status === 'M',
        raw: raw
      });
    }

    return null;
  }

  validate(data) {
    if (!super.validate(data)) return false;
    const str = data.toString().trim();
    // Must contain deck number or GVW indicator
    return /D\d:|GVW:|TOTAL:/i.test(str);
  }

  getTerminator() {
    return '\r\n';
  }

  getInfo() {
    return {
      name: 'Cardinal2Parser',
      protocol: 'Cardinal Scale Per-Deck',
      description: 'Individual messages per deck (D1:, D2:, GVW:)'
    };
  }
}

module.exports = Cardinal2Parser;
