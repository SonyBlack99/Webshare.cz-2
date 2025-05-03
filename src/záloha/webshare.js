const needle = require('needle')
const md5 = require('nano-md5')
const sha1 = require('sha1')
const formencode = require('form-urlencoded')
const { filesize } = require('filesize')
require('dotenv').config()

const headers = {
    content_type: 'application/x-www-form-urlencoded; charset=UTF-8',
    accept: 'text/xml; charset=UTF-8'
}

const clean = str => str
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[\.,\-_\/]/g, " ")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()

const generateEpisodeTags = (series, episode) => {
    const s = series.padStart(2, '0')
    const e = episode.padStart(2, '0')
    return [
        `S${s}E${e}`, `s${s}e${e}`, `${s}x${e}`, `${parseInt(series)}x${parseInt(episode)}`,
        `season${s}episode${e}`, `serie${s}episode${e}`,
        `${s}.${e}`, `${s}_${e}`, `${s} ${e}`,
        `ep${e}`, `episode${e}`, `${s} ep${e}`, `s${s} ep${e}`, `${s}-${e}`
    ]
}

/**
 * Generate possible localized versions of a title
 * This attempts to mimic how Czech/Slovak translations often modify titles
 */
const generateLocalizedVariants = (title) => {
    const variants = [];
    
    // Rule 1: Some English titles are simply kept as-is in Czech/Slovak
    variants.push(title);
    
    // Clean the title for transformation rules
    const cleanTitle = title.toLowerCase().trim();
    
    // Rule 2: "The" is often dropped or moved to the end
    if (cleanTitle.startsWith('the ')) {
        const withoutThe = cleanTitle.substring(4);
        variants.push(withoutThe);
    }
    
    // Rule 3: Some English words are transliterated (phonetic translation)
    // Common patterns for English to Czech/Slovak transliteration
    const transliterationRules = [
        { en: 'c', local: 'k' },     // conclave -> konklave
        { en: 'w', local: 'v' },     // west -> vest
        { en: 'oo', local: 'u' },    // book -> buk
        { en: 'qu', local: 'kv' },   // queen -> kven
        { en: 'th', local: 't' },    // theater -> teater
        { en: 'y', local: 'i' },     // mystery -> misteri
        { en: 'x', local: 'ks' },    // box -> boks
    ];
    
    // Generate transliterated variants
    let transliterated = cleanTitle;
    transliterationRules.forEach(rule => {
        if (transliterated.includes(rule.en)) {
            transliterated = transliterated.replace(new RegExp(rule.en, 'g'), rule.local);
            variants.push(transliterated);
        }
    });
    
    // Rule 4: Sometimes English name becomes totally different in Czech/Slovak
    // We can't hardcode these, but we can look for TV shows/movies with different regional titles
    // in the metadata if available (handled elsewhere)
    
    return [...new Set(variants)]; // Remove duplicates
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
        return names.flatMap(name => episodeTags.map(tag => `${name} ${tag}`))
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
            
            if (info.year) {
                // Add versions with year
                base.forEach(variant => {
                    if (!variant.includes(info.year)) {
                        base.push(`${variant} ${info.year}`)
                    }
                })
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

    // For movies, prepare title variations for better matching
    const movieTitleVariants = []
    if (info.type === 'movie') {
        // Original title
        movieTitleVariants.push(clean(info.name))
        
        // Without articles
        const withoutArticle = clean(info.name).replace(/^(the|a|an) /, '')
        if (withoutArticle !== clean(info.name)) {
            movieTitleVariants.push(withoutArticle)
        }
        
        // Original title in different order (for foreign films that swap name order)
        const words = clean(info.name).split(' ')
        if (words.length > 1) {
            movieTitleVariants.push([...words].reverse().join(' '))
        }
        
        // Add known translations
        if (info.originalName) {
            movieTitleVariants.push(clean(info.originalName))
        }
        
        // Add potential localized variants
        generateLocalizedVariants(info.name).forEach(variant => {
            movieTitleVariants.push(clean(variant))
        })
    }

    return files.map(el => {
        const ident = el.children.find(el => el.name === 'ident').value
        const size = el.children.find(el => el.name === 'size').value
        const posVotes = el.children.find(el => el.name === 'positive_votes').value
        const negVotes = el.children.find(el => el.name === 'negative_votes').value
        const name = el.children.find(el => el.name === 'name').value
        const protectedFile = el.children.find(el => el.name === 'password')

        return {
            ident,
            name,
            size,
            posVotes,
            negVotes,
            protected: protectedFile && protectedFile.value === '1'
        }
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
            // Extract words from movie title to match against
            const titleWords = clean(mainTitle).split(' ').filter(w => w.length > 2)
            const nameWords = simpleName.split(' ')
            
            // Check against all title variants
            let bestMatchScore = 0
            for (const variant of movieTitleVariants) {
                const variantWords = variant.split(' ').filter(w => w.length > 2)
                const matchingWords = variantWords.filter(word => nameWords.includes(word))
                const titleMatchScore = matchingWords.length / variantWords.length
                
                if (titleMatchScore > bestMatchScore) {
                    bestMatchScore = titleMatchScore
                }
            }
            
            // For movies, if the match seems reasonable and year matches (if specified), give a good score
            if (bestMatchScore > 0.5) {
                matchScore = 0.5 + bestMatchScore * 0.5
                
                // If year is specified and matches, bonus points
                if (year && simpleName.includes(year)) {
                    matchScore += 0.2
                }
            }
            
            // For movies, be more lenient - don't discard results that look like they might match
            if (bestMatchScore > 0.3) {
                matchScore = Math.max(matchScore, 0.3)
            }
            
            // Special handling for known generic terms that often cause false matches
            const genericTerms = ['1080p', '720p', '2160p', 'hdtv', 'brrip', 'webrip']
            if (genericTerms.every(term => !simpleName.includes(term) || 
                                          simpleName.indexOf(term) > simpleName.length/2)) {
                // If these terms appear only in the second half of the filename, they're probably format descriptors
                // not part of another movie's title
                
                // Check for year match, which is a strong indicator of relevance for movies
                if (year && simpleName.includes(year)) {
                    matchScore = Math.max(matchScore, 0.4)  // Ensure a minimum score if the year matches
                }
            }
        } else if (info.type === 'series' && looksLikeDate && !titleInName) {
            // Only filter out items with dates but no series title for series content
            return null
        }

        // ÚPLNE VYRAĎ, ak neobsahuje ani názov seriálu, ani tag epizódy
        if (info.type === 'series') {
            const episodeTags = generateEpisodeTags(info.series, info.episode).map(clean)
            const hasTag = episodeTags.some(tag => simpleName.includes(tag))
            const hasTitle = possibleTitles.some(title => simpleName.includes(title))
            if (!hasTag && !hasTitle) return null
        }

        if (queryWords.length === 1) {
            if (simpleName === queryClean) matchScore = 1.0
            else if (simpleName.startsWith(queryClean)) matchScore = 0.95
            else if (simpleName.includes(queryClean)) matchScore = 0.6
        } else {
            const matches = queryWords.filter(word => simpleName.includes(word)).length
            const baseScore = matches / queryWords.length
            matchScore = Math.max(matchScore, baseScore)

            if (simpleName.startsWith(queryClean)) {
                matchScore += 0.2
            }
        }

        // For movies, check for exact title match but be more lenient with sequels
        if (info.type === 'movie') {
            // Check if the file starts with any of our title variants
            const startsWithTitle = movieTitleVariants.some(variant => 
                simpleName.startsWith(variant) || simpleName.includes(variant)
            )
            
            if (startsWithTitle) {
                matchScore += 0.3
            }
        }

        if (info.type === 'series') {
            const episodeTags = generateEpisodeTags(info.series, info.episode).map(clean)
            const matchedTag = episodeTags.find(tag => simpleName.includes(tag))
            if (matchedTag) matchScore += 0.3
            else matchScore *= 0.5

            const nameWords = possibleTitles.flatMap(title => title.split(' '))
            const titleWords = simpleName.split(' ')
            const titleMatch = nameWords.some(word => titleWords.includes(word))
            if (titleMatch) {
                matchScore += 0.4
            } else {
                matchScore *= 0.7
            }
        }

        return { ...item, match: matchScore, simpleName }
    })
    .filter(item => item && item.match > 0)
}

