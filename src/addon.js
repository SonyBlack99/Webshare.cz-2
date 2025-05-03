const { addonBuilder } = require("stremio-addon-sdk")
const needle = require('needle')
const webshare = require('./webshare')
const { findShowInfo } = require("./meta")

// Docs: https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/manifest.md
const manifest = {
	"id": "community.coffei.webshare2",
	"version": "0.3.0",
	"catalogs": [],
	"resources": ["stream"],
	"types": [
		"movie",
		"series"
	],
	"name": "Webshare.cz 2",
	"description": "Upravený webshare.cz pre lepšie vyhľadávanie.",
	"idPrefixes": [
		"tt"
	],
	"behaviorHints": { "configurable": true, "configurationRequired": true },
	"config": [
		{
			"key": "login",
			"type": "text",
			"title": "Webshare.cz login - username or email",
			"required": true
		},
		{
			"key": "password",
			"type": "password",
			"title": "Webshare.cz password",
			"required": true
		},
		{
			"key": "tmdb_key",
			"type": "text",
			"title": "TMDB API Key (v3 API key or v4 Access Token - improves search results)",
			"required": false
		}
	]
}

const builder = new addonBuilder(manifest)

builder.defineStreamHandler(async function (args) {
    console.log(`Received stream request for: ${args.type} ${args.id}`)
    
    // Set environment variables from config if provided
    if (args.config) {
        if (args.config.login) process.env.WEBSHARE_LOGIN = args.config.login
        if (args.config.password) process.env.WEBSHARE_PASSWORD = args.config.password
        
        // Optional TMDB API key
        if (args.config.tmdb_key) {
            process.env.TMDB_API_KEY = args.config.tmdb_key
            console.log("Using TMDB API key from configuration")
        }
    }
    
    // If TMDB API key is not set at all, don't try to use it
    if (!process.env.TMDB_API_KEY) {
        console.log("No TMDB API key set - will use Cinemeta metadata only")
    }
    
    const info = await findShowInfo(args.type, args.id)
    console.log(`Found metadata:`, JSON.stringify(info))
    
    if (info) {
        try {
            const wsToken = await webshare.login()
            const streams = await webshare.search(info, wsToken)
            const streamsWithUrl = await webshare.addUrlToStreams(streams, wsToken)

            return { streams: streamsWithUrl }
        } catch (error) {
            console.error(`Error in stream handler:`, error)
            return { streams: [] }
        }
    }
    return { streams: [] }
})

module.exports = builder.getInterface()