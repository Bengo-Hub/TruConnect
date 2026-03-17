/**
 * MobileScaleParser - PAW, Haenni and MCGS portable axle weigher protocols
 *
 * Supports multiple operating modes:
 *
 * 1. PAW Serial Mode (default):
 *    - Serial connection via weight console (default COM7, 9600 baud)
 *    - Response format: "ST,GS, 0000270kg"
 *    - ST = Stable, GS = Gross weight
 *    - IMPORTANT: Weight is combined Scale A+B (wheel weigher axle total)
 *    - To get individual scale weights for PAW, divide total by 2
 *    - Query command: 'W' to request weight
 *
 * 2. PAW UDP Mode (legacy):
 *    - 4-byte IEEE 754 float via UDP port 13805
 *    - Each packet = one axle weight (combined A+B)
 *
 * 3. Haenni Mode (REST API JSON):
 *    - HTTP GET from http://localhost:8888/devices/measurements
 *    - Returns JSON with weight data
 *    - May include separate scaleA/scaleB weights OR combined weight
 *    - Parser detects and handles both formats automatically
 *
 * Scale Weight Handling:
 *    - PAW: Always returns combined weight. scaleA = scaleB = total / 2
 *    - Haenni: May return scaleA/scaleB separately or as combined weight
 *    - axleWeight (weight field): Always the total (scaleA + scaleB)
 *
 * Mobile scale workflow:
 *    - Step-through axle capture
 *    - Accumulates axles until GVW capture
 *    - Reports individual axle weights + running total
 */

const ParserInterface = require('./ParserInterface');

class MobileScaleParser extends ParserInterface {
  constructor(config = {}) {
    super(config);

    // Mode:
    // - 'paw' for PAW serial
    // - 'paw-udp' for PAW UDP binary
    // - 'haenni' for Haenni REST JSON
    // - 'mcgs' for MCGS serial frames ("=SG+0000123kR")
    this.mode = config.mode || 'paw';

    // Track axle accumulation
    this.axles = [];
    this.currentAxle = 0;

    // Scale weight mode determines how individual scale weights are reported:
    // - 'combined': Weight is total of both scales (PAW) - derive individual as total/2
    // - 'separate': Weights are provided separately (some Haenni modes)
    this.scaleWeightMode = config.scaleWeightMode || (this.mode === 'paw' || this.mode === 'paw-udp' ? 'combined' : 'auto');
  }

  parse(data) {
    if (this.mode === 'mcgs') {
      return this.parseMcgsSerial(data);
    }
    if (this.mode === 'haenni') {
      return this.parseHaenni(data);
    }
    if (this.mode === 'paw-udp') {
      return this.parsePawUdp(data);
    }
    // Default: PAW serial format
    return this.parsePawSerial(data);
  }

  /**
   * Parse PAW serial format: "ST,GS, 0000270kg"
   * ST = Stable indicator
   * GS = Gross weight indicator
   * Weight value = combined Scale A+B (both wheels of an axle)
   */
  parsePawSerial(data) {
    if (!data) return null;

    const raw = data.toString().trim();

    // Match PAW format: ST,GS, 0000270kg or variations
    // Format: [stability],[mode], [weight]kg
    const match = raw.match(/^(ST|US)?,?\s*(GS|NT)?,?\s*(\d+)\s*kg/i);

    if (!match) {
      // Try simpler numeric extraction as fallback
      const simpleMatch = raw.match(/(\d+)\s*kg/i);
      if (simpleMatch) {
        const weight = parseInt(simpleMatch[1], 10);
        return this.createAxleResult(weight, raw, raw.includes('ST'));
      }
      return null;
    }

    const stable = match[1]?.toUpperCase() === 'ST';
    const isGross = match[2]?.toUpperCase() === 'GS';
    const weight = parseInt(match[3], 10);

    // Validate weight is reasonable
    if (isNaN(weight) || weight < 0 || weight > 100000) {
      return null;
    }

    return this.createAxleResult(weight, raw, stable);
  }

