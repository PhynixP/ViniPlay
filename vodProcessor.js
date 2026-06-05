// vodProcessor.js
const XtreamClient = require('./xtreamClient');

// Helper: a try { BEGIN; ... COMMIT } block can fail BEFORE BEGIN was issued
// (e.g. the upstream fetch threw). In that case an unconditional ROLLBACK
// raises "cannot rollback - no transaction is active" and masks the real
// error. Wrap rollback so failures are logged but don't shadow the upstream
// exception.
async function safeRollback(dbRun, db, phase) {
    try {
        await dbRun(db, "ROLLBACK");
    } catch (rollbackErr) {
        if (!/no transaction is active/i.test(rollbackErr.message || '')) {
            console.warn(`[VOD Processor] ROLLBACK during ${phase} failed: ${rollbackErr.message}`);
        }
    }
}

// Helper: finalize prepared statements, ignoring null/already-finalized ones.
// Used in finally blocks so the underlying SQLite write lock is released even
// when the loop body threw — previously, statements created inside try blocks
// were leaked on error paths until garbage collection eventually ran.
function safeFinalize(...stmts) {
    return Promise.all(stmts.map(s => {
        if (!s) return Promise.resolve();
        return new Promise(resolve => {
            try { s.finalize(() => resolve()); } catch (_) { resolve(); }
        });
    }));
}

/**
 * Main function to refresh all VOD content for a given provider.
 * @param {sqlite.Database} db - The database instance.
 * @param {object} provider - The provider object (id, server_url, username, password).
 * @param {function} sendStatus - Function to send status updates to the client.
 */
