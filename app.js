const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const app = express();
const port = process.env.PORT || 3002;
const { COOKIE_FILE, initializeCookies } = require('./cookies');

app.use(cors());
app.use(express.json());

const OUTPUT_DIR = path.join(process.cwd(), 'downloads');
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR);
}

console.log(`Using cookies file: ${COOKIE_FILE}`);
if (!fs.existsSync(COOKIE_FILE)) {
    console.error(`Cookies file not found: ${COOKIE_FILE}`);
} else {
    console.log(`Cookies file found: ${COOKIE_FILE}`);
}

async function downloadSong(song) {
    const downloadId = crypto.randomUUID();
    const safeFileName = `${song.title.replace(/[^a-z0-9]/gi, '_')}_${downloadId}.mp3`.substring(0, 200);
    const outputPath = path.join(OUTPUT_DIR, safeFileName);

    return new Promise((resolve, reject) => {
        const ytdlpArgs = [
            '--extract-audio',
            '--audio-format', 'mp3',
            '--audio-quality', '0',
            '--cookies', COOKIE_FILE,  // Use cookies file for authentication
            '--postprocessor-args', '-acodec libmp3lame -ac 2 -b:a 192k',
            '--sponsorblock-remove', 'all',
            '--force-keyframes-at-cuts',
            '--no-playlist',
            '--embed-thumbnail',
            '--no-warnings',
            '--verbose',
            `https://youtube.com/watch?v=${song.youtubeId}`,
            '-o', outputPath
        ];

        const process = spawn('yt-dlp', ytdlpArgs);

        let errorOutput = '';
        let stdoutOutput = '';

        process.stdout.on('data', (data) => {
            stdoutOutput += data.toString();
            console.log('yt-dlp stdout:', data.toString());
        });

        process.stderr.on('data', (data) => {
            errorOutput += data.toString();
            console.error('yt-dlp stderr:', data.toString());
        });

        const timeout = setTimeout(() => {
            process.kill();
            reject(new Error('Download timed out'));
        }, 5 * 60 * 1000);

        process.on('close', (code) => {
            clearTimeout(timeout);
            if (code === 0) {
                resolve({
                    downloadId,
                    fileName: safeFileName,
                    filePath: outputPath
                });
            } else {
                console.error('yt-dlp failed with code:', code);
                console.error('Error output:', errorOutput);
                console.error('Stdout output:', stdoutOutput);
                reject(new Error(`Download failed (code ${code}): ${errorOutput}`));
            }
        });

        process.on('error', (error) => {
            clearTimeout(timeout);
            console.error('yt-dlp process error:', error);
            reject(error);
        });
    });
}

const downloads = new Map();
const searchCache = new Map();
const trendingCache = new Map();
const CACHE_DURATION = 30 * 60 * 1000;
const TRENDING_CACHE_DURATION = 15 * 60 * 1000;

let browser;
const PAGE_POOL = new Map();
const MAX_RETRIES = 3;

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Referer': 'https://www.youtube.com/',
    'Cookie': COOKIE_FILE
};

async function searchSongs(query) {
    const cacheKey = query.toLowerCase();
    const cachedResult = searchCache.get(cacheKey);
    
    if (cachedResult && Date.now() - cachedResult.timestamp < CACHE_DURATION) {
        return cachedResult.results;
    }

    try {
        // Make two searches: one for audio, one for music videos
        const audioQuery = encodeURIComponent(query + ' audio');
        const videoQuery = encodeURIComponent(query);
        
        // Search URLs for both types
        const audioUrl = `https://www.youtube.com/results?search_query=${audioQuery}&sp=EgIQAQ%253D%253D`;
        const videoUrl = `https://www.youtube.com/results?search_query=${videoQuery}&sp=EgIQAUICCAE%253D`;

        // Fetch both searches
        const [audioResponse, videoResponse] = await Promise.all([
            fetch(audioUrl, { headers: HEADERS }),
            fetch(videoUrl, { headers: HEADERS })
        ]);

        const [audioHtml, videoHtml] = await Promise.all([
            audioResponse.text(),
            videoResponse.text()
        ]);

        // Process both result sets
        const audioResults = await processSearchResults(audioHtml, true);
        const videoResults = await processSearchResults(videoHtml, false);

        // Combine and deduplicate results with new priority
        const combinedResults = mergeAndDeduplicateResults(audioResults, videoResults);

        searchCache.set(cacheKey, {
            results: combinedResults,
            timestamp: Date.now()
        });

        return combinedResults;
    } catch (error) {
        console.error('Search error:', error);
        throw new Error('Search failed');
    }
}

