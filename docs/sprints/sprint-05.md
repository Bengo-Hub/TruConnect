# Sprint 05: Simulation Mode & Testing

**Duration**: 3-4 days
**Goal**: Implement comprehensive simulation mode for testing and demos

---

## Objectives

1. Create simulation engine
2. Implement multiple simulation modes
3. Add configurable simulation weights
4. Build simulation UI controls
5. Create comprehensive test suite

---

## Tasks

### 5.1 Simulation Engine
- [x] Create `src/simulation/SimulationEngine.js`:
  - Enable/disable simulation mode
  - Integration with InputManager (bypasses real inputs)
  - Weight generation based on mode
  - Event emission for simulated weights

### 5.2 Weight Generator
- [x] Create `src/simulation/WeightGenerator.js`:
  - **Static Mode**: Fixed configured weights
  - **Dynamic Mode**: Random variations within min/max
  - **Pattern Mode**: Simulate vehicle entering/exiting cycle
  - Configurable update interval

### 5.3 Simulation Configuration
- [x] Add simulation configuration schema:
  ```typescript
  interface SimulationConfig {
    enabled: boolean;
    mode: 'static' | 'dynamic' | 'pattern';
    updateInterval: number;  // ms
    weights: {
      deck1: { min: number; max: number; current: number; };
      deck2: { min: number; max: number; current: number; };
      deck3: { min: number; max: number; current: number; };
      deck4: { min: number; max: number; current: number; };
    };
    pattern: {
      mode: 'mobile' | 'multideck', // Simulation scale type
      vehicleDuration: number;     // ms vehicle on deck
      emptyDuration: number;       // ms between vehicles
      approachTime: number;        // ms for stabilization
    };
  }
  ```
- [x] Settings configuration in defaults.js

### 5.4 Pattern Mode Details
- [x] Implement vehicle simulation pattern:
  1. **Empty** (0 weight on all decks)
  2. **Approach** (deck 1 ramps up)
  3. **Crossing** (weight moves deck 1 → 2 → 3 → 4)
  4. **Full** (all decks loaded, stable)
  5. **Departure** (reverse of approach)
  6. Back to Empty, repeat

### 5.5 Simulation UI
- [ ] Add simulation controls to settings page (deferred to Sprint 06):
  - Enable/Disable toggle
  - Mode selector (Static/Dynamic/Pattern)
  - Per-deck min/max/current sliders
  - Pattern timing controls
  - Real-time weight preview

### 5.6 Test Suite
- [ ] Create test files (documentation improvement):
  - `test/parsers/`: Parser unit tests
  - `test/input/`: Input manager tests
  - `test/output/`: Output manager tests
  - `test/simulation/`: Simulation tests
- [ ] Set up Jest or Mocha testing framework
- [ ] Add test scripts to `package.json`

### 5.7 Integration Tests
- [ ] Create integration test scenarios (documentation improvement):
  - Full cycle: Input → Parse → Process → Output
  - Settings persistence: Change → Save → Restart
  - Error handling: Connection failures, parse errors

---

## Deliverables

1. Simulation engine and weight generator
2. Three simulation modes (static, dynamic, pattern)
3. Simulation configuration in settings
4. Simulation UI controls
5. Comprehensive test suite

---

## Verification

### Simulation Test
1. Enable simulation mode
2. Set static weights (e.g., 5000, 6000, 7000, 8000)
3. Verify weights appear on dashboard
4. Verify outputs receive simulated data

### Dynamic Mode Test
1. Enable dynamic simulation
2. Set min/max ranges (e.g., 4000-6000)
3. Observe weight variations over time
4. Verify within configured range

### Pattern Mode Test
1. Enable pattern simulation
2. Set vehicle/empty durations
3. Observe weight progression
4. Verify deck-by-deck progression

### Unit Test Execution
```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run specific test file
npm test -- parsers/ZmParser.test.js
```
