/**
 * CardinalParser - Cardinal Scale fixed 90-character protocol
 *
 * Format: Fixed-width fields in 90-character message
 *
 * Structure (approximate positions):
 *   Pos 0-9:   Header/ID
 *   Pos 10-19: Deck 1 weight
 *   Pos 20-29: Deck 2 weight
 *   Pos 30-39: Deck 3 weight
 *   Pos 40-49: Deck 4 weight
 *   Pos 50-59: Total/GVW weight
 *   Pos 60-69: Status flags
 *   Pos 70-79: Unit/mode
 *   Pos 80-89: Checksum/terminator
 *
 * Weight positions may vary by firmware version.
 * This implementation uses configurable field positions.
 */

const ParserInterface = require('./ParserInterface');

class CardinalParser extends ParserInterface {
  constructor(config = {}) {
    super(config);

    // Configurable field positions (0-indexed start, length)
    this.fields = config.fields || {
      deck1: { start: 10, length: 10 },
      deck2: { start: 20, length: 10 },
      deck3: { start: 30, length: 10 },
      deck4: { start: 40, length: 10 },
      total: { start: 50, length: 10 },
      status: { start: 60, length: 10 },
      unit: { start: 70, length: 5 }
    };

    this.messageLength = config.messageLength || 90;
  }

  parse(data) {
    if (!this.validate(data)) return null;

    const str = data.toString();
    const results = [];
    const raw = str.trim();

    // Extract all deck weights
    const deckWeights = [
      this.extractField(str, this.fields.deck1),
      this.extractField(str, this.fields.deck2),
      this.extractField(str, this.fields.deck3),
      this.extractField(str, this.fields.deck4)
    ];

    const totalWeight = this.extractField(str, this.fields.total);
    const status = this.extractField(str, this.fields.status);
    const unit = this.extractField(str, this.fields.unit) || 'kg';

    // Parse status flags
    const motion = status.includes('M') || status.includes('U');
    const overload = status.includes('O');
    const underload = status.includes('-') && !motion;

    // Create result for each active deck
    for (let i = 0; i < 4; i++) {
      const weight = this.extractWeight(deckWeights[i]);
      if (weight !== 0 || i === 0) { // Always include deck 1
        results.push(this.createResult({
          deck: i + 1,
          weight: weight,
          gross: weight,
          unit: unit.toLowerCase().trim(),
          stable: !motion,
          motion: motion,
          overload: overload,
          underload: underload,
          raw: raw
        }));
      }
    }

    // Add GVW result if available
    const gvw = this.extractWeight(totalWeight);
    if (gvw > 0) {
      results.push(this.createResult({
        deck: 0, // Deck 0 = GVW/Total
        weight: gvw,
        gross: gvw,
        unit: unit.toLowerCase().trim(),
        stable: !motion,
        motion: motion,
        raw: raw
      }));
    }

    // Return single result or array
    return results.length === 1 ? results[0] : results;
  }

  extractField(str, field) {
    if (!field || str.length < field.start + field.length) {
      return '';
    }
    return str.substring(field.start, field.start + field.length).trim();
  }

  validate(data) {
    if (!super.validate(data)) return false;
    const str = data.toString();
    // Must be at least close to expected length
    return str.length >= this.messageLength * 0.8;
  }

  getTerminator() {
    return '\r\n';
  }

  getInfo() {
    return {
      name: 'CardinalParser',
      protocol: 'Cardinal Scale Fixed-Width',
      description: `Fixed ${this.messageLength}-character message with positional fields`
    };
  }
}

module.exports = CardinalParser;