async function processSearchResults(html, isAudioSearch) {
    const initialDataMatch = html.match(/var ytInitialData = (.+?);<\/script>/);
    if (!initialDataMatch) {
        return [];
    }

    const data = JSON.parse(initialDataMatch[1]);
    const contents = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents[0]?.itemSectionRenderer?.contents;

    if (!contents) {
        return [];
    }

    const results = [];
    for (const item of contents) {
        const videoRenderer = item.videoRenderer;
        if (!videoRenderer) continue;

        const lengthText = videoRenderer?.lengthText?.simpleText;
        if (!lengthText || isLiveStream(videoRenderer) || !isValidDuration(lengthText)) {
            continue;
        }

        const viewCountText = videoRenderer.viewCountText?.simpleText || '0 views';
        const channelName = videoRenderer.ownerText?.runs[0]?.text || 'Unknown Channel';
        const thumbnails = videoRenderer.thumbnail?.thumbnails || [];
        const thumbnail = thumbnails.length > 0 
            ? thumbnails[thumbnails.length - 1].url
            : `https://i.ytimg.com/vi/${videoRenderer.videoId}/hqdefault.jpg`;

        // Check for official music video indicators
        const isOfficialVideo = videoRenderer.title?.runs[0]?.text?.toLowerCase().includes('official') ||
                              videoRenderer.title?.runs[0]?.text?.toLowerCase().includes('music video') ||
                              videoRenderer.ownerBadges?.some(badge => 
                                badge?.metadataBadgeRenderer?.tooltip === 'Official Artist Channel'
                              );

        results.push({
            title: videoRenderer.title.runs[0].text,
            youtubeId: videoRenderer.videoId,
            duration: lengthText,
            views: viewCountText,
            channelName: channelName,
            thumbnail: thumbnail,
            isOfficialVideo: isOfficialVideo,
            isAudioVersion: isAudioSearch
        });

        if (results.length >= 20) break;
    }

    return results;
}

function mergeAndDeduplicateResults(audioResults, videoResults) {
    // Create a map to track seen video IDs
    const seenIds = new Map();
    const finalResults = [];

    // Helper function to add results while avoiding duplicates
    const addUniqueResults = (results, priority) => {
        for (const result of results) {
            if (!seenIds.has(result.youtubeId)) {
                seenIds.set(result.youtubeId, true);
                finalResults.push({
                    ...result,
                    priority
                });
            }
        }
    };

    // First add audio versions (now priority 1)
    addUniqueResults(
        audioResults,
        1
    );

    // Then add official music videos (now priority 2)
    addUniqueResults(
        videoResults.filter(v => v.isOfficialVideo),
        2
    );

    // Finally add remaining video results (priority 3)
    addUniqueResults(
        videoResults.filter(v => !v.isOfficialVideo),
        3
    );

    // Sort by priority and take top 10
    return finalResults
        .sort((a, b) => a.priority - b.priority)
        .slice(0, 20)
        .map(({ priority, ...rest }) => rest); // Remove the priority field from final results
}

function isLiveStream(videoRenderer) {
    return videoRenderer?.badges?.some(badge => 
        badge?.liveBroadcastBadge || 
        (badge?.labelBadge?.label === 'LIVE')
    ) || videoRenderer?.thumbnailOverlays?.some(overlay => 
        overlay?.thumbnailOverlayTimeStatusRenderer?.text?.simpleText === 'LIVE'
    );
}

function isValidDuration(duration) {
    const parts = duration.split(':').map(Number);
    if (parts.length === 3) return false;
    if (parts.length === 2) {
        const [minutes, _] = parts;
        return minutes < 15;
    }
    return true;
}

