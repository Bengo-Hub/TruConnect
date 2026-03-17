/**
 * ApiInput - HTTP API polling input source
 *
 * Polls REST API endpoint for weight data.
 * Used for Haenni portable scales with REST interface.
 */

const { EventEmitter } = require('events');
const https = require('https');
const http = require('http');

class ApiInput extends EventEmitter {
  constructor(config = {}) {
    super();

    this.config = {
      url: config.url || '',
      interval: config.interval || 500,
      method: config.method || 'GET',
      headers: config.headers || {},
      body: config.body || null,
      timeout: config.timeout || 5000
    };

    this.pollTimer = null;
    this.isConnected = false;
    this.lastDataTime = null;
    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = 10;
  }

  /**
   * Start API polling
   */
  async start() {
    if (!this.config.url) {
      throw new Error('API URL not specified');
    }

    // Initial connection test
    try {
      await this.poll();
      this.isConnected = true;
      this.emit('connected');
      this.startPolling();
      return;
    } catch (error) {
      // First poll failed, but still start polling for recovery
      console.warn(`Initial API poll failed: ${error.message}`);
      this.startPolling();
      throw error;
    }
  }

  /**
   * Start polling timer
   */
  startPolling() {
    if (this.pollTimer) return;

    this.pollTimer = setInterval(async () => {
      try {
        await this.poll();
        this.consecutiveErrors = 0;
        if (!this.isConnected) {
          this.isConnected = true;
          this.emit('connected');
        }
      } catch (error) {
        this.consecutiveErrors++;
        if (this.consecutiveErrors >= this.maxConsecutiveErrors && this.isConnected) {
          this.isConnected = false;
          this.emit('disconnected');
          this.emit('error', error);
        }
      }
    }, this.config.interval);
  }

  /**
   * Stop API polling
   */
  async stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.isConnected = false;
    this.emit('disconnected');
  }

  /**
   * Perform single API poll
   */
  async poll() {
    return new Promise((resolve, reject) => {
      const url = new URL(this.config.url);
      const isHttps = url.protocol === 'https:';
      const httpModule = isHttps ? https : http;

      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: this.config.method,
        headers: {
          'Accept': 'application/json',
          ...this.config.headers
        },
        timeout: this.config.timeout
      };

      const req = httpModule.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            this.lastDataTime = new Date();
            this.emit('data', data);
            resolve(data);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      // Send body for POST/PUT
      if (this.config.body && ['POST', 'PUT', 'PATCH'].includes(this.config.method)) {
        const body = typeof this.config.body === 'object'
          ? JSON.stringify(this.config.body)
          : this.config.body;
        req.setHeader('Content-Type', 'application/json');
        req.setHeader('Content-Length', Buffer.byteLength(body));
        req.write(body);
      }

      req.end();
    });
  }

  /**
   * Get connection status
   */
  getStatus() {
    return {
      url: this.config.url,
      interval: this.config.interval,
      connected: this.isConnected,
      lastData: this.lastDataTime,
      consecutiveErrors: this.consecutiveErrors
    };
  }
}

module.exports = ApiInput;