async function refreshVodContent(db, dbGet, dbAll, dbRun, provider, sendStatus = () => {}, userAgent) {
    console.log(`[VOD Processor] Starting VOD refresh for: ${provider.name}`);
    const scanStartTime = new Date().toISOString();
    
    let server_url, username, password;
    try {
        if (!provider.xc_data) {
            throw new Error('Provider object is missing xc_data.');
        }
        const xcInfo = JSON.parse(provider.xc_data);
        server_url = xcInfo.server;
        username = xcInfo.username;
        password = xcInfo.password;
        if (!server_url || !username || !password) {
            throw new Error('Missing server, username, or password within xc_data.');
        }
    } catch (parseError) {
        console.error(`[VOD Processor] Failed to parse XC credentials for provider ${provider.name}: ${parseError.message}`);
        sendStatus(`Failed to parse XC credentials for ${provider.name}`, 'error');
        return; // Stop processing this provider if credentials are bad
    }

    const client = new XtreamClient(server_url, username, password, userAgent);
    const providerId = provider.id;

    // --- Schema Migration ---
    try {
        await dbRun(db, "ALTER TABLE movies ADD COLUMN provider_unique_id TEXT");
    } catch (e) {
        if (!e.message.includes('duplicate column name')) {
            console.error('[VOD Processor] Schema migration for movies failed:', e.message);
        }
    }
    try {
        await dbRun(db, "ALTER TABLE series ADD COLUMN provider_unique_id TEXT");
    } catch (e) {
        if (!e.message.includes('duplicate column name')) {
            console.error('[VOD Processor] Schema migration for series failed:', e.message);
        }
    }

    // --- 0. Process Categories ---
    const categoryMap = new Map();
    let categoryInsertStmt = null;
    try {
        sendStatus(`Fetching VOD and Series categories for ${provider.name}...`, 'info');
        const vodCategories = await client.getVodCategories();
        const seriesCategories = await client.getSeriesCategories();

        const allCategories = {};
        if (vodCategories && Array.isArray(vodCategories)) {
            vodCategories.forEach(cat => allCategories[cat.category_id] = cat);
        }
        if (seriesCategories && Array.isArray(seriesCategories)) {
            seriesCategories.forEach(cat => allCategories[cat.category_id] = cat);
        }
        const combinedCategories = Object.values(allCategories);

        if (combinedCategories.length > 0) {
            console.log(`[VOD Processor] Fetched ${combinedCategories.length} combined VOD/Series categories from provider.`);
            sendStatus(`Processing ${combinedCategories.length} VOD/Series categories...`, 'info');

            await dbRun(db, "BEGIN TRANSACTION");
            categoryInsertStmt = db.prepare(`INSERT OR IGNORE INTO vod_categories (category_id, category_name) VALUES (?, ?)`);
            for (const catData of combinedCategories) {
                if (catData.category_id && catData.category_name) {
                    await new Promise((resolve, reject) => {
                        categoryInsertStmt.run(catData.category_id, catData.category_name, function(err) {
                            if (err) return reject(err);
                            resolve(this);
                        });
                    });
                    categoryMap.set(String(catData.category_id), catData.category_name);
                }
            }
            await safeFinalize(categoryInsertStmt);
            categoryInsertStmt = null;
            await dbRun(db, "COMMIT");
        }
    } catch (error) {
        await safeRollback(dbRun, db, 'categories');
        console.error(`[VOD Processor] Category processing FAILED for ${provider.name}:`, error.message);
        sendStatus(`Category processing FAILED for ${provider.name}: ${error.message}`, 'error');
        return; // Stop if categories fail
    } finally {
        await safeFinalize(categoryInsertStmt);
    }

    // Track success of movies/series phases. If either fails the stale-content
    // cleanup at the end MUST be skipped, otherwise it will delete every
    // provider_*_relations row whose last_seen wasn't updated this run — i.e.
    // wipe the entire VOD catalog for this provider after a partial failure.
    let moviesPhaseOk = false;
    let seriesPhaseOk = false;

    // --- 1. Process Movies ---
    let movieInsertStmt = null, movieUpdateStmt = null, relationInsertStmt = null;
    try {
        sendStatus(`Fetching movies for ${provider.name}...`, 'info');
        const movies = await client.getVodStreams();

        if (movies && Array.isArray(movies)) {
            console.log(`[VOD Processor] Fetched ${movies.length} movies from provider.`);
            sendStatus(`Processing ${movies.length} movies...`, 'info');

            await dbRun(db, "BEGIN TRANSACTION");

            const existingMovies = await dbAll(db, 'SELECT id, provider_unique_id FROM movies WHERE provider_unique_id IS NOT NULL');
            const providerUniqueIdMap = new Map(existingMovies.map(m => [m.provider_unique_id, m.id]));

            movieInsertStmt = db.prepare(`INSERT INTO movies (name, year, description, logo, category_name, provider_unique_id) VALUES (?, ?, ?, ?, ?, ?)`);
            movieUpdateStmt = db.prepare(`UPDATE movies SET name = ?, year = ?, description = ?, logo = ?, category_name = ? WHERE id = ?`);
            relationInsertStmt = db.prepare(`INSERT OR REPLACE INTO provider_movie_relations (provider_id, movie_id, stream_id, container_extension, last_seen) VALUES (?, ?, ?, ?, ?)`);

            for (const movieData of movies) {
                const { name, plot, stream_icon, stream_id, container_extension, category_id } = movieData;
                if (!stream_id) continue;

                const providerUniqueId = `movie_${providerId}_${stream_id}`;
                let year = null;
                if (movieData.releaseDate) year = new Date(movieData.releaseDate).getFullYear();
                else if (name) {
                    const yearMatch = name.match(/\((\d{4})\)/);
                    if (yearMatch) year = parseInt(yearMatch[1]);
                }
                const categoryName = categoryMap.get(String(category_id)) || 'VOD';

                let movieId = providerUniqueIdMap.get(providerUniqueId);

                if (movieId) {
                    // Update existing movie
                    await new Promise((resolve, reject) => movieUpdateStmt.run(name, year, plot, stream_icon, categoryName, movieId, (err) => err ? reject(err) : resolve()));
                } else {
                    // Create new movie
                    const result = await new Promise((resolve, reject) => {
                        movieInsertStmt.run(name, year, plot, stream_icon, categoryName, providerUniqueId, function(err) {
                            if (err) return reject(err);
                            resolve(this);
                        });
                    });
                    movieId = result.lastID;
                    providerUniqueIdMap.set(providerUniqueId, movieId);
                }
                
                await new Promise((resolve, reject) => relationInsertStmt.run(providerId, movieId, stream_id, container_extension || 'mp4', scanStartTime, (err) => err ? reject(err) : resolve()));
            }
            await safeFinalize(movieInsertStmt, movieUpdateStmt, relationInsertStmt);
            movieInsertStmt = movieUpdateStmt = relationInsertStmt = null;
            await dbRun(db, "COMMIT");
        }
        moviesPhaseOk = true;
    } catch (error) {
        await safeRollback(dbRun, db, 'movies');
        console.error(`[VOD Processor] Movie processing FAILED for ${provider.name}:`, error.message);
        sendStatus(`Movie processing FAILED for ${provider.name}: ${error.message}`, 'error');
    } finally {
        await safeFinalize(movieInsertStmt, movieUpdateStmt, relationInsertStmt);
    }

    // --- 2. Process Series ---
    let seriesInsertStmt = null, seriesUpdateStmt = null, seriesRelationInsertStmt = null;
    try {
        sendStatus(`Fetching series for ${provider.name}...`, 'info');
        const series = await client.getSeries();

        if (series && Array.isArray(series)) {
            console.log(`[VOD Processor] Fetched ${series.length} series from provider.`);
            sendStatus(`Processing ${series.length} series...`, 'info');

            await dbRun(db, "BEGIN TRANSACTION");

            const existingSeries = await dbAll(db, 'SELECT id, provider_unique_id FROM series WHERE provider_unique_id IS NOT NULL');
            const providerUniqueIdMap = new Map(existingSeries.map(s => [s.provider_unique_id, s.id]));

            seriesInsertStmt = db.prepare(`INSERT INTO series (name, year, description, logo, category_name, provider_unique_id) VALUES (?, ?, ?, ?, ?, ?)`);
            seriesUpdateStmt = db.prepare(`UPDATE series SET name = ?, year = ?, description = ?, logo = ?, category_name = ? WHERE id = ?`);
            seriesRelationInsertStmt = db.prepare(`INSERT OR REPLACE INTO provider_series_relations (provider_id, series_id, external_series_id, last_seen) VALUES (?, ?, ?, ?)`);

            for (const seriesData of series) {
                const { name, plot, cover, series_id: external_series_id, category_id } = seriesData;
                if (!external_series_id) continue;

                const providerUniqueId = `series_${providerId}_${external_series_id}`;
                let year = null;
                if (seriesData.releaseDate) year = new Date(seriesData.releaseDate).getFullYear();
                else if (name) {
                    const yearMatch = name.match(/\((\d{4})\)/);
                    if (yearMatch) year = parseInt(yearMatch[1]);
                }
                const categoryName = categoryMap.get(String(category_id)) || 'Series';

                let seriesId = providerUniqueIdMap.get(providerUniqueId);

                if (seriesId) {
                    // Update existing series
                    await new Promise((resolve, reject) => seriesUpdateStmt.run(name, year, plot, cover, categoryName, seriesId, (err) => err ? reject(err) : resolve()));
                } else {
                    // Create new series
                    const result = await new Promise((resolve, reject) => {
                        seriesInsertStmt.run(name, year, plot, cover, categoryName, providerUniqueId, function(err) {
                            if (err) return reject(err);
                            resolve(this);
                        });
                    });
                    seriesId = result.lastID;
                    providerUniqueIdMap.set(providerUniqueId, seriesId);
                }

                await new Promise((resolve, reject) => seriesRelationInsertStmt.run(providerId, seriesId, external_series_id, scanStartTime, (err) => err ? reject(err) : resolve()));
            }
            await safeFinalize(seriesInsertStmt, seriesUpdateStmt, seriesRelationInsertStmt);
            seriesInsertStmt = seriesUpdateStmt = seriesRelationInsertStmt = null;
            await dbRun(db, "COMMIT");
        }
        seriesPhaseOk = true;
    } catch (error) {
        await safeRollback(dbRun, db, 'series');
        console.error(`[VOD Processor] Series processing FAILED for ${provider.name}:`, error.message);
        sendStatus(`Series processing FAILED for ${provider.name}: ${error.message}`, 'error');
    } finally {
        await safeFinalize(seriesInsertStmt, seriesUpdateStmt, seriesRelationInsertStmt);
    }

    if (!moviesPhaseOk || !seriesPhaseOk) {
        const failed = !moviesPhaseOk && !seriesPhaseOk ? 'movies and series' : (!moviesPhaseOk ? 'movies' : 'series');
        console.warn(`[VOD Processor] Skipping stale-content cleanup for ${provider.name} because the ${failed} phase failed — otherwise rows whose last_seen wasn't refreshed would be deleted, wiping the catalog.`);
        sendStatus(`Skipped stale cleanup for ${provider.name} due to earlier failure.`, 'warning');
        return;
    }

    // --- 4. Cleanup Stale Content ---
    try {
        console.log(`[VOD Processor] Cleaning up stale VOD content for ${provider.name}...`);
        sendStatus(`Cleaning up old VOD entries for ${provider.name}...`, 'info');
        
        await dbRun(db, "BEGIN TRANSACTION");
        
        const staleMovies = await dbRun(db, 'DELETE FROM provider_movie_relations WHERE provider_id = ? AND last_seen < ?', [providerId, scanStartTime]);
        if (staleMovies.changes > 0) console.log(`[VOD Processor] Removed ${staleMovies.changes} stale movie relations.`);

        const staleSeries = await dbRun(db, 'DELETE FROM provider_series_relations WHERE provider_id = ? AND last_seen < ?', [providerId, scanStartTime]);
        if (staleSeries.changes > 0) console.log(`[VOD Processor] Removed ${staleSeries.changes} stale series relations.`);

        const staleEpisodes = await dbRun(db, 'DELETE FROM provider_episode_relations WHERE provider_id = ? AND last_seen < ?', [providerId, scanStartTime]);
        if (staleEpisodes.changes > 0) console.log(`[VOD Processor] Removed ${staleEpisodes.changes} stale episode relations.`);

        // --- 5. Cleanup Orphaned Content ---
        await dbRun(db, `DELETE FROM movies WHERE id NOT IN (SELECT DISTINCT movie_id FROM provider_movie_relations)`);
        await dbRun(db, `DELETE FROM series WHERE id NOT IN (SELECT DISTINCT series_id FROM provider_series_relations)`);
        await dbRun(db, `DELETE FROM episodes WHERE id NOT IN (SELECT DISTINCT episode_id FROM provider_episode_relations)`);
        
        await dbRun(db, "COMMIT");
        console.log(`[VOD Processor] VOD cleanup completed for: ${provider.name}`);
    } catch (error) {
        await safeRollback(dbRun, db, 'cleanup');
        console.error(`[VOD Processor] Cleanup FAILED for ${provider.name}:`, error.message);
        sendStatus(`Cleanup FAILED for ${provider.name}: ${error.message}`, 'error');
    }
    
    console.log(`[VOD Processor] VOD refresh completed for: ${provider.name}`);
    sendStatus(`VOD refresh successful for ${provider.name}.`, 'success');
}

