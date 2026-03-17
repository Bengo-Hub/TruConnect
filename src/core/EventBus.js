/**
 * EventBus - Central event emitter for decoupled communication
 * All modules emit and listen to events through this singleton
 */

const { EventEmitter } = require('events');

class EventBus extends EventEmitter {
  static instance = null;

  // Event type constants
  static EVENTS = {
    // Weight events
    WEIGHTS_UPDATED: 'weights-updated',
    WEIGHTS_STABLE: 'weights-stable',

    // Vehicle events
    VEHICLE_DETECTED: 'vehicle-detected',
    VEHICLE_DEPARTED: 'vehicle-departed',

    // Connection events
    CONNECTION_STATUS: 'connection-status',
    INDICATOR_CONNECTED: 'indicator-connected',
    INDICATOR_DISCONNECTED: 'indicator-disconnected',
    RDU_CONNECTED: 'rdu-connected',
    RDU_DISCONNECTED: 'rdu-disconnected',

    // Client events (WebSocket)
    CLIENT_REGISTERED: 'client-registered',
    CLIENT_DISCONNECTED: 'client-disconnected',
    PLATE_RECEIVED: 'plate-received',
    BOUND_CHANGED: 'bound-changed',

    // Simulation events
    SIMULATION_STATE: 'simulation-state',
    SIMULATION_WEIGHTS: 'simulation-weights',

    // System events
    CONFIG_CHANGED: 'config-changed',
    ERROR: 'error',
    SHUTDOWN: 'shutdown'
  };

  constructor() {
    super();
    this.setMaxListeners(50); // Allow more listeners for complex apps
  }

  /**
   * Get singleton instance
   */
  static getInstance() {
    if (!EventBus.instance) {
      EventBus.instance = new EventBus();
    }
    return EventBus.instance;
  }

  /**
   * Emit event with logging
   */
  emitEvent(event, data) {
    console.log(`[EventBus] ${event}`, data ? JSON.stringify(data).substring(0, 100) : '');
    this.emit(event, data);
  }

  /**
   * Remove all listeners for cleanup
   */
  cleanup() {
    this.removeAllListeners();
  }
}

// Export singleton instance with convenience methods
const instance = EventBus.getInstance();

module.exports = {
  getInstance: () => instance,
  emit: (event, data) => instance.emit(event, data),
  on: (event, handler) => instance.on(event, handler),
  off: (event, handler) => instance.off(event, handler),
  once: (event, handler) => instance.once(event, handler),
  removeAllListeners: (event) => instance.removeAllListeners(event),
  EVENTS: EventBus.EVENTS,
  EventBus
};
