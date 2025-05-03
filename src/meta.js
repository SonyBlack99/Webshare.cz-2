const tmdbApiKey = process.env.TMDB_API_KEY
const needle = require('needle')

// Check if the API key looks like a JWT token (starting with "eyJ")
const isJwtToken = tmdbApiKey && tmdbApiKey.startsWith('eyJ');
console.log(`TMDB API Key format: ${isJwtToken ? 'JWT token (will use API v4)' : 'Standard API key (will use API v3)'}`);

// Add debugging to check the API key value without exposing the full key
console.log(`TMDB API Key: ${tmdbApiKey ? tmdbApiKey.substring(0, 4) + '...' + tmdbApiKey.substring(tmdbApiKey.length - 4) : 'Not set'}`)

const findShowInfo = async (type, id) => {
    if (type == 'movie') {
        return await findMovieTmdb(type, id) || await findMovieCinemeta(type, id)
    } else if (type == 'series') {
        return await findSeriesTmdb(type, id) || await findSeriesCinemeta(type, id)
    }
}

const findMovieCinemeta = async (type, id) => {
    const resp = await needle('get', 'https://v3-cinemeta.strem.io/meta/' + type + '/' + id + '.json')
    return resp.body && { name: resp.body.meta.name, originalName: null, type }
}

const findSeriesCinemeta = async (type, id) => {
    const segments = id.split(':')
    if (segments.length == 3) {
        const [id, series, episode] = segments
        const resp = await needle('get', 'https://v3-cinemeta.strem.io/meta/' + type + '/' + id + '.json')
        return resp.body && { name: resp.body.meta.name, originalName: null, type, series, episode }
    }
}

// Headers for API v4 (JWT token)
const getHeaders = () => {
    if (isJwtToken) {
        return {
            'Authorization': `Bearer ${tmdbApiKey}`,
            'Content-Type': 'application/json;charset=utf-8'
        }
    } else {
        return { 'Content-Type': 'application/json;charset=utf-8' }
    }
}

const findMovieTmdb = async (type, id) => {
    if (!tmdbApiKey) {
        console.log("Skipping TMDB API call - no API key");
        return null;
    }
    
    console.log(`Searching TMDB for movie: ${id}`)
    try {
        // Use different API endpoints based on token type
        let url, resp;
        
        if (isJwtToken) {
            url = `https://api.themoviedb.org/3/find/${id}?external_source=imdb_id&language=cs`
            console.log(`Making TMDB API v4 request with JWT token: ${url}`)
            resp = await needle('get', url, null, { headers: getHeaders() })
        } else {
            url = `https://api.themoviedb.org/3/find/${id}?api_key=${tmdbApiKey}&external_source=imdb_id&language=cs`
            console.log(`Making TMDB API v3 request with API key: ${url.replace(tmdbApiKey, 'API_KEY_HIDDEN')}`)
            resp = await needle('get', url)
        }
        
        console.log(`TMDB API response status: ${resp.statusCode}`)
        
        if (resp.statusCode == 200) {
            const results = resp.body.movie_results
            if (results && results.length >= 1) {
                console.log(`TMDB found movie: ${results[0].title}, original: ${results[0].original_title}`)
                return { 
                    name: results[0].title, 
                    originalName: results[0].original_title, 
                    year: results[0].release_date ? results[0].release_date.split('-')[0] : null,
                    type 
                }
            } else {
                console.log(`No movie results found in TMDB response`)
            }
        } else {
            console.log(`TMDB API error: ${resp.statusCode}`)
            console.log(`TMDB API error body: ${JSON.stringify(resp.body)}`)
        }
    } catch (error) {
        console.error('Error fetching movie from TMDB:', error.message)
    }
    return null
}

const findSeriesTmdb = async (type, id) => {
    if (!tmdbApiKey) {
        console.log("Skipping TMDB API call - no API key");
        return null;
    }
    
    const segments = id.split(':')
    if (segments.length == 3) {
        const [id, series, episode] = segments
        console.log(`Searching TMDB for series: ${id}, S${series}E${episode}`)
        
        try {
            // Use different API endpoints based on token type
            let url, resp;
            
            if (isJwtToken) {
                url = `https://api.themoviedb.org/3/find/${id}?external_source=imdb_id&language=cs`
                console.log(`Making TMDB API v4 request with JWT token: ${url}`)
                resp = await needle('get', url, null, { headers: getHeaders() })
            } else {
                url = `https://api.themoviedb.org/3/find/${id}?api_key=${tmdbApiKey}&external_source=imdb_id&language=cs`
                console.log(`Making TMDB API v3 request with API key: ${url.replace(tmdbApiKey, 'API_KEY_HIDDEN')}`)
                resp = await needle('get', url)
            }
            
            console.log(`TMDB API response status: ${resp.statusCode}`)
            
            if (resp.statusCode == 200) {
                const results = resp.body.tv_results
                if (results && results.length >= 1) {
                    console.log(`TMDB found series: ${results[0].name}, original: ${results[0].original_name}`)
                    
                    // Extract the year from first_air_date if available
                    const year = results[0].first_air_date ? 
                                 results[0].first_air_date.split('-')[0] : null;
                    
                    return { 
                        name: results[0].name, 
                        originalName: results[0].original_name, 
                        year: year,  // Add the year
                        type, 
                        series, 
                        episode 
                    }
                } else {
                    console.log(`No TV results found in TMDB response`)
                }
            } else {
                console.log(`TMDB API error: ${resp.statusCode}`)
                console.log(`TMDB API error body: ${JSON.stringify(resp.body)}`)
            }
        } catch (error) {
            console.error('Error fetching series from TMDB:', error.message)
        }
    }
    return null
}

module.exports = { findShowInfo }