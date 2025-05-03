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
    
    // Rule 3: Sometimes English name becomes totally different in Czech/Slovak
    // We can't hardcode these, but we can look for TV shows/movies with different regional titles
    // in the metadata if available (handled elsewhere)
    
    return [...new Set(variants)]; // Remove duplicates
}

const getQueries = (info) => {
    // Use original name if available, otherwise use the localized name
    const originalName = info.originalName || info.name
    
    // Start with both original and localized names as search base
    const names = [originalName]
    
    // IMPORTANT: Always add localized name if available and different
    if (info.name && info.originalName && info.name !== info.originalName) {
        names.push(info.name)
    }
    
    // Add alternative language titles if available from metadata
    if (info.altTitles && Array.isArray(info.altTitles)) {
        names.push(...info.altTitles)
    }
    
    // Generate potential localized variants (just removing "The" now)
    const localizedVariants = generateLocalizedVariants(originalName);
    names.push(...localizedVariants);
    
    // Also try with language tags
    const extraTerms = ['SK', 'CZ']

    if (info.type === 'series') {
        const episodeTags = generateEpisodeTags(info.series, info.episode)
        
        // For series with year available, add year-specific queries 
        if (info.year) {
            // Add year to some queries for popular shows that have remakes (like The Office US/UK)
            return [
                ...names.flatMap(name => episodeTags.map(tag => `${name} ${tag}`)),
                ...names.flatMap(name => [`${name} ${info.year} ${episodeTags[0]}`, `${name} (${info.year}) ${episodeTags[0]}`])
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
            
            if (info.year) {
                // Add versions with year
                base.forEach(variant => {
                    if (!variant.includes(info.year)) {
                        base.push(`${variant} ${info.year}`)
                        // Also add version with parentheses
                        base.push(`${variant} (${info.year})`)
                    }
                })
            }
            
            return base
        })
    }
}