/**
 * Processes VOD content from a raw M3U file string.
 * @param {sqlite.Database} db - The database instance.
 * @param {function} dbGet - Promisified db.get.
 * @param {function} dbAll - Promisified db.all.
 * @param {function} dbRun - Promisified db.run.
 * @param {string} m3uContent - The full M3U file content as a string.
 * @param {object} provider - The provider object from settings.
 * @param {function} sendStatus - Function to send status updates to the client.
 */
async function processM3uVod(db, dbGet, dbAll, dbRun, m3uContent, provider, sendStatus = () => {}) {
    console.log(`[VOD Processor M3U] Starting VOD processing for M3U source: ${provider.name}`);
    const scanStartTime = new Date().toISOString();
    const providerId = provider.id;

    let movieInsertStmt = null, movieRelationInsertStmt = null;
    let seriesInsertStmt = null, seriesRelationInsertStmt = null;
    try {
        const lines = m3uContent.split('\n');
        let currentExtInf = null;
        const movies = [];
        const series = [];

        // Regex to extract attributes from #EXTINF
        const attributeRegex = /([a-zA-Z0-9_-]+)="([^"]*)"/g;

        for (const line of lines) {
            if (line.startsWith('#EXTINF:')) {
                currentExtInf = { line: line.trim(), attributes: {} };
                let match;
                while ((match = attributeRegex.exec(line)) !== null) {
                    currentExtInf.attributes[match[1]] = match[2];
                }
                const nameMatch = line.match(/,(.*)$/);
                currentExtInf.name = nameMatch ? nameMatch[1].trim() : 'Untitled';
            } else if (line.trim().startsWith('http') && currentExtInf) {
                const url = line.trim();
                const isMovie = url.includes('/movie/') || currentExtInf.attributes['tvg-type'] === 'movie';
                const isSeries = url.includes('/series/') || currentExtInf.attributes['tvg-type'] === 'series';

                if (isMovie) {
                    movies.push({ ...currentExtInf, url });
                } else if (isSeries) {
                    series.push({ ...currentExtInf, url });
                }
                currentExtInf = null; // Reset after processing a URL
            }
        }

        console.log(`[VOD Processor M3U] Found ${movies.length} movies and ${series.length} series in M3U.`);
        sendStatus(`Processing ${movies.length} movies and ${series.length} series from ${provider.name}...`, 'info');

        // Use a transaction for efficiency
        await dbRun(db, "BEGIN TRANSACTION");

        // Process Movies
        if (movies.length > 0) {
            movieInsertStmt = db.prepare(`INSERT OR IGNORE INTO movies (name, year, logo, category_name, provider_unique_id) VALUES (?, ?, ?, ?, ?)`);
            movieRelationInsertStmt = db.prepare(`INSERT OR REPLACE INTO provider_movie_relations (provider_id, movie_id, stream_id, container_extension, last_seen) VALUES (?, ?, ?, ?, ?)`);
            const existingMovies = await dbAll(db, 'SELECT id, provider_unique_id FROM movies WHERE provider_unique_id IS NOT NULL');
            const providerUniqueIdMap = new Map(existingMovies.map(m => [m.provider_unique_id, m.id]));

            for (const movieData of movies) {
                const { name, attributes, url } = movieData;
                const streamId = url.substring(url.lastIndexOf('/') + 1).split('.')[0];
                const providerUniqueId = `movie_${providerId}_${streamId}`;
                const yearMatch = name.match(/\((\d{4})\)/);
                const year = yearMatch ? parseInt(yearMatch[1]) : null;
                const logo = attributes['tvg-logo'] || null;
                const categoryName = attributes['group-title'] || 'VOD';

                let movieId = providerUniqueIdMap.get(providerUniqueId);
                if (!movieId) {
                    const result = await new Promise((resolve, reject) => {
                        movieInsertStmt.run(name, year, logo, categoryName, providerUniqueId, function(err) {
                            if (err) return reject(err);
                            resolve(this);
                        });
                    });
                    // INSERT OR IGNORE returns lastID=0/changes=0 when the row
                    // was skipped because provider_unique_id already exists
                    // (e.g. a concurrent refresh populated it after we loaded
                    // the map). Look up the existing id so the relation row
                    // doesn't reference a phantom movie_id=0 that the stale
                    // cleanup will then orphan.
                    if (result.changes === 0) {
                        const existing = await dbGet(db, 'SELECT id FROM movies WHERE provider_unique_id = ?', [providerUniqueId]);
                        movieId = existing ? existing.id : null;
                    } else {
                        movieId = result.lastID;
                    }
                    if (movieId) providerUniqueIdMap.set(providerUniqueId, movieId);
                }

                if (!movieId) {
                    console.warn(`[VOD Processor M3U] Could not resolve movieId for ${providerUniqueId}; skipping relation.`);
                    continue;
                }
                const extension = url.split('.').pop() || 'mp4';
                await new Promise((resolve, reject) => movieRelationInsertStmt.run(providerId, movieId, streamId, extension, scanStartTime, (err) => err ? reject(err) : resolve()));
            }
            await safeFinalize(movieInsertStmt, movieRelationInsertStmt);
            movieInsertStmt = movieRelationInsertStmt = null;
        }

        // Process Series (basic info, not episodes from M3U)
        if (series.length > 0) {
            seriesInsertStmt = db.prepare(`INSERT OR IGNORE INTO series (name, year, logo, category_name, provider_unique_id) VALUES (?, ?, ?, ?, ?)`);
            seriesRelationInsertStmt = db.prepare(`INSERT OR REPLACE INTO provider_series_relations (provider_id, series_id, external_series_id, last_seen) VALUES (?, ?, ?, ?)`);
            const existingSeries = await dbAll(db, 'SELECT id, provider_unique_id FROM series WHERE provider_unique_id IS NOT NULL');
            const providerUniqueIdMap = new Map(existingSeries.map(s => [s.provider_unique_id, s.id]));

            for (const seriesData of series) {
                const { name, attributes, url } = seriesData;
                // For M3U, we might not have a distinct series_id, so we create one from the name
                const externalSeriesId = name.replace(/\s+/g, '_').toLowerCase();
                const providerUniqueId = `series_${providerId}_${externalSeriesId}`;
                const yearMatch = name.match(/\((\d{4})\)/);
                const year = yearMatch ? parseInt(yearMatch[1]) : null;
                const logo = attributes['tvg-logo'] || null;
                const categoryName = attributes['group-title'] || 'Series';

                let seriesId = providerUniqueIdMap.get(providerUniqueId);
                if (!seriesId) {
                    const result = await new Promise((resolve, reject) => {
                        seriesInsertStmt.run(name, year, logo, categoryName, providerUniqueId, function(err) {
                            if (err) return reject(err);
                            resolve(this);
                        });
                    });
                    if (result.changes === 0) {
                        const existing = await dbGet(db, 'SELECT id FROM series WHERE provider_unique_id = ?', [providerUniqueId]);
                        seriesId = existing ? existing.id : null;
                    } else {
                        seriesId = result.lastID;
                    }
                    if (seriesId) providerUniqueIdMap.set(providerUniqueId, seriesId);
                }

                if (!seriesId) {
                    console.warn(`[VOD Processor M3U] Could not resolve seriesId for ${providerUniqueId}; skipping relation.`);
                    continue;
                }
                await new Promise((resolve, reject) => seriesRelationInsertStmt.run(providerId, seriesId, externalSeriesId, scanStartTime, (err) => err ? reject(err) : resolve()));
            }
            await safeFinalize(seriesInsertStmt, seriesRelationInsertStmt);
            seriesInsertStmt = seriesRelationInsertStmt = null;
        }

        await dbRun(db, "COMMIT");
        sendStatus(`Successfully processed VOD content from ${provider.name}.`, 'success');

    } catch (error) {
        await safeRollback(dbRun, db, 'M3U VOD');
        console.error(`[VOD Processor M3U] Processing FAILED for ${provider.name}:`, error.message);
        sendStatus(`M3U VOD processing FAILED for ${provider.name}: ${error.message}`, 'error');
    } finally {
        await safeFinalize(movieInsertStmt, movieRelationInsertStmt, seriesInsertStmt, seriesRelationInsertStmt);
    }
}


module.exports = { refreshVodContent, processM3uVod };