  /**
   * Parse MCGS serial format: "=SG+0000123kR"
   *
   * Each frame:
   *   - Represents one complete axle weight (A+B already combined)
   *   - Uses "kR" suffix instead of "kg"
   *   - Does not explicitly expose stability; treated as stable by default
   */
  parseMcgsSerial(data) {
    if (!data) return null;

    const raw = data.toString().trim();

    // Quick filter: must contain the "SG" marker
    if (!raw.includes('SG')) {
      return null;
    }

    // Strip leading '=' if present and normalize string
    const cleaned = raw.replace(/^=/, '');

    // Preferred pattern: SG+0000123kR → capture numeric part before 'k'
    const match = cleaned.match(/SG\+?(-?\d+)[kK]/);
    let weight = null;

    if (match) {
      weight = parseInt(match[1], 10);
    } else {
      // Fallback: strip non-numeric characters and parse
      const numeric = cleaned.replace(/[^0-9\-]/g, '');
      if (numeric) {
        weight = parseInt(numeric, 10);
      }
    }

    // Validate weight range (0 to 100,000 kg)
    if (weight === null || isNaN(weight) || weight < 0 || weight > 100000) {
      return null;
    }

    // MCGS frames are treated as stable combined axle weights
    this.scaleWeightMode = 'combined';
    const stable = true;

    return this.createAxleResult(weight, raw, stable);
  }

  /**
   * Create standardized axle result
   *
   * For PAW scales: weight is combined (A+B), so individual scales = weight/2
   * For Haenni: may have separate scaleA/scaleB or combined weight
   * For MCGS: stream is live current axle weight; capture is done by frontend so we do not push to axles here.
   *
   * @param {number} weight - Total axle weight (combined A+B for PAW)
   * @param {string} raw - Raw data string
   * @param {boolean} stable - Weight stability indicator
   * @param {Object} scaleWeights - Optional separate scale weights { scaleA, scaleB }
   */
  createAxleResult(weight, raw, stable = true, scaleWeights = null) {
    // MCGS streams current axle weight; axle capture is done by user on console/frontend - do not auto-push to axles
    const isMcgsStream = this.mode === 'mcgs';
    if (!isMcgsStream && weight > 0 && weight !== this.axles[this.axles.length - 1]) {
      this.currentAxle++;
      this.axles.push(weight);
    }

    // Calculate individual scale weights
    // For PAW: weight is combined, so each scale = total / 2
    // For Haenni: may have explicit scaleA/scaleB or derive from combined
    let scaleA, scaleB;
    if (scaleWeights && scaleWeights.scaleA !== undefined && scaleWeights.scaleB !== undefined) {
      // Explicit individual scale weights (Haenni separate mode)
      scaleA = scaleWeights.scaleA;
      scaleB = scaleWeights.scaleB;
    } else {
      // Combined weight mode (PAW default) - derive individual scales
      // Each wheel pad gets approximately half the axle weight
      scaleA = Math.round(weight / 2);
      scaleB = weight - scaleA; // Ensure exact total
    }

    return this.createResult({
      deck: this.currentAxle || 1,
      weight: weight,
      gross: weight,
      unit: 'kg',
      stable: stable,
      raw: raw,
      // Individual scale weights (for scale test and diagnostics)
      scaleA: scaleA,
      scaleB: scaleB,
      scaleWeightMode: this.scaleWeightMode,
      // Additional mobile scale data
      axleNumber: this.currentAxle || 1,
      axleWeights: [...this.axles],
      runningTotal: this.axles.reduce((a, b) => a + b, 0)
    });
  }

  /**
   * Parse PAW UDP binary format (IEEE 754 float) - legacy mode
   */
  parsePawUdp(data) {
    if (!data || data.length < 4) return null;

    const raw = data.toString('hex');

    try {
      // Read as IEEE 754 float (little-endian)
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const weight = buffer.readFloatLE(0);

      // Validate weight is reasonable (0 to 100,000 kg)
      if (isNaN(weight) || weight < 0 || weight > 100000) {
        return null;
      }

      // Round to nearest 10 (typical scale precision)
      const roundedWeight = Math.round(weight / 10) * 10;

      return this.createAxleResult(roundedWeight, raw, true);
    } catch (e) {
      return null;
    }
  }