const search = async (query, token, info) => {
    const data = formencode({ what: query, category: 'video', limit: 100, wst: token })
    const resp = await needle('post', 'https://webshare.cz/api/search/', data, { headers })
    const files = resp.body.children.filter(el => el.name === 'file')

    const queryClean = clean(query)
    const queryWords = queryClean.split(' ').filter(w => w.length > 1)

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

        // For both movies and series, give a significant boost when title is at the beginning
        // Check early to affect all matches
        const possibleTitles = [clean(info.name)]
        if (info.originalName) possibleTitles.push(clean(info.originalName))
        
        // Find if any of the possible titles appear at the beginning
        const titleAtStart = possibleTitles.some(title => {
            const pos = simpleName.indexOf(title);
            // Consider it at the start if it's the first word or has only a short prefix
            return pos === 0 || pos <= 3;
        });
        
        // Significant boost for title at beginning
        if (titleAtStart) {
            matchScore += 0.6; // Much larger boost
        }

        // Boost scores for localized content - simple version
        if (/\b(?:CZ|SK)\b.*(?:dab|dabing)/i.test(item.name) || 
            /(?:dab|dabing).*\b(?:CZ|SK)\b/i.test(item.name)) {
            // Big boost for CZ/SK dubbing
            matchScore += 0.4;
        } else if (/\b(?:CZ|SK)\b/i.test(item.name)) {
            // Medium boost for just CZ/SK tag
            matchScore += 0.3;
        } else if (/(?:tit(?:ulky)?|sub(?:s)?)/i.test(item.name)) {
            // Smaller boost for subtitles
            matchScore += 0.2;
        }

        const looksLikeDate = /\b(19|20)\d{2}\b/.test(item.name) || /\b\d{1,2}[.\-_ ]\d{1,2}[.\-_ ]\d{2,4}\b/.test(item.name)
        
        // Fix - don't redefine possibleTitles
        const titleInName = possibleTitles.some(title => simpleName.includes(title))

        // Check for series if episode tag directly follows title (no words in between)
        let episodeTagFollowsTitle = false;
        if (info.type === 'series') {
            const episodeTags = generateEpisodeTags(info.series, info.episode).map(clean);
            
            // Find which title variant matched
            const matchedTitle = possibleTitles.find(title => simpleName.includes(title));
            
            // Check if the episode tag follows immediately after the title
            if (matchedTitle) {
                const titleEnd = simpleName.indexOf(matchedTitle) + matchedTitle.length;
                const afterTitle = simpleName.substring(titleEnd).trim();
                
                // Check if any episode tag is at the beginning of the text after the title
                episodeTagFollowsTitle = episodeTags.some(tag => {
                    const tagClean = clean(tag);
                    return afterTitle.startsWith(tagClean) || 
                           afterTitle.substring(0, 3).includes(tagClean);
                });
                
                if (episodeTagFollowsTitle) {
                    // Add big boost when episode tag directly follows the title
                    matchScore += 0.8;
                }
            }
        }
        
        // Store this important property for sorting later
        item.episodeTagFollowsTitle = episodeTagFollowsTitle;
        
        // For titles not at the beginning, reduce relevance significantly 
        // to prevent random matches elsewhere in filename
        if (!titleAtStart && titleInName) {
            // Find the position of the title in the filename
            const matchedTitle = possibleTitles.find(title => simpleName.includes(title));
            if (matchedTitle) {
                const titlePos = simpleName.indexOf(matchedTitle);
                const titleLen = matchedTitle.length;
                
                // Calculate what percentage into the filename the title appears
                const relativePosition = titlePos / simpleName.length;
                
                // Title in middle or end reduces score significantly
                if (relativePosition > 0.4) {
                    // The later the title appears, the more we reduce the score
                    const reduction = 0.5 + (relativePosition * 0.5); // 50-75% reduction
                    matchScore *= (1 - reduction);
                }
            }
        }

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

        // IMPORTANT: If the title is not at the beginning, reduce relevance significantly
        // to prevent random matches elsewhere in filename
        if (!titleAtStart && info.type === 'series') {
            // Determine how far into the file the title appears
            const titlePos = possibleTitles.reduce((best, title) => {
                const pos = simpleName.indexOf(title);
                return pos >= 0 && (best === -1 || pos < best) ? pos : best;
            }, -1);
            
            // If title is in middle or end, drastically reduce score
            if (titlePos > simpleName.length / 3) {
                matchScore *= 0.3; // Reduce by 70%
            }
        }

        return { 
            ...item, 
            match: matchScore, 
            simpleName,
            titleAtStart // Store this for sorting
        }
    })
    .filter(item => item && item.match > 0)
}