async function downloadVideo(video, format) {
    const downloadId = crypto.randomUUID();
    const safeFileName = `${video.title.replace(/[^a-z0-9]/gi, '_')}_${downloadId}.mp4`.substring(0, 200);
    const outputPath = path.join(OUTPUT_DIR, safeFileName);
  
    return new Promise((resolve, reject) => {
        // Basic yt-dlp arguments
        const ytdlpArgs = [
            '--no-playlist',
            '--no-warnings',
            '--no-progress',
            '--cookies', COOKIE_FILE,
            '-f', format,  // Will handle both single formats and format+audio combinations
            '--merge-output-format', 'mp4',
            '--audio-quality', '0',
            '--add-metadata',
            '--embed-thumbnail',
            '--add-header', `Authorization: ${tokenData.token_type} ${tokenData.access_token}`,
            `https://youtube.com/watch?v=${song.youtubeId}`,
            '-o', outputPath
            `https://youtube.com/watch?v=${video.youtubeId}`,
            '-o', outputPath
        ];

        const process = spawn('yt-dlp', ytdlpArgs);

        let errorOutput = '';

        process.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });

        const timeout = setTimeout(() => {
            process.kill();
            reject(new Error('Download timed out'));
        }, 10 * 60 * 1000); // 10 minutes timeout for video downloads

        process.on('close', (code) => {
            clearTimeout(timeout);
            if (code === 0) {
                resolve({
                    downloadId,
                    fileName: safeFileName,
                    filePath: outputPath
                });
            } else {
                reject(new Error(`Download failed: ${errorOutput}`));
            }
        });

        process.on('error', (error) => {
            clearTimeout(timeout);
            reject(error);
        });
    });
}

// In your Express server code, add these constants at the top
const ITEMS_PER_PAGE = 12;
const MAX_ITEMS = 100;

// Add this new cache for storing all fetched videos
const allVideosCache = new Map();

async function getTrendingSongs(countryCode = 'US', page = 1) {
    const cacheKey = countryCode.toUpperCase();
    
    // Try to get all videos from cache first
    let allVideos = allVideosCache.get(cacheKey)?.videos;
    const cacheTimestamp = allVideosCache.get(cacheKey)?.timestamp;

    // Check if we need to fetch fresh data
    const needsFresh = !allVideos || 
                      !cacheTimestamp || 
                      (Date.now() - cacheTimestamp > TRENDING_CACHE_DURATION);

    if (needsFresh) {
        try {
            // Fetch fresh data
            const url = `https://www.youtube.com/feed/trending?bp=4gINGgt5dG1hX2NoYXJ0cw%3D%3D&gl=${countryCode}`;
            const response = await fetch(url, {
                headers: {
                    ...HEADERS,
                    'Accept-Language': `${countryCode.toLowerCase()},en-US;q=0.9`
                }
            });

            const html = await response.text();
            const initialDataMatch = html.match(/var ytInitialData = (.+?);<\/script>/);
            
            if (!initialDataMatch) {
                throw new Error('Could not find initial data');
            }

            const data = JSON.parse(initialDataMatch[1]);
            const tabs = data.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
            allVideos = [];

            for (const tab of tabs) {
                const tabContent = tab?.tabRenderer?.content?.sectionListRenderer?.contents || [];
                for (const section of tabContent) {
                    const items = section?.itemSectionRenderer?.contents?.[0]?.shelfRenderer?.content?.expandedShelfContentsRenderer?.items || [];
                    
                    for (const item of items) {
                        const videoRenderer = item.videoRenderer;
                        if (!videoRenderer) continue;

                        const lengthText = videoRenderer?.lengthText?.simpleText;
                        if (!lengthText || isLiveStream(videoRenderer) || !isValidDuration(lengthText)) {
                            continue;
                        }

                        const thumbnails = videoRenderer.thumbnail?.thumbnails || [];
                        const thumbnail = thumbnails.length > 0 
                            ? thumbnails[thumbnails.length - 1].url
                            : `https://i.ytimg.com/vi/${videoRenderer.videoId}/hqdefault.jpg`;

                        allVideos.push({
                            title: videoRenderer.title.runs[0].text,
                            youtubeId: videoRenderer.videoId,
                            duration: lengthText,
                            views: videoRenderer.viewCountText?.simpleText || '0 views',
                            channelName: videoRenderer.ownerText?.runs[0]?.text || 'Unknown Channel',
                            thumbnail: thumbnail,
                            countryCode
                        });
                    }
                }
            }

            // Store all videos in cache
            allVideosCache.set(cacheKey, {
                videos: allVideos,
                timestamp: Date.now()
            });

        } catch (error) {
            console.error(`Error fetching trending songs for ${countryCode}:`, error);
            throw error;
        }
    }

    // If we still don't have videos, something went wrong
    if (!allVideos || allVideos.length === 0) {
        throw new Error(`No trending videos found for country: ${countryCode}`);
    }

    // Limit total results to MAX_ITEMS
    allVideos = allVideos.slice(0, MAX_ITEMS);

    // Calculate pagination
    const startIndex = (page - 1) * ITEMS_PER_PAGE;
    const endIndex = Math.min(startIndex + ITEMS_PER_PAGE, allVideos.length);
    const paginatedVideos = allVideos.slice(startIndex, endIndex);
    const hasMore = endIndex < allVideos.length;

    console.log(`Returning page ${page}, videos ${startIndex} to ${endIndex} of ${allVideos.length}`);

    return {
        videos: paginatedVideos,
        hasMore,
        totalVideos: allVideos.length
    };
}

