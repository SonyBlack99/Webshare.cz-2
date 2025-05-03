/**
 * Simple debugging helper for WebShare addon
 * Set WEBSHARE_DEBUG=true in environment to enable
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Get basic platform info to identify differences
const getPlatformInfo = () => {
  try {
    return {
      platform: os.platform(),
      arch: os.arch(),
      nodeVersion: process.version,
      stremioRuntime: process.env.STREMIO_RUNTIME || 'unknown',
      // Add these values if they're available in the environment
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'node'
    };
  } catch (e) {
    return { error: e.message };
  }
};

// Simple logging that's safe to use anywhere
const log = (message, data) => {
  if (!process.env.WEBSHARE_DEBUG) return;
  
  try {
    console.log(`[WebShare Debug] ${message}`);
    if (data) {
      console.log(typeof data === 'object' ? JSON.stringify(data, null, 2) : data);
    }
  } catch (e) {
    console.log(`[WebShare Debug] Error logging: ${e.message}`);
  }
};

// Compare results before and after sorting to identify order changes
const compareSorts = (items, key = 'name') => {
  if (!process.env.WEBSHARE_DEBUG) return;
  
  const logFilePath = path.join(os.tmpdir(), 'webshare-debug.log');
  
  try {
    // Just log the first few results to see if they differ
    const itemsToLog = items.slice(0, 5).map(item => item[key]);
    fs.appendFileSync(logFilePath, 
      `\n[${new Date().toISOString()}] Results: ${JSON.stringify(itemsToLog)}\n`);
  } catch (e) {
    // Silently fail if logging isn't possible
  }
};

module.exports = {
  getPlatformInfo,
  log,
  compareSorts
};
