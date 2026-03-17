/**
 * I1310Parser - Scale indicator with "Scale No: X" format
 *
 * Format: Text-based with scale number prefix
 * Examples:
 *   Scale No: 1  Weight:  1250 kg Stable
 *   Scale No: 2  Weight:  1340 kg Motion
 *   Scale No: 3  Weight:  1180 kg OL
 *   Total Weight:  3770 kg
 *
 * Also handles simpler formats:
 *   1:  1250 kg
 *   2:  1340 kg
 */

const ParserInterface = require('./ParserInterface');

class I1310Parser extends ParserInterface {
  constructor(config = {}) {
    super(config);

    // Regex patterns
    this.patterns = {
      // Full format: Scale No: X  Weight:  YYYY kg Status
      full: /Scale\s*No[:\s]*(\d+)\s*Weight[:\s]*([\d.]+)\s*(\w+)?\s*(Stable|Motion|OL|UL)?/i,
      // Short format: X:  YYYY kg
      short: /^(\d+)[:\s]+([\d.]+)\s*(\w+)?/,
      // Total weight
      total: /Total\s*Weight[:\s]*([\d.]+)\s*(\w+)?/i
    };
  }

  parse(data) {
    if (!this.validate(data)) return null;

    const str = data.toString().trim();
    const raw = str;

    // Try full format first
    let match = str.match(this.patterns.full);
    if (match) {
      const scaleNum = parseInt(match[1], 10);
      const weight = this.extractWeight(match[2]);
      const unit = match[3] || 'kg';
      const status = (match[4] || 'Stable').toLowerCase();

      return this.createResult({
        deck: scaleNum,
        weight: weight,
        gross: weight,
        unit: unit.toLowerCase(),
        stable: status === 'stable',
        motion: status === 'motion',
        overload: status === 'ol',
        underload: status === 'ul',
        raw: raw
      });
    }

    // Try short format
    match = str.match(this.patterns.short);
    if (match) {
      const scaleNum = parseInt(match[1], 10);
      const weight = this.extractWeight(match[2]);
      const unit = match[3] || 'kg';

      return this.createResult({
        deck: scaleNum,
        weight: weight,
        gross: weight,
        unit: unit.toLowerCase(),
        stable: true,
        raw: raw
      });
    }

    // Try total format
    match = str.match(this.patterns.total);
    if (match) {
      const weight = this.extractWeight(match[1]);
      const unit = match[2] || 'kg';

      return this.createResult({
        deck: 0, // Deck 0 = Total
        weight: weight,
        gross: weight,
        unit: unit.toLowerCase(),
        stable: true,
        raw: raw
      });
    }

    return null;
  }

  validate(data) {
    if (!super.validate(data)) return false;
    const str = data.toString().trim();
    // Must contain scale number or total indicator
    return /Scale\s*No|^\d+[:\s]+[\d.]+|Total\s*Weight/i.test(str);
  }

  getTerminator() {
    return '\r\n';
  }

  getInfo() {
    return {
      name: 'I1310Parser',
      protocol: '1310 Scale Number Format',
      description: 'Scale No: X Weight: YYYY kg format'
    };
  }
}

module.exports = I1310Parser;