const webshare = {
    login: async () => {
        const user = process.env.WEBSHARE_LOGIN
        const password = process.env.WEBSHARE_PASSWORD
        console.log(`🔑 Logging in user ${user}`)
        const saltResp = await needle('post', 'https://webshare.cz/api/salt/', `username_or_email=${user}`, { headers })
        const salt = saltResp.body.children.find(el => el.name === 'salt').value

        const passEncoded = sha1(md5.crypt(password, salt))
        const data = formencode({ username_or_email: user, password: passEncoded, keep_logged_in: 0 })
        const resp = await needle('post', 'https://webshare.cz/api/login/', data, { headers })
        if (resp.statusCode !== 200 || resp.body.children.find(el => el.name === 'status').value !== 'OK') {
            throw Error('Cannot log in to Webshare.cz, invalid login credentials')
        }
        return resp.body.children.find(el => el.name === 'token').value
    },

    search: async (showInfo, token) => {
        const queries = getQueries(showInfo)
        let results = await Promise.all(queries.map(query => search(query, token, showInfo)))
        results = results.flatMap(items => items)

        const isPreferredDabing = (name) => {
            const dabingPatterns = [/\bSK\b/i, /\bCZ\b/i, /\bdabing\b/i, /\bSKdab\b/i, /\bCZdab\b/i]
            const titulkyPatterns = [/CZ ?tit(ulky)?/i, /SK ?tit(ulky)?/i, /\btitulky\b/i, /\bsubs\b/i]

            if (dabingPatterns.some(p => p.test(name))) return 2
            if (titulkyPatterns.some(p => p.test(name))) return 1
            return 0
        }

        const uniqueResultsMap = new Map()
        results.forEach(item => {
            const key = `${item.name}-${item.size}`
            if (!uniqueResultsMap.has(key) || uniqueResultsMap.get(key).posVotes < item.posVotes) {
                uniqueResultsMap.set(key, item)
            }
        })

        const uniqueResults = Array.from(uniqueResultsMap.values())

        // For series: Score each result specifically based on episode match and title match
        // This additional pre-scoring helps prioritize relevant episodes
        if (showInfo.type === 'series') {
            const episodeTags = generateEpisodeTags(showInfo.series, showInfo.episode).map(clean)
            
            // Get possible show titles - include both original and translations
            const possibleTitles = [clean(showInfo.name)]
            if (showInfo.originalName) possibleTitles.push(clean(showInfo.originalName))
            
            // Print debug info for series title matching
            console.log('🔍 Looking for series with possible titles:', possibleTitles.join(', '))
            
            uniqueResults.forEach(item => {
                // Series relevance score starts at 0
                let seriesRelevance = 0
                
                // Episode tag match is MOST important (up to 10 points)
                if (episodeTags.some(tag => item.simpleName.includes(tag))) {
                    seriesRelevance += 10
                    
                    // Check for ANY title match, not just the first title
                    const matchedTitle = possibleTitles.find(title => item.simpleName.includes(title))
                    if (matchedTitle) {
                        // If it also has any of the series titles, it's very likely relevant
                        seriesRelevance += 5
                        
                        // For debugging - show which title matched
                        console.log(`🎯 Found match for "${matchedTitle}" in "${item.name}"`)
                    }
                }
                
                // Store this score for sorting
                item.seriesRelevance = seriesRelevance
                
                // Also store which title variant matched for better sorting
                item.matchedTitle = possibleTitles.find(title => item.simpleName.includes(title)) || ''
                
                // Critical: Mark the filename language for filtering - without using specific titles
                // Check for localized version indicators in the filename
                const localizedPattern = /(?:\b(?:CZ|SK)\b|dabing|dab|titulky|tit\b)/i;
                // Original version indicators (typically English)
                const originalPattern = /(?:\b(?:EN|ENG)\b|\bUS\b|HDTV|\bx264|\bh26[45]|webrip|720p|1080p|2160p|bluray)/i;
                
                if (localizedPattern.test(item.name)) {
                    item.isLocalizedVersion = true;
                } else if (originalPattern.test(item.name)) {
                    item.isLocalizedVersion = false;
                } else {
                    // If no clear indicators, default to assuming it's original based on series relevance
                    item.isLocalizedVersion = false;
                }
            })
        }

        uniqueResults.sort((a, b) => {
            // For series, use our specialized relevance score as the highest priority
            if (showInfo.type === 'series') {
                // First sort by episode relevance
                if (a.seriesRelevance !== b.seriesRelevance) {
                    return b.seriesRelevance - a.seriesRelevance
                }
                
                // If episode relevance is the same and both have the requested title
                // (either original or translation), preserve the order they were found in
                const requestedTitle = clean(showInfo.name);
                if (a.seriesRelevance > 0 && b.seriesRelevance > 0) {
                    const aHasRequestedTitle = a.simpleName.includes(requestedTitle);
                    const bHasRequestedTitle = b.simpleName.includes(requestedTitle);
                    
                    // Prioritize exact title matches for the requested title
                    if (aHasRequestedTitle && !bHasRequestedTitle) return -1;
                    if (!aHasRequestedTitle && bHasRequestedTitle) return 1;
                }
            }
            
            // For movies, prioritize exact title matches first
            if (showInfo.type === 'movie') {
                const exactTitleA = a.simpleName.startsWith(clean(showInfo.name))
                const exactTitleB = b.simpleName.startsWith(clean(showInfo.name))
                
                // Check for year match if available
                const yearA = showInfo.year && a.simpleName.includes(showInfo.year)
                const yearB = showInfo.year && b.simpleName.includes(showInfo.year)
                
                // Prioritize both title and year match
                if ((exactTitleA && yearA) && !(exactTitleB && yearB)) return -1
                if (!(exactTitleA && yearA) && (exactTitleB && yearB)) return 1
                
                // Then just title match
                if (exactTitleA && !exactTitleB) return -1
                if (!exactTitleA && exactTitleB) return 1
            }
            
            // For series, prioritize exact episode matches first
            if (showInfo.type === 'series') {
                const episodeTags = generateEpisodeTags(showInfo.series, showInfo.episode).map(clean)
                
                // Check if both have exact episode tags
                const aHasExactTag = episodeTags.some(tag => a.simpleName.includes(tag))
                const bHasExactTag = episodeTags.some(tag => b.simpleName.includes(tag))
                
                // If only one has the exact tag, prioritize it
                if (aHasExactTag && !bHasExactTag) return -1
                if (!aHasExactTag && bHasExactTag) return 1
            }
            
            // Next check for dubbing preferences
            const dabA = isPreferredDabing(a.name)
            const dabB = isPreferredDabing(b.name)

            if (dabA !== dabB) return dabB - dabA

            // Next priority: match score
            if (a.match !== b.match) return b.match - a.match

            // If match scores are equal, sort by size (bigger first)
            return b.size - a.size
        })

        // Add debug information to see how matching works
        console.log("SORTED RESULTS PREVIEW:")
        uniqueResults.slice(0, 10).forEach((item, i) => {
            console.log(`${i+1}. ${item.name} | Score: ${item.match}${
                showInfo.type === 'series' ? ` | Series Relevance: ${item.seriesRelevance}` : ''
            } | Size: ${item.size}`)
        })

        // Filter results more intelligently
        let filteredResults = uniqueResults
        if (showInfo.type === 'movie') {
            // For movies, get possible title variants for matching
            const movieTitleVariants = [clean(showInfo.name)]
            if (showInfo.originalName) {
                movieTitleVariants.push(clean(showInfo.originalName))
            }
            
            // For titles with "A" or "The", also add version without the article
            const withoutArticle = clean(showInfo.name).replace(/^(a|the) /, '')
            if (withoutArticle !== clean(showInfo.name)) {
                movieTitleVariants.push(withoutArticle)
            }
            
            // Get the movie year if available
            const movieYear = showInfo.year || ''
            
            // Extract meaningful keywords from the movie title for filtering
            // Words that are too generic or common should be excluded
            const titleWords = clean(showInfo.name).split(' ')
                .filter(w => w.length > 2 && !['the', 'and', 'for', 'with', 'from'].includes(w))
            
            console.log(`Movie title variants: ${movieTitleVariants.join(', ')}`);
            console.log(`Title keywords: ${titleWords.join(', ')}`);
            console.log(`Movie year: ${movieYear}`);
            
            // Debug array to track rejected items and why they were filtered
            const rejectedItems = [];
            
            // For titles with queries containing "CZ" or "SK", be more lenient (like in "Conclave CZ" search)
            // This helps find localized versions
            const queriesHadLanguageTag = queries.some(q => 
                /\b(?:cz|sk)\b/i.test(q) || q.toLowerCase().includes('dabing'));
            
            console.log(`Search queries included language tags: ${queriesHadLanguageTag}`);
                
            // First try smarter filtering - but be smarter about query patterns
            filteredResults = uniqueResults.filter(item => {
                // Debug info - analyze this item
                let reason = "";
                
                // 1. High score matches are always relevant
                if (item.match > 0.7) {
                    return true;
                }
                
                // Keep results with the movie title or significant part of it
                const hasTitle = movieTitleVariants.some(variant => 
                    item.simpleName.includes(clean(variant)));
                
                // Check if it contains any significant word from the title
                const fileWords = item.simpleName.split(' ');
                const hasTitleWord = titleWords.some(word => fileWords.includes(word));
                
                // 2. Files with title or title words are relevant
                if (hasTitle || hasTitleWord) {
                    return true;
                }
                
                // 3. Year match with a reasonable score is relevant
                const hasYear = movieYear && item.simpleName.includes(movieYear);
                if (hasYear && item.match > 0.2) {
                    return true;
                }
                
                // 4. If queries used CZ/SK tags and the result has CZ/SK in the name
                // AND has a decent match score, it's likely relevant
                if (queriesHadLanguageTag && 
                    (item.name.includes('CZ') || item.name.includes('SK')) && 
                    item.match > 0.5) {
                    return true;
                }
                
                // 5. Files that match query patterns and have valid video extensions
                const validExtension = /\.(mkv|mp4|avi|mov|wmv)$/i.test(item.name);
                if (validExtension && item.match > 0.5) {
                    return true;
                }
                
                // Track items we reject for debugging
                reason = `Failed criteria: match=${item.match.toFixed(2)}, ` +
                    `title=${hasTitle}, titleWord=${hasTitleWord}, year=${hasYear}, ext=${validExtension}`;
                
                rejectedItems.push({
                    name: item.name,
                    score: item.match,
                    reason: reason
                });
                
                return false;
            });
            
            // Log rejected items to understand filtering
            console.log(`==== REJECTED ${rejectedItems.length} ITEMS ====`);
            const topRejected = rejectedItems
                .sort((a, b) => b.score - a.score)
                .slice(0, 10); // Show top 10 rejected items by score
                
            topRejected.forEach(item => {
                console.log(`🚫 ${item.name} | Score: ${item.score.toFixed(2)} | ${item.reason}`);
            });
            
            console.log(`Filtered from ${uniqueResults.length} to ${filteredResults.length} results using improved movie filtering`);
            
            // If we've filtered too aggressively, use a more relaxed approach
            if (filteredResults.length < 10 && uniqueResults.length > 20) {
                console.log("⚠️ Few results after filtering. Applying relaxed filtering...");
                
                // For movies, use a smart fallback approach that mirrors the old addon
                // but still tries to exclude obvious non-matches
                const relaxedResults = uniqueResults.filter(item => {
                    // 1. High match scores are always good
                    if (item.match >= 0.4) {
                        return true;
                    }
                    
                    // 2. Files with video extensions that have the title or CZ/SK markers are good
                    const hasVideoExt = /\.(mkv|mp4|avi|mov|wmv)$/i.test(item.name);
                    const hasLanguageTag = /\b(?:CZ|SK)\b/i.test(item.name);
                    
                    if (hasVideoExt && (hasLanguageTag || 
                        movieTitleVariants.some(v => item.simpleName.includes(clean(v))))) {
                        return true;
                    }
                    
                    // 3. Files with exact year matches are good indicators
                    if (movieYear && item.simpleName.includes(movieYear) && item.match > 0.2) {
                        return true;
                    }
                    
                    // 4. Beyond 20 results, start being more selective
                    return item.match >= 0.3;
                });
                
                console.log(`Relaxed filtering: found ${relaxedResults.length} results`);
                
                // Use relaxed results but ensure a reasonable limit
                const maxResults = Math.min(40, relaxedResults.length);
                if (relaxedResults.length > filteredResults.length) {
                    console.log(`📊 Using relaxed filtering to show ${maxResults} results`);
                    filteredResults = relaxedResults.slice(0, maxResults);
                }
            }
        }

        // Sort filtered results to ensure most relevant appear first
        filteredResults.sort((a, b) => {
            // For movies, prioritize exact title matches first
            if (showInfo.type === 'movie') {
                // Exact title pattern
                const exactTitleA = a.simpleName.startsWith(clean(showInfo.name))
                const exactTitleB = b.simpleName.startsWith(clean(showInfo.name))
                
                // Year match
                const yearA = showInfo.year && a.simpleName.includes(showInfo.year)
                const yearB = showInfo.year && b.simpleName.includes(showInfo.year)
                
                // Title and year is best case
                if ((exactTitleA && yearA) && !(exactTitleB && yearB)) return -1
                if (!(exactTitleA && yearA) && (exactTitleB && yearB)) return 1
                
                // Just title is second best
                if (exactTitleA && !exactTitleB) return -1
                if (!exactTitleA && exactTitleB) return 1
            }
            
            // Next check for dubbing preferences
            const dabA = isPreferredDabing(a.name)
            const dabB = isPreferredDabing(b.name)

            if (dabA !== dabB) return dabB - dabA

            // Next priority: match score
            if (a.match !== b.match) return b.match - a.match

            // If match scores are equal, sort by size (bigger first)
            return b.size - a.size
        })

        // Dynamic limit based on content type
        const limit = showInfo.type === 'movie' ? 40 : 30
        
        // For series, we need to ensure we include both localized and original language versions
        if (showInfo.type === 'series') {
            // First, identify high-relevance items (with episode tag AND title match)
            const highRelevanceItems = filteredResults.filter(item => item.seriesRelevance >= 15);
            
            if (highRelevanceItems.length > 0) {
                // Find if we have both localized and original language versions
                const hasLocalizedVersions = highRelevanceItems.some(item => item.isLocalizedVersion);
                const hasOriginalVersions = highRelevanceItems.some(item => !item.isLocalizedVersion);
                
                console.log(`Series has localized versions: ${hasLocalizedVersions}, original versions: ${hasOriginalVersions}`);
                
                // If we have both types, make sure we include at least one of each type
                if (hasLocalizedVersions && hasOriginalVersions) {
                    // Get the best localized and original versions
                    const localizedItems = highRelevanceItems.filter(item => item.isLocalizedVersion);
                    const originalItems = highRelevanceItems.filter(item => !item.isLocalizedVersion);
                    
                    // Sort by match score and size
                    const bestLocalizedItem = localizedItems.length > 0 ? 
                        localizedItems.sort((a, b) => b.match - a.match || b.size - a.size)[0] : null;
                    
                    const bestOriginalItem = originalItems.length > 0 ? 
                        originalItems.sort((a, b) => b.match - a.match || b.size - a.size)[0] : null;
                    
                    console.log("Best localized:", bestLocalizedItem?.name);
                    console.log("Best original:", bestOriginalItem?.name);
                    
                    // Create a new array with both versions at the top
                    const forcedItems = [];
                    
                    // Add localized version
                    if (bestLocalizedItem) {
                        forcedItems.push(bestLocalizedItem);
                    }
                    
                    // Add original version
                    if (bestOriginalItem && bestLocalizedItem?.name !== bestOriginalItem?.name) {
                        forcedItems.push(bestOriginalItem);
                        console.log("Including both localized and original versions in results");
                    }
                    
                    // Only include other results that aren't these two
                    const otherResults = filteredResults.filter(item => 
                        item.name !== bestLocalizedItem?.name && 
                        item.name !== bestOriginalItem?.name);
                    
                    filteredResults = [...forcedItems, ...otherResults];
                    
                    // Force log the first few results after our intervention
                    console.log("FINAL RESULTS ORDER (first 5):");
                    filteredResults.slice(0, 5).forEach((item, i) => {
                        console.log(`${i+1}: ${item.name}`);
                    });
                }
            }
        }
        
        // Map the final results to the format expected by Stremio
        const finalResults = filteredResults.map(item => ({
            ident: item.ident,
            description: item.name,
            name: `💾 ${filesize(item.size)} 👍 ${item.posVotes} 👎 ${item.negVotes}`
        })).slice(0, limit);
        
        // Debug the final output sent to Stremio
        console.log(`Sending ${finalResults.length} results to Stremio`);
        console.log("First 3 results descriptions:", finalResults.slice(0, 3).map(r => r.description).join(", "));
        
        return finalResults;
    },

    addUrlToStreams: (streams, token) => {
        return Promise.all(streams.map(async stream => {
            const { ident, ...restStream } = stream
            const data = formencode({ ident, download_type: 'video_stream', force_https: 1, wst: token })
            const resp = await needle('post', 'https://webshare.cz/api/file_link/', data, { headers })
            const status = resp.body.children.find(el => el.name === 'status').value
            if (status === 'OK') {
                const url = resp.body.children.find(el => el.name === 'link').value
                return { ...restStream, url }
            } else {
                return restStream
            }
        }))
    }
}

module.exports = webshare