app.get('/api/search', async (req, res) => {
    try {
        const { query } = req.query;
        if (!query) {
            return res.status(400).json({ error: 'Query is required' });
        }
        const results = await searchSongs(query);
        res.json({ results });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/download', async (req, res) => {
    try {
        const { youtubeId, title } = req.query;
        if (!youtubeId || !title) {
            return res.status(400).json({ error: 'YouTube ID and title are required' });
        }
        const downloadInfo = await downloadSong({ youtubeId, title });
        downloads.set(downloadInfo.downloadId, downloadInfo);
        res.json({ 
            downloadUrl: `/api/download/${downloadInfo.downloadId}`,
            fileName: downloadInfo.fileName
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/download/:downloadId', (req, res) => {
    const { downloadId } = req.params;
    const downloadInfo = downloads.get(downloadId);

    if (!downloadInfo || !fs.existsSync(downloadInfo.filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }

    res.download(downloadInfo.filePath, downloadInfo.fileName);
});

app.get('/api/trending', async (req, res) => {
    try {
        const { country = 'US', page = 1 } = req.query;
        
        if (!/^[A-Z]{2}$/.test(country)) {
            return res.status(400).json({ 
                error: 'Invalid country code. Please use ISO 3166-1 alpha-2 format (e.g., US, GB, JP)' 
            });
        }

        const results = await getTrendingSongs(country, parseInt(page));
        res.json(results);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/download-video', async (req, res) => {
    try {
      const { youtubeId, title, format } = req.query;
      if (!youtubeId || !title) {
        return res.status(400).json({ error: 'YouTube ID and title are required' });
      }
      const downloadInfo = await downloadVideo({ youtubeId, title }, format);
      downloads.set(downloadInfo.downloadId, downloadInfo);
      res.json({ 
        downloadUrl: `/api/download/${downloadInfo.downloadId}`,
        fileName: downloadInfo.fileName
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

// Modify api/video-qualities endpoint
// In your server.js file, update the /api/video-qualities endpoint:
app.get('/api/video-qualities', async (req, res) => {
    const { youtubeId } = req.query;
    
    if (!youtubeId) {
        return res.status(400).json({ error: 'YouTube ID is required' });
    }

    try {
        let isResponseSent = false;
        const process = spawn('yt-dlp', [
            '-F',
            `https://youtube.com/watch?v=${youtubeId}`
        ]);
  
        let output = '';
        let errorOutput = '';

        const timeoutId = setTimeout(() => {
            if (!isResponseSent) {
                isResponseSent = true;
                process.kill();
                res.status(408).json({ error: 'Request timed out while fetching video formats' });
            }
        }, 15000);

        process.stdout.on('data', (data) => {
            output += data.toString();
        });

        process.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });
  
        process.on('close', (code) => {
            clearTimeout(timeoutId);
            
            if (isResponseSent) return;
            isResponseSent = true;
            
            if (code !== 0) {
                return res.status(500).json({ 
                    error: 'Failed to get video formats',
                    details: errorOutput 
                });
            }

            // Find the best audio format
            const audioFormats = output
                .split('\n')
                .filter(line => line.includes('audio only') && line.includes('mp4a'));
            
            // Get the best audio format ID (usually the last one in the filtered list)
            const bestAudioFormat = audioFormats.length > 0 ? 
                audioFormats[audioFormats.length - 1].split(/\s+/)[0] : '140'; // 140 is usually the best audio

            const formats = output
                .split('\n')
                .filter(line => {
                    // Only include lines that start with a number and are mp4 format
                    if (!line.match(/^[0-9]+\s+mp4/)) return false;
                    
                    // Include video formats (both with and without audio)
                    return line.includes('x');  // Check for resolution
                })
                .map(line => {
                    const parts = line.trim().split(/\s+/);
                    const formatId = parts[0];
                    const ext = parts[1];
                    
                    const resolutionMatch = line.match(/(\d+x\d+)/);
                    const resolution = resolutionMatch ? resolutionMatch[1] : '';
                    
                    const filesizeMatch = line.match(/(\d+(\.\d+)?[KMG]iB)/);
                    const filesize = filesizeMatch ? filesizeMatch[1] : 'Unknown size';
                    
                    const height = resolution ? resolution.split('x')[1] : '0';
                    const qualityLabel = `${height}p MP4`;

                    const fpsMatch = line.match(/(\d+)fps/);
                    const fps = fpsMatch ? fps[1] : '24';
                    
                    // Check if this format includes audio
                    const hasAudio = !line.includes('video only');
                    
                    return {
                        formatId: hasAudio ? formatId : `${formatId}+${bestAudioFormat}`, // Combine with audio if needed
                        ext,
                        resolution,
                        filesize,
                        quality: qualityLabel,
                        fps,
                        hasAudio
                    };
                })
                .sort((a, b) => {
                    const heightA = parseInt(a.resolution.split('x')[1]);
                    const heightB = parseInt(b.resolution.split('x')[1]);
                    return heightB - heightA;
                });

            // Filter out duplicate resolutions, keeping the best quality version
            const uniqueFormats = formats.reduce((acc, current) => {
                const resolution = current.resolution.split('x')[1];
                const existing = acc.find(f => f.resolution.split('x')[1] === resolution);
                
                if (!existing) {
                    acc.push(current);
                }
                return acc;
            }, []);

            console.log('Available formats:', uniqueFormats);
            res.json({ qualities: uniqueFormats });
        });

        process.on('error', (error) => {
            if (!isResponseSent) {
                isResponseSent = true;
                clearTimeout(timeoutId);
                res.status(500).json({ error: 'Failed to start yt-dlp process' });
            }
        });

    } catch (error) {
        console.error('Error in video-qualities endpoint:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
    }
});

app.get('/api/oauth/status', async (req, res) => {
    try {
        const tokenData = await getValidToken();
        const testResponse = await fetch('https://www.googleapis.com/youtube/v3/channels?part=id&mine=true', {
            headers: {
                'Authorization': `${tokenData.token_type} ${tokenData.access_token}`
            }
        });
        
        if (!testResponse.ok) {
            throw new Error(`Token validation failed: ${testResponse.status} ${testResponse.statusText}`);
        }

        const data = await testResponse.json();
        res.json({ 
            status: 'valid',
            tokenExpires: new Date(tokenData.expires * 1000),
            channelInfo: data
        });
    } catch (error) {
        res.status(500).json({ 
            status: 'invalid',
            error: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});  

app.get('/api/countries', (req, res) => {
    const supportedCountries = [
        { code: 'US', name: 'United States' },
        { code: 'GB', name: 'United Kingdom' },
        { code: 'CA', name: 'Canada' },
        { code: 'AU', name: 'Australia' },
        { code: 'IN', name: 'India' },
        { code: 'JP', name: 'Japan' },
        { code: 'DE', name: 'Germany' },
        { code: 'FR', name: 'France' },
        { code: 'BR', name: 'Brazil' },
        { code: 'KR', name: 'South Korea' }
    ];
    
    res.json({ countries: supportedCountries });
});

app.get('/api/stream/:videoId', async (req, res) => {
    try {
      const { videoId } = req.params;
      
      // Set headers for audio streaming
      res.setHeader('Content-Type', 'audio/mp3');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'no-cache');
  
      // Create yt-dlp process for streaming
      const process = spawn('yt-dlp', [
        '-f', 'bestaudio[ext=m4a]',
        '--cookies', COOKIE_FILE,  // Add cookies file
        '-o', '-',  // Output to stdout
        '--no-warnings',
        '--no-playlist',
        '--quiet',
        `https://youtube.com/watch?v=${videoId}`
      ]);
  
      // Handle process errors
      process.on('error', (error) => {
        console.error('Stream process error:', error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Streaming failed' });
        }
      });
  
      // Handle stderr
      process.stderr.on('data', (data) => {
        console.error(`Stream stderr: ${data}`);
      });
  
      // Pipe the output directly to response
      process.stdout.pipe(res);
  
      // Clean up on client disconnect
      res.on('close', () => {
        process.kill();
      });
  
    } catch (error) {
      console.error('Streaming error:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: error.message });
      }
    }
  });

process.on('SIGINT', async () => {
    console.log('Cleaning up browser resources...');
    for (const page of PAGE_POOL.values()) {
        await page.close();
    }
    if (browser) await browser.close();
    process.exit();
});

app.listen(port, async () => {
    await initializeCookies();
    console.log(`Server running at http://localhost:${port}`);
});