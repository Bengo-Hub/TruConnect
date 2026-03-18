/**
 * WeightGenerator - Generates realistic weight values for simulation
 *
 * Provides vehicle-specific weight profiles and random weight generation
 * that mimics real weighbridge behavior.
 */

class WeightGenerator {
  constructor() {
    this.config = {
      minWeight: 1000,
      maxWeight: 50000,
      resolution: 10 // Weight resolution (kg)
    };

    // Vehicle weight profiles (typical weights in kg)
    // Updated to only include heavy vehicles (GVW >= 18,000kg)
    // 2A = 2 axles (e.g. steering + drive), default for multideck simulation
    this.vehicleProfiles = {
      lorry2axle: {
        axles: 2,
        gvwRange: [18000, 22000],
        distribution: [0.45, 0.55]
      },
      lorry3axle: {
        axles: 3,
        gvwRange: [18000, 25000],
        distribution: [0.25, 0.35, 0.40]
      },
      truck4axle: {
        axles: 4,
        gvwRange: [20000, 35000],
        distribution: [0.2, 0.25, 0.28, 0.27]
      },
      trailer5axle: {
        axles: 5,
        gvwRange: [30000, 45000],
        distribution: [0.15, 0.18, 0.20, 0.24, 0.23]
      },
      trailer6axle: {
        axles: 6,
        gvwRange: [35000, 56000],
        distribution: [0.12, 0.15, 0.17, 0.19, 0.19, 0.18]
      }
    };
  }

  /**
   * Initialize with configuration
   */
  initialize(config = {}) {
    this.config = { ...this.config, ...config };
    return this;
  }

  /**
   * Generate a single random weight
   */
  generateSingle(min, max) {
    const value = Math.random() * (max - min) + min;
    return this.roundToResolution(value);
  }

  /**
   * Generate random weights for multiple decks
   */
  generateRandom(deckCount = 4, min, max) {
    const minWeight = min || this.config.minWeight;
    const maxWeight = max || this.config.maxWeight;
    const weights = [];

    for (let i = 0; i < deckCount; i++) {
      weights.push(this.generateSingle(minWeight, maxWeight));
    }

    // Fill remaining decks with 0
    while (weights.length < 4) {
      weights.push(0);
    }

    return weights;
  }

  /**
   * Generate realistic vehicle weights based on type
   */
  generateVehicleWeights(vehicleType) {
    const profile = this.vehicleProfiles[vehicleType];
    if (!profile) {
      return this.generateRandom(4);
    }

    // Generate GVW within vehicle's range
    const gvw = this.generateSingle(profile.gvwRange[0], profile.gvwRange[1]);

    // Distribute weight across decks based on profile
    const weights = [];
    let remaining = gvw;

    for (let i = 0; i < Math.min(profile.axles, 4); i++) {
      const isLast = i === profile.axles - 1 || i === 3;
      let weight;

      if (isLast) {
        weight = remaining;
      } else {
        const baseWeight = gvw * profile.distribution[i];
        // Add some variation (+/- 10%)
        const variation = baseWeight * (Math.random() * 0.2 - 0.1);
        weight = Math.min(baseWeight + variation, remaining);
      }

      weights.push(this.roundToResolution(weight));
      remaining -= weight;
    }

    // Fill remaining decks with 0
    while (weights.length < 4) {
      weights.push(0);
    }

    return weights;
  }

  /**
   * Generate weight for specific axle (mobile scale mode)
   * Range: 9000-11000kg per axle (ensures 2-axle vehicle reaches 18,000kg)
   */
  generateAxleWeight(axleNumber, totalAxles) {
    // All axles use 9000-11000kg range to ensure total >= 18k for any heavy vehicle
    const minAxleWeight = 9000;
    const maxAxleWeight = 11000;

    return this.generateSingle(minAxleWeight, maxAxleWeight);
  }

  /**
   * Get a random vehicle type
   */
  randomVehicleType() {
    const types = Object.keys(this.vehicleProfiles);
    // Weight towards heavier vehicles
    const weights = [0.20, 0.30, 0.30, 0.20];
    const random = Math.random();
    let cumulative = 0;

    for (let i = 0; i < types.length; i++) {
      cumulative += weights[i] || 0.1;
      if (random < cumulative) {
        return types[i];
      }
    }

    return types[types.length - 1];
  }

  /**
   * Round weight to scale resolution
   */
  roundToResolution(weight) {
    const resolution = this.config.resolution || 10;
    return Math.round(weight / resolution) * resolution;
  }

  /**
   * Generate weights with motion simulation
   */
  generateWithMotion(baseWeights, intensity = 0.05) {
    return baseWeights.map(weight => {
      if (weight === 0) return 0;
      const motion = weight * (Math.random() * intensity * 2 - intensity);
      return this.roundToResolution(weight + motion);
    });
  }

  /**
   * Simulate weight settling (for stable detection)
   */
  simulateSettling(previousWeights, targetWeights, settleRate = 0.3) {
    return previousWeights.map((prev, i) => {
      const target = targetWeights[i];
      const diff = target - prev;
      const step = diff * settleRate;
      return this.roundToResolution(prev + step);
    });
  }

  /**
   * Check if weights are stable (within tolerance)
   */
  areWeightsStable(weights1, weights2, tolerance = 50) {
    return weights1.every((w1, i) => {
      const w2 = weights2[i];
      return Math.abs(w1 - w2) <= tolerance;
    });
  }

  /**
   * Get vehicle profile info
   */
  getVehicleProfile(vehicleType) {
    return this.vehicleProfiles[vehicleType] || null;
  }

  /**
   * Get all vehicle types
   */
  getVehicleTypes() {
    return Object.keys(this.vehicleProfiles);
  }
}

module.exports = WeightGenerator;
