/**
 * ConnectionPool - Manages TruLoad client connections
 *
 * Tracks connected clients with their:
 * - Station code (e.g., ROMIA, ATMBA)
 * - Bound (A/B direction)
 * - Current plate (for auto-weigh)
 * - Connection state
 *
 * Supports station patterns:
 * - Bidirectional: ROMIA/ROMIB (same station, two directions)
 * - Multi-deck per bound: ATMIA/ATMIB (each bound has own decks)
 */

const EventBus = require('./EventBus');

class ConnectionPool {
  constructor() {
    // clientId -> client info
    this.clients = new Map();

    // stationCode -> Set of clientIds
    this.stationClients = new Map();

    // Subscribe to client events
    EventBus.on('client:connected', (data) => this.addClient(data));
    EventBus.on('client:disconnected', (data) => this.removeClient(data.clientId));
  }

  /**
   * Add client to pool
   */
  addClient(data) {
    const { clientId, ip } = data;

    const clientInfo = {
      clientId,
      ip,
      stationCode: null,
      bound: null,
      currentPlate: null,
      connectedAt: new Date(),
      lastActivity: new Date(),
      registered: false
    };

    this.clients.set(clientId, clientInfo);
    EventBus.emit('pool:client-added', { clientId });
  }

  /**
   * Remove client from pool
   */
  removeClient(clientId) {
    const client = this.clients.get(clientId);
    if (!client) return;

    // Remove from station mapping
    if (client.stationCode) {
      const stationSet = this.stationClients.get(client.stationCode);
      if (stationSet) {
        stationSet.delete(clientId);
        if (stationSet.size === 0) {
          this.stationClients.delete(client.stationCode);
        }
      }
    }

    this.clients.delete(clientId);
    EventBus.emit('pool:client-removed', { clientId, stationCode: client.stationCode });
  }

  /**
   * Register client with station code
   */
  registerClient(clientId, stationCode, bound = 'A') {
    const client = this.clients.get(clientId);
    if (!client) return false;

    // Remove from old station if different
    if (client.stationCode && client.stationCode !== stationCode) {
      const oldSet = this.stationClients.get(client.stationCode);
      if (oldSet) {
        oldSet.delete(clientId);
      }
    }

    // Update client info
    client.stationCode = stationCode;
    client.bound = bound;
    client.registered = true;
    client.lastActivity = new Date();

    // Add to station mapping
    if (!this.stationClients.has(stationCode)) {
      this.stationClients.set(stationCode, new Set());
    }
    this.stationClients.get(stationCode).add(clientId);

    EventBus.emit('pool:client-registered', { clientId, stationCode, bound });
    return true;
  }

  /**
   * Set current plate for client (for auto-weigh)
   */
  setClientPlate(clientId, plateNumber, vehicleType = null) {
    const client = this.clients.get(clientId);
    if (!client) return false;

    client.currentPlate = {
      plateNumber,
      vehicleType,
      receivedAt: new Date()
    };
    client.lastActivity = new Date();

    EventBus.emit('pool:plate-set', {
      clientId,
      stationCode: client.stationCode,
      bound: client.bound,
      plateNumber
    });

    return true;
  }

  /**
   * Clear plate for client (after capture)
   */
  clearClientPlate(clientId) {
    const client = this.clients.get(clientId);
    if (!client) return false;

    client.currentPlate = null;
    return true;
  }

  /**
   * Switch client bound (A/B)
   */
  switchClientBound(clientId, newBound) {
    const client = this.clients.get(clientId);
    if (!client) return false;

    const oldBound = client.bound;
    client.bound = newBound;
    client.lastActivity = new Date();

    EventBus.emit('pool:bound-switched', {
      clientId,
      stationCode: client.stationCode,
      oldBound,
      newBound
    });

    return true;
  }

  /**
   * Get client by ID
   */
  getClient(clientId) {
    return this.clients.get(clientId);
  }

  /**
   * Get all clients for a station
   */
  getStationClients(stationCode) {
    const clientIds = this.stationClients.get(stationCode);
    if (!clientIds) return [];

    return Array.from(clientIds)
      .map(id => this.clients.get(id))
      .filter(Boolean);
  }

  /**
   * Get all clients for a station and bound
   */
  getBoundClients(stationCode, bound) {
    return this.getStationClients(stationCode)
      .filter(client => client.bound === bound);
  }

  /**
   * Get client count
   */
  getClientCount() {
    return this.clients.size;
  }

  /**
   * Get registered client count
   */
  getRegisteredCount() {
    let count = 0;
    for (const client of this.clients.values()) {
      if (client.registered) count++;
    }
    return count;
  }

  /**
   * Get all station codes with active clients
   */
  getActiveStations() {
    return Array.from(this.stationClients.keys());
  }

  /**
   * Get pool status
   */
  getStatus() {
    const stations = {};
    for (const [stationCode, clientIds] of this.stationClients) {
      stations[stationCode] = {
        clientCount: clientIds.size,
        bounds: {}
      };

      for (const clientId of clientIds) {
        const client = this.clients.get(clientId);
        if (client && client.bound) {
          if (!stations[stationCode].bounds[client.bound]) {
            stations[stationCode].bounds[client.bound] = 0;
          }
          stations[stationCode].bounds[client.bound]++;
        }
      }
    }

    return {
      totalClients: this.clients.size,
      registeredClients: this.getRegisteredCount(),
      activeStations: this.stationClients.size,
      stations
    };
  }

  /**
   * Get all clients with plates (pending auto-weigh)
   */
  getClientsWithPlates() {
    const result = [];
    for (const [clientId, client] of this.clients) {
      if (client.currentPlate) {
        result.push({
          clientId,
          stationCode: client.stationCode,
          bound: client.bound,
          plate: client.currentPlate
        });
      }
    }
    return result;
  }

  /**
   * Update client activity timestamp
   */
  updateActivity(clientId) {
    const client = this.clients.get(clientId);
    if (client) {
      client.lastActivity = new Date();
    }
  }

  /**
   * Clean up stale connections (no activity for timeout period)
   */
  cleanupStale(timeoutMs = 300000) { // 5 minutes default
    const now = Date.now();
    const staleClients = [];

    for (const [clientId, client] of this.clients) {
      if (now - client.lastActivity.getTime() > timeoutMs) {
        staleClients.push(clientId);
      }
    }

    for (const clientId of staleClients) {
      console.log(`Cleaning up stale client: ${clientId}`);
      this.removeClient(clientId);
    }

    return staleClients.length;
  }
}

// Singleton instance
let instance = null;

module.exports = {
  getInstance() {
    if (!instance) {
      instance = new ConnectionPool();
    }
    return instance;
  },

  registerClient(clientId, stationCode, bound) {
    return this.getInstance().registerClient(clientId, stationCode, bound);
  },

  setClientPlate(clientId, plateNumber, vehicleType) {
    return this.getInstance().setClientPlate(clientId, plateNumber, vehicleType);
  },

  getClient(clientId) {
    return this.getInstance().getClient(clientId);
  },

  getStationClients(stationCode) {
    return this.getInstance().getStationClients(stationCode);
  },

  getStatus() {
    return this.getInstance().getStatus();
  },

  ConnectionPool
};
