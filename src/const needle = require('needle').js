const needle = require('needle')
const formencode = require('formencode')
const { clean } = require('./utils')

// Webshare API headers
const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3',
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest'
}

// Generate localized variants of a name for searching
const generateLocalizedVariants = (name) => {
    const variants = []
    const words = name.split(' ')
    
    // Basic variants by reordering words
    for (let i = 0; i < words.length; i++) {
        const reordered = [...words]
        const word = reordered.splice(i, 1)[0]
        reordered.unshift(word)
        variants.push(reordered.join(' '))
    }
    
    // Add variants with common prefixes/suffixes removed
    const prefixes = ['the', 'a', 'an', 'le', 'la', 'les', 'el', 'il', 'lo', 'der', 'die', 'das']
    const suffixes = ['movie', 'film', 'show', 'series']
    
    for (const prefix of prefixes) {
        if (name.toLowerCase().startsWith(prefix + ' ')) {
            variants.push(name.slice(prefix.length + 1))
        }
    }
    
    for (const suffix of suffixes) {
        if (name.toLowerCase().endsWith(' ' + suffix)) {
            variants.push(name.slice(0, -suffix.length - 1))
        }
    }
    
    return variants
}

// Generate episode tags for series searches
const generateEpisodeTags = (season, episode) => {
    const tags = []
    
    if (season && episode) {
        tags.push(`S${season}E${episode}`)
        tags.push(`Season ${season} Episode ${episode}`)
        tags.push(`S${season} E${episode}`)
        tags.push(`Season ${season} E${episode}`)
    }
    
    return tags
}

const getQueries = (info) => {
    const name = info.originalName || info.name
    const names = [name]
    
    // Add alternative language titles if available from metadata
    if (info.altTitles && Array.isArray(info.altTitles)) {
        names.push(...info.altTitles)
    }
    
    // Generate potential localized variants
    const localizedVariants = generateLocalizedVariants(name);
    names.push(...localizedVariants);
    
    // Also try with language tags
    const extraTerms = ['SK', 'CZ']

    if (info.type === 'series') {
        const episodeTags = generateEpisodeTags(info.series, info.episode)
        
        // For series with year available, add year-specific queries 
        if (info.year) {
            console.log(`Adding year ${info.year} to series search queries`)
            // Add year to some queries for better matching
            return [
                ...names.flatMap(name => episodeTags.map(tag => `${name} ${tag}`)),
                ...names.flatMap(name => episodeTags.map(tag => `${name} ${tag} ${info.year}`))
            ]
        } else {
            return names.flatMap(name => episodeTags.map(tag => `${name} ${tag}`))
        }
    } else {
        // For movies, generate more query variants to find matches
        return names.flatMap(name => {
            const base = [name]
            
            // For movies with multiple word titles, also try without articles and common prefixes
            if (name.split(' ').length > 1) {
                // Remove articles and common prefixes for additional search terms
                const simplified = name.replace(/^(the|a|an|le|la|les|el|il|lo|der|die|das) /i, '')
                if (simplified !== name) {
                    base.push(simplified)
                }
            }
            
            if (name.split(' ').length === 1) {
                base.push(...extraTerms.map(term => `${name} ${term}`))
            }
            
            // Always include year in movie searches when available
            if (info.year) {
                console.log(`Adding year ${info.year} to movie search queries`)
                
                // Add versions with year for all base query variants
                const withYearQueries = base.map(variant => `${variant} ${info.year}`)
                base.push(...withYearQueries)
                
                // For movies from 2000 onwards, also try with just the last 2 digits of year
                // (common in filenames)
                if (parseInt(info.year) >= 2000) {
                    const shortYear = info.year.substring(2)
                    base.push(...base.map(variant => `${variant} ${shortYear}`))
                }
            }
            
            return base
        })
    }
}

const search = async (query, token, info) => {
    console.log('🔍 Searching for:', query)
    const data = formencode({ what: query, category: 'video', limit: 100, wst: token })
    const resp = await needle('post', 'https://webshare.cz/api/search/', data, { headers })
    const files = resp.body.children.filter(el => el.name === 'file')

    const queryClean = clean(query)
    const queryWords = queryClean.split(' ').filter(w => w.length > 1)
    console.log('📋 Cleaned query:', queryClean)
    console.log('📚 Query words:', queryWords)

    // Extract main title and year for movie matching
    let mainTitle = info.name
    let year = info.year

    // For movies, extract potential year from title if not provided separately
    if (info.type === 'movie' && !year) {
        const yearMatch = mainTitle.match(/\b(19|20)\d{2}\b/)
        if (yearMatch) {
            year = yearMatch[0]
            mainTitle = mainTitle.replace(yearMatch[0], '').trim()
        }
    }

    return files.map(el => {
        // ...existing code...
    })
    .filter(item => !item.protected)
    .map(item => {
        const simpleName = clean(item.name)
        let matchScore = 0

        const looksLikeDate = /\b(19|20)\d{2}\b/.test(item.name) || /\b\d{1,2}[.\-_ ]\d{1,2}[.\-_ ]\d{2,4}\b/.test(item.name)
        
        // Improve title matching to recognize alternative titles
        const possibleTitles = [clean(info.name)]
        if (info.originalName) possibleTitles.push(clean(info.originalName))
        
        const titleInName = possibleTitles.some(title => simpleName.includes(title))

        // For movies, be more lenient with matching
        if (info.type === 'movie') {
            // ...existing code...
            
            // Check for year match, which is a strong indicator of relevance for movies
            if (year && simpleName.includes(year)) {
                // Give a big boost if the file has the exact year
                matchScore += 0.3
                console.log(`Year match boost for: ${item.name}`)
            } else if (year && parseInt(year) >= 2000) {
                // For recent movies, also check for the short year format (e.g., "22" for 2022)
                const shortYear = year.substring(2)
                if (simpleName.includes(shortYear)) {
                    // Give a smaller boost for short year format
                    matchScore += 0.15
                    console.log(`Short year match boost for: ${item.name}`)
                }
            }
        } else if (info.type === 'series') {
            // Add year matching for series too
            if (year && simpleName.includes(year)) {
                matchScore += 0.2
                console.log(`Year match boost for series: ${item.name}`)
            }
            
            // Continue with existing series matching logic
            if (looksLikeDate && !titleInName) {
                // Only filter out items with dates but no series title for series content
                return null
            }
            
            // ...existing code...
        }

        // ...existing code...

        return { ...item, match: matchScore, simpleName }
    })
    .filter(item => item && item.match > 0)
}

module.exports = { search }