  /**
   * Parse Haenni REST API JSON response
   *
   * Haenni may return:
   * 1. Combined weight: { weight: 12000 } - total axle weight
   * 2. Separate scales: { scaleA: 6000, scaleB: 6000 } - individual wheel weights
   * 3. Both: { weight: 12000, scaleA: 6000, scaleB: 6000 }
   *
   * The parser handles all formats and always provides both combined and individual weights.
   */
  parseHaenni(data) {
    if (!data) return null;

    const raw = typeof data === 'string' ? data : JSON.stringify(data);

    try {
      const json = typeof data === 'string' ? JSON.parse(data) : data;

      // Check for individual scale weights (Haenni may provide these)
      const hasIndividualWeights = (json.scaleA !== undefined || json.ScaleA !== undefined) &&
                                   (json.scaleB !== undefined || json.ScaleB !== undefined);

      let weight, scaleA, scaleB;

      if (hasIndividualWeights) {
        // Haenni returns separate scale weights
        scaleA = json.scaleA ?? json.ScaleA ?? 0;
        scaleB = json.scaleB ?? json.ScaleB ?? 0;
        // Total weight is sum of both scales (or use provided total if available)
        weight = json.weight || json.Weight || json.value || json.gross || (scaleA + scaleB);
        this.scaleWeightMode = 'separate';
      } else {
        // Haenni returns combined weight only
        weight = json.weight || json.Weight || json.value || json.gross || 0;
        scaleA = Math.round(weight / 2);
        scaleB = weight - scaleA;
        this.scaleWeightMode = 'combined';
      }

      const axle = json.axle || json.axleNumber || json.AxleNo || 1;
      const stable = json.stable !== false && json.motion !== true;
      const unit = json.unit || json.Unit || 'kg';

      // Update axle tracking
      if (axle > this.currentAxle) {
        this.currentAxle = axle;
        this.axles[axle - 1] = weight;
      }

      return this.createResult({
        deck: axle,
        weight: weight,
        gross: weight,
        unit: unit.toLowerCase(),
        stable: stable,
        motion: !stable,
        raw: raw,
        // Individual scale weights
        scaleA: scaleA,
        scaleB: scaleB,
        scaleWeightMode: this.scaleWeightMode,
        // Additional Haenni data
        axleNumber: axle,
        axleWeights: [...this.axles],
        runningTotal: this.axles.reduce((a, b) => a + b, 0),
        // Pass through any extra fields
        vehicleId: json.vehicleId || json.plateNumber,
        timestamp: json.timestamp || new Date()
      });
    } catch (e) {
      // Try simple numeric string
      const weight = this.extractWeight(data.toString());
      if (weight > 0) {
        this.currentAxle++;
        this.axles.push(weight);
        const scaleA = Math.round(weight / 2);
        return this.createResult({
          deck: this.currentAxle,
          weight: weight,
          gross: weight,
          unit: 'kg',
          scaleA: scaleA,
          scaleB: weight - scaleA,
          scaleWeightMode: 'combined',
          raw: raw
        });
      }
      return null;
    }
  }

  /**
   * Reset axle accumulation (call when vehicle leaves)
   */
  resetAxles() {
    this.axles = [];
    this.currentAxle = 0;
  }

  /**
   * Get current GVW (sum of all axles)
   */
  getGVW() {
    return this.axles.reduce((a, b) => a + b, 0);
  }

  /**
   * Get axle count
   */
  getAxleCount() {
    return this.axles.length;
  }

  validate(data) {
    if (!super.validate(data)) return false;

    if (this.mode === 'haenni') {
      // JSON must be parseable or contain weight-like data
      const str = data.toString();
      try {
        JSON.parse(str);
        return true;
      } catch {
        return /\d+/.test(str);
      }
    }

    if (this.mode === 'mcgs') {
      // MCGS serial frames: "=SG+0000123kR" or "=SG+0000060kX"
      const str = data.toString();
      return /SG.*\d+.*k[RX]?/i.test(str);
    }

    if (this.mode === 'paw-udp') {
      // PAW UDP: need at least 4 bytes for float
      return Buffer.isBuffer(data) ? data.length >= 4 : data.length >= 4;
    }

    // PAW Serial: must contain "kg" and some digits
    const str = data.toString();
    return /\d+\s*kg/i.test(str);
  }

  getTerminator() {
    // PAW and MCGS serial use CRLF terminator
    // PAW UDP uses packets (no terminator)
    // Haenni uses HTTP responses (no terminator)
    if (this.mode === 'paw' || this.mode === 'mcgs') {
      return '\r\n';  // PAW serial uses CRLF
    }
    return null;  // UDP and HTTP don't need terminators
  }

  getInfo() {
    const protocols = {
      'paw': { protocol: 'PAW Serial', description: 'PAW weight console serial (ST,GS format)' },
      'paw-udp': { protocol: 'PAW UDP Binary', description: 'PAW portable scale UDP IEEE 754 float' },
      'haenni': { protocol: 'Haenni REST API', description: 'Haenni portable scale JSON API' },
      'mcgs': { protocol: 'MCGS Serial', description: 'MCGS mobile scale serial (SG+NNNNNNkR frames)' }
    };

    const info = protocols[this.mode] || protocols['paw'];

    return {
      name: 'MobileScaleParser',
      protocol: info.protocol,
      description: info.description,
      mode: this.mode
    };
  }
}

module.exports = MobileScaleParser;
