#!/usr/bin/env node
require('dotenv').config()

const { serveHTTP, publishToCentral } = require("stremio-addon-sdk")
const addonInterface = require("./addon")

// Log environment variables for debugging (without revealing full values)
console.log("Environment check:")
console.log(`- TMDB_API_KEY: ${process.env.TMDB_API_KEY ? "✓ Set" : "✗ Not set"}`)
console.log(`- WEBSHARE_LOGIN: ${process.env.WEBSHARE_LOGIN ? "✓ Set" : "✗ Not set"}`)
console.log(`- WEBSHARE_PASSWORD: ${process.env.WEBSHARE_PASSWORD ? "✓ Set" : "✗ Not set"}`)

serveHTTP(addonInterface, { port: process.env.PORT || 61613 })

// when you've deployed your addon, un-comment this line
// publishToCentral("https://my-addon.awesome/manifest.json")