const webshare = {
    login: async () => {
        const user = process.env.WEBSHARE_LOGIN
        const password = process.env.WEBSHARE_PASSWORD
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
            // Enhanced pattern matching for different audio localizations
            const dabingPatterns = [
                /\b(?:CZ|SK)\b.*(?:dab|dabing)/i,  // CZ/SK dabing
                /(?:dab|dabing).*\b(?:CZ|SK)\b/i,   // dabing CZ/SK
                /\b(?:CZ|SK)dab\b/i,                // CZdab/SKdab
                /\b(?:CZ|SK)\b/i                    // Just CZ/SK tag
            ]
            const titulkyPatterns = [
                /(?:CZ|SK) ?tit(?:ulky)?/i, 
                /tit(?:ulky)? ?(?:CZ|SK)/i,
                /\btit(?:ulky)?\b/i, 
                /\bsub(?:titles|s)?\b/i
            ]

            // Increased values to make the preference stronger
            if (dabingPatterns.some(p => p.test(name))) return 3
            if (titulkyPatterns.some(p => p.test(name))) return 2
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
            
            uniqueResults.forEach(item => {
                // Series relevance score starts at 0
                let seriesRelevance = 0
                
                // If title appears at beginning, big relevance boost
                if (item.titleAtStart) {
                    seriesRelevance += 8; // Very significant boost
                }
                
                // Episode tag match is MOST important
                if (episodeTags.some(tag => item.simpleName.includes(tag))) {
                    seriesRelevance += 10
                    
                    // Check for ANY title match
                    const matchedTitle = possibleTitles.find(title => item.simpleName.includes(title))
                    if (matchedTitle) {
                        seriesRelevance += 5
                        
                        // Check if episode tag comes directly after title
                        const titleEnd = item.simpleName.indexOf(matchedTitle) + matchedTitle.length;
                        const afterTitle = item.simpleName.substring(titleEnd).trim();
                        
                        // Check if any episode tag is at the beginning of the text after the title
                        const episodeTagFollowsTitle = episodeTags.some(tag => {
                            const tagClean = clean(tag);
                            return afterTitle.startsWith(tagClean) || 
                                  afterTitle.substring(0, 3).includes(tagClean);
                        });
                        
                        if (episodeTagFollowsTitle) {
                            // Direct title+episode pattern gets maximum points
                            seriesRelevance += 7;
                        }
                        
                        // Store this for sorting
                        item.episodeTagFollowsTitle = episodeTagFollowsTitle;
                    } else {
                        // Make sure to initialize the property even when no title match is found
                        item.episodeTagFollowsTitle = false;
                    }
                } else {
                    // No episode tag match
                    item.episodeTagFollowsTitle = false;
                }
                
                // Always ensure episodeTagFollowsTitle is defined
                if (item.episodeTagFollowsTitle === undefined) {
                    item.episodeTagFollowsTitle = false;
                }
                
                item.seriesRelevance = seriesRelevance;
                
                // Also store which title variant matched for better sorting
                item.matchedTitle = possibleTitles.find(title => item.simpleName.includes(title)) || '';
                
                // NEW: Store title position information for sorting
                if (item.matchedTitle) {
                    item.titlePosition = item.simpleName.indexOf(item.matchedTitle);
                    item.titleAtStart = item.titlePosition <= 3;
                } else {
                    item.titlePosition = -1;
                    item.titleAtStart = false;
                }
                
                // Critical: Mark the filename language for filtering - without using specific titles
                // Improved localized version detection - more accurate for Czech/Slovak content
                const localizedPattern = /(?:\b(?:CZ|SK|SK\.|\[SK\]|\[CZ\])\b|dabing|\bDAB\b|titulky|tit\b|CZ\.|SK\.)/i;
                
                // Make sure we don't miss any localized versions
                const hasCzSkDubbing = /\b(?:CZ|SK)\b.*(?:dab|dabing)/i.test(item.name) || 
                                      /(?:dab|dabing).*\b(?:CZ|SK)\b/i.test(item.name);
                const hasCzSk = /\b(?:CZ|SK)\b|CZ\.|SK\./i.test(item.name);
                const hasSubtitles = /(?:CZ|SK)?\s*(?:tit(?:ulky)?|sub(?:s)?)/i.test(item.name);
                
                // Store detailed info about localization for better sorting later
                item.hasCzSkDubbing = hasCzSkDubbing;
                item.hasCzSk = hasCzSk;
                item.hasSubtitles = hasSubtitles;
                
                // Determine if it's a localized version
                item.isLocalizedVersion = hasCzSkDubbing || hasCzSk || hasSubtitles || localizedPattern.test(item.name);
            })
        }

        uniqueResults.sort((a, b) => {
            // For series, prioritize based on our detailed scoring
            if (showInfo.type === 'series') {
                // First prioritize exact pattern: title directly followed by episode tag
                if (a.episodeTagFollowsTitle && !b.episodeTagFollowsTitle) return -1;
                if (!a.episodeTagFollowsTitle && b.episodeTagFollowsTitle) return 1;
                
                // Then prioritize title at beginning
                if (a.titleAtStart && !b.titleAtStart) return -1;
                if (!a.titleAtStart && b.titleAtStart) return 1;
                
                // Then by series relevance score
                if (a.seriesRelevance !== b.seriesRelevance) {
                    return b.seriesRelevance - a.seriesRelevance;
                }
            }
            
            // For movies, also consider title position
            if (showInfo.type === 'movie') {
                // Prioritize title at start for movies too
                if (a.titleAtStart && !b.titleAtStart) return -1;
                if (!a.titleAtStart && b.titleAtStart) return 1;
                
                // ...existing movie sorting criteria...
            }
            
            // For series, more strongly penalize results where the title is not at the beginning
            if (showInfo.type === 'series') {
                // If one has title at beginning and one doesn't, this is the most important factor
                if (a.titleAtStart && !b.titleAtStart) return -1;
                if (!a.titleAtStart && b.titleAtStart) return 1;
                
                // If both have title at beginning or not, then check episode tag follows title
                if (a.episodeTagFollowsTitle && !b.episodeTagFollowsTitle) return -1;
                if (!a.episodeTagFollowsTitle && b.episodeTagFollowsTitle) return 1;
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
            
            // Debug array to track rejected items and why they were filtered
            const rejectedItems = [];
            
            // For titles with queries containing "CZ" or "SK", also be lenient (like in "Conclave CZ" search)
            // This helps find localized versions
            const queriesHadLanguageTag = queries.some(q => 
                /\b(?:cz|sk)\b/i.test(q) || q.toLowerCase().includes('dabing'));
                
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
                
                // Use relaxed results but ensure a reasonable limit
                const maxResults = Math.min(40, relaxedResults.length);
                if (relaxedResults.length > filteredResults.length) {
                    filteredResults = relaxedResults.slice(0, maxResults);
                }
            }
        }

        // Sort filtered results to ensure most relevant appear first
        filteredResults.sort((a, b) => {
            // For movies, prioritize exact title matches first
            if (showInfo.type === 'movie') {
                // Check for exact match with either original or localized title
                const titleMatchA = showInfo.originalName && a.simpleName.includes(clean(showInfo.originalName)) || 
                                       a.simpleName.includes(clean(showInfo.name))
                const titleMatchB = showInfo.originalName && b.simpleName.includes(clean(showInfo.originalName)) || 
                                       b.simpleName.includes(clean(showInfo.name))
                
                // NEW: Check if title appears at start
                const titleAtStartA = titleMatchA && a.simpleName.indexOf(clean(showInfo.name)) <= 3;
                const titleAtStartB = titleMatchB && b.simpleName.indexOf(clean(showInfo.name)) <= 3;
                
                // Prioritize title at start
                if (titleAtStartA && !titleAtStartB) return -1;
                if (!titleAtStartA && titleAtStartB) return 1;
                
                // Year match
                const yearA = showInfo.year && a.simpleName.includes(showInfo.year);
                const yearB = showInfo.year && b.simpleName.includes(showInfo.year);
                
                // Title and year is best case - give this highest priority
                if ((titleMatchA && yearA) && !(titleMatchB && yearB)) return -1
                if (!(titleMatchA && yearA) && (titleMatchB && yearB)) return 1
                
                // Detect sequels/numbered entries to help sort Die Hard 1 vs Die Hard 2
                const hasSequelNumberA = /\b(part|diel|cast)?\s*[2-9](\b|$)/i.test(a.simpleName) || 
                                       /\b(II|III|IV|V|VI|VII|VIII|IX)\b/.test(a.simpleName);
                const hasSequelNumberB = /\b(part|diel|cast)?\s*[2-9](\b|$)/i.test(b.simpleName) || 
                                       /\b(II|III|IV|V|VI|VII|VIII|IX)\b/.test(b.simpleName);
                
                // If we have the year and one is a sequel but the other isn't, prioritize non-sequel
                if (showInfo.year) {
                    if (!hasSequelNumberA && hasSequelNumberB) return -1
                    if (hasSequelNumberA && !hasSequelNumberB) return 1
                }
                
                // Just title is second best
                if (titleMatchA && !titleMatchB) return -1
                if (!titleMatchA && titleMatchB) return 1
            }
            
            // For series, prioritize based on our detailed scoring
            if (showInfo.type === 'series') {
                // First prioritize exact pattern: title directly followed by episode tag
                if (a.episodeTagFollowsTitle && !b.episodeTagFollowsTitle) return -1;
                if (!a.episodeTagFollowsTitle && b.episodeTagFollowsTitle) return 1;
                
                // Then prioritize title at beginning
                if (a.titleAtStart && !b.titleAtStart) return -1;
                if (!a.titleAtStart && b.titleAtStart) return 1;
                
                // Then by series relevance score
                if (a.seriesRelevance !== b.seriesRelevance) {
                    return b.seriesRelevance - a.seriesRelevance;
                }
            }
            
            // For series, more strongly penalize results where the title is not at the beginning
            if (showInfo.type === 'series') {
                // If one has title at beginning and one doesn't, this is the most important factor
                if (a.titleAtStart && !b.titleAtStart) return -1;
                if (!a.titleAtStart && b.titleAtStart) return 1;
                
                // If both have title at beginning or not, then check episode tag follows title
                if (a.episodeTagFollowsTitle && !b.episodeTagFollowsTitle) return -1;
                if (!a.episodeTagFollowsTitle && b.episodeTagFollowsTitle) return 1;
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
                
                // If we have both types, make sure we include at least one of each type
                if (hasLocalizedVersions && hasOriginalVersions) {
                    // Get the best localized and original versions
                    const localizedItems = highRelevanceItems.filter(item => item.isLocalizedVersion);
                    const originalItems = highRelevanceItems.filter(item => !item.isLocalizedVersion);
                    
                    // Sort by match score and size
                    const bestLocalizedItem = localizedItems.length > 0 ? 
                        localizedItems.sort((a, b) => {
                            // Prioritize title at the beginning
                            if (a.titleAtStart && !b.titleAtStart) return -1;
                            if (!a.titleAtStart && b.titleAtStart) return 1;
                            
                            // First prioritize CZ/SK dubbing
                            if (a.hasCzSkDubbing && !b.hasCzSkDubbing) return -1;
                            if (!a.hasCzSkDubbing && b.hasCzSkDubbing) return 1;
                            
                            // Then CZ/SK tag
                            if (a.hasCzSk && !b.hasCzSk) return -1;
                            if (!a.hasCzSk && b.hasCzSk) return 1;
                            
                            // Then by match score and size
                            return b.match - a.match || b.size - a.size;
                        })[0] : null;
                    
                    const bestOriginalItem = originalItems.length > 0 ? 
                        originalItems.sort((a, b) => {
                            // Prioritize title at the beginning
                            if (a.titleAtStart && !b.titleAtStart) return -1;
                            if (!a.titleAtStart && b.titleAtStart) return 1;
                            
                            return b.match - a.match || b.size - a.size;
                        })[0] : null;
                    
                    // Create a new array with both versions at the top
                    const forcedItems = [];
                    
                    // Add localized version as FIRST item
                    if (bestLocalizedItem) {
                        forcedItems.push(bestLocalizedItem);
                    }
                    
                    // Add original version as SECOND item
                    if (bestOriginalItem && bestLocalizedItem?.name !== bestOriginalItem?.name) {
                        forcedItems.push(bestOriginalItem);
                    }
                    
                    // Only include other results that aren't these two
                    const otherResults = filteredResults.filter(item => 
                        item.name !== bestLocalizedItem?.name && 
                        item.name !== bestOriginalItem?.name);
                        
                    // Sort the remaining results with CZ/SK prioritization
                    otherResults.sort((a, b) => {
                        // First prioritize localized versions
                        if (a.isLocalizedVersion && !b.isLocalizedVersion) return -1;
                        if (!a.isLocalizedVersion && b.isLocalizedVersion) return 1;
                        
                        // For localized versions, prioritize dubbing then subtitles
                        if (a.isLocalizedVersion && b.isLocalizedVersion) {
                            if (a.hasCzSkDubbing && !b.hasCzSkDubbing) return -1;
                            if (!a.hasCzSkDubbing && b.hasCzSkDubbing) return 1;
                        }
                        
                        // Original sorting by match and size
                        return b.match - a.match || b.size - a.size;
                    });
                    
                    // Now merge the forced items with others
                    filteredResults = [...forcedItems, ...otherResults];
                } else if (hasLocalizedVersions) {
                    // If we only have localized versions, prioritize them at the top
                    const localizedItems = highRelevanceItems.filter(item => item.isLocalizedVersion);
                    
                    // Sort by localized quality
                    localizedItems.sort((a, b) => {
                        if (a.hasCzSkDubbing && !b.hasCzSkDubbing) return -1;
                        if (!a.hasCzSkDubbing && b.hasCzSkDubbing) return 1;
                        return b.match - a.match || b.size - a.size;
                    });
                    
                    // Put the best localized items at the top
                    const bestLocalizedItems = localizedItems.slice(0, 2);
                    const otherResults = filteredResults.filter(item => 
                        !bestLocalizedItems.some(best => best.name === item.name));
                    
                    filteredResults = [...bestLocalizedItems, ...otherResults];
                }
            }
        }
        
        // Map the final results to the format expected by Stremio
        const finalResults = filteredResults.map(item => ({
            ident: item.ident,
            description: item.name,
            name: `💾 ${filesize(item.size)} 👍 ${item.posVotes} 👎 ${item.negVotes}`
        })).slice(0, limit);
        
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
    },
    
    // Optimalizovaná verzia addUrlToStreams, ktorá používa chunking pre paralelné spracovanie
    addUrlToStreamsBatch: async (streams, token) => {
        const startTime = Date.now()
        console.log(`⏱️ Adding URLs started for ${streams.length} streams (batched)`)
        
        // Rozdelenie streamov do skupín po 10 pre paralelné spracovanie
        const batchSize = 10
        const batches = []
        
        for (let i = 0; i < streams.length; i += batchSize) {
            batches.push(streams.slice(i, i + batchSize))
        }
        
        console.log(`🔄 Processing in ${batches.length} batches of max ${batchSize} streams`)
        
        // Spracujeme každú dávku postupne, ale v rámci dávky paralelne
        const results = []
        for (let i = 0; i < batches.length; i++) {
            const batchStartTime = Date.now()
            console.log(`⏱️ Processing batch ${i+1}/${batches.length}`)
            
            const batchResults = await Promise.all(batches[i].map(async stream => {
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
            
            results.push(...batchResults)
            console.log(`✅ Batch ${i+1} completed in ${Date.now() - batchStartTime}ms`)
            
            // Pridáme malé oneskorenie medzi dávkami, aby sme nepreťažili server
            if (i < batches.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 100))
            }
        }
        
        console.log(`⏱️ Adding URLs completed in ${Date.now() - startTime}ms (batched mode)`)
        return results
    },
    
    // Simple performance logging methods
    logPerformance: (message, startTime = null) => {
        const now = Date.now()
        if (startTime) {
            console.log(`⏱️ ${message} took ${now - startTime}ms`)
            return now
        } else {
            console.log(`⏱️ ${message} at ${now}`)
            return now
        }
    }
}

// Fix NaN issue with module loading time by ensuring addonStartTime is initialized first
if (!global.addonStartTime) {
    global.addonStartTime = Date.now()
    console.log(`⏱️ Addon startup time initialized`)
}

// Now log the module loading time
const moduleLoadedTime = Date.now()
console.log(`⏱️ Webshare module loaded in ${moduleLoadedTime - global.addonStartTime}ms`)

// Store original methods for performance tracking
const originalLogin = webshare.login
const originalSearch = webshare.search
const originalAddUrlToStreams = webshare.addUrlToStreams

// Wrap methods with performance logging
webshare.login = async () => {
    console.log(`⏱️ Login started`)
    const startTime = Date.now()
    try {
        const result = await originalLogin()
        console.log(`⏱️ Login completed in ${Date.now() - startTime}ms`)
        return result
    } catch (error) {
        console.log(`❌ Login failed after ${Date.now() - startTime}ms: ${error.message}`)
        throw error
    }
}

webshare.search = async (showInfo, token) => {
    console.log(`⏱️ Search started for ${showInfo.type} "${showInfo.name}"`)
    const startTime = Date.now()
    try {
        const result = await originalSearch(showInfo, token)
        console.log(`⏱️ Search completed in ${Date.now() - startTime}ms, found ${result.length} results`)
        return result
    } catch (error) {
        console.log(`❌ Search failed after ${Date.now() - startTime}ms: ${error.message}`)
        throw error
    }
}

webshare.addUrlToStreams = async (streams, token) => {
    console.log(`⏱️ Adding URLs started for ${streams.length} streams`)
    const startTime = Date.now()
    try {
        const result = await originalAddUrlToStreams(streams, token)
        console.log(`⏱️ Adding URLs completed in ${Date.now() - startTime}ms`)
        return result
    } catch (error) {
        console.log(`❌ Adding URLs failed after ${Date.now() - startTime}ms: ${error.message}`)
        throw error
    }
}

// Initialize global start time if not set
if (!global.addonStartTime) {
    global.addonStartTime = Date.now()
    console.log(`⏱️ Addon startup time initialized`)
}

module.exports = webshare
