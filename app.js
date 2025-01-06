const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const app = express();
const port = process.env.PORT || 3002;
const crypto = require('crypto');
const COOKIE_FILE = path.join(process.cwd(), 'cookies.txt');
const COOKIE_ACCESS_KEY = "c3f543af8a254f65c80d83489cb31d462badef801407e6a575c7da86c3988398";
const RenderCookieManager = require('./RenderCookieManager');
const cors = require('cors');

app.use(cors());

console.log('Current working directory:', process.cwd());
console.log('Cookie file absolute path:', path.resolve(COOKIE_FILE));

const cookieManager = new RenderCookieManager({
    sourceUrl: 'https://api.mp3vault.xyz',
    accessKey: "c3f543af8a254f65c80d83489cb31d462badef801407e6a575c7da86c3988398",
    refreshInterval: 5 * 60 * 1000 // 5 minutes
});



app.get('/api/cookie-status', (req, res) => {
    res.json(cookieManager.getStatus());
});



// app.use(cors());
// app.use(cors({
//     origin: ['http://localhost:3000', 'https://your-vercel-domain.vercel.app'],
//     credentials: true
//   }));

app.use(express.json());

const OUTPUT_DIR = path.join(process.cwd(), 'downloads');
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR);
}

process.on('SIGINT', async () => {
    console.log('Cleaning up resources...');
    await cookieManager.stop();
    for (const page of PAGE_POOL.values()) {
        await page.close();
    }
    if (browser) await browser.close();
    process.exit();
});

console.log(`Using cookies file: ${COOKIE_FILE}`);
if (!fs.existsSync(COOKIE_FILE)) {
    console.error(`Cookies file not found: ${COOKIE_FILE}`);
} else {
    console.log(`Cookies file found: ${COOKIE_FILE}`);
}

async function downloadSong(song) {
    const downloadId = crypto.randomUUID();
    const safeFileName = `${song.title
        .replace(/[^\w\s-.,()[\]'&]/g, '')
        .replace(/\s+/g, ' ')
        .trim()}_${downloadId}.mp3`
        .substring(0, 200);
    
    const outputPath = path.join(OUTPUT_DIR, safeFileName);

    return new Promise((resolve, reject) => {
        const ytdlpArgs = [
            '--format', 'bestaudio[ext=m4a]',
            '--extract-audio',
            '--audio-format', 'mp3',
            '--audio-quality', '0',
            '--cookies', COOKIE_FILE,
            '--no-playlist',
            '--no-warnings',
            '--no-progress',
            '--ignore-errors',
            `https://music.youtube.com/watch?v=${song.youtubeId}`,
            '-o', outputPath
        ];

        const process = spawn('yt-dlp', ytdlpArgs);
        let errorOutput = '';

        process.stderr.on('data', (data) => {
            errorOutput += data.toString();
            if (!data.toString().includes('[debug]')) {
                console.error('yt-dlp stderr:', data.toString().trim());
            }
        });

        const timeout = setTimeout(() => {
            process.kill();
            reject(new Error('Download timed out'));
        }, 5 * 60 * 1000);

        process.on('close', (code) => {
            clearTimeout(timeout);
            if (code === 0 && fs.existsSync(outputPath)) {
                resolve({
                    downloadId,
                    fileName: safeFileName,
                    filePath: outputPath
                });
            } else {
                reject(new Error(`Download failed (code ${code}): ${errorOutput}`));
            }
        });

        process.on('error', (error) => {
            clearTimeout(timeout);
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
    'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1'
};

async function searchSongs(query) {
    const cacheKey = query.toLowerCase();
    const cachedResult = searchCache.get(cacheKey);
    
    if (cachedResult && Date.now() - cachedResult.timestamp < CACHE_DURATION) {
        return cachedResult.results;
    }

    try {
        const encodedQuery = encodeURIComponent(query);
        const url = `https://music.youtube.com/youtubei/v1/search?key=AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30`;
        
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                ...HEADERS,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                context: {
                    client: {
                        clientName: 'WEB_REMIX',
                        clientVersion: '1.20240101.01.00',
                        visitorData: 'CgtsWkNKN3dkX29Paz0%3D',
                    },
                },
                query: query,
                params: 'EgWKAQIIAWoKEAMQBBAJEAoQBQ%3D%3D' // This params value filters for songs only
            })
        });

        const data = await response.json();
        const results = [];

        // First check for the songs section
        const contents = data?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents;
        
        if (contents) {
            for (const section of contents) {
                // Only process if it's a music shelf (songs section)
                const musicShelf = section?.musicShelfRenderer;
                if (!musicShelf) continue;

                const items = musicShelf.contents || [];
                for (const item of items) {
                    const renderer = item.musicResponsiveListItemRenderer;
                    if (!renderer) continue;

                    const videoId = renderer.playlistItemData?.videoId || 
                                  renderer.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.navigationEndpoint?.watchEndpoint?.videoId;
                                  
                    if (!videoId) continue;

                    // Extract song details
                    const title = renderer.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text;
                    
                    // Get artist and album info
                    const flexColumns = renderer.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
                    const artistInfo = [];
                    let currentText = '';
                    
                    for (const run of flexColumns) {
                        if (run.text === ' • ') {
                            if (currentText) artistInfo.push(currentText);
                            currentText = '';
                        } else {
                            currentText += run.text;
                        }
                    }
                    if (currentText) artistInfo.push(currentText);

                    const artist = artistInfo[0] || 'Unknown Artist';
                    const album = artistInfo[1] || '';
                    
                    // Get thumbnail
                    const thumbnails = renderer.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
                    const thumbnail = thumbnails[thumbnails.length - 1]?.url;

                    // Get duration
                    const durationRuns = renderer.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs;
                    const duration = durationRuns?.find(run => /\d+:\d+/.test(run.text))?.text || '';

                    if (title && videoId) {
                        results.push({
                            title,
                            youtubeId: videoId,
                            thumbnail,
                            channelName: artist,
                            album,
                            duration,
                            isAudioVersion: true
                        });
                    }
                }
            }
        }

        searchCache.set(cacheKey, {
            results,
            timestamp: Date.now()
        });

        return results;
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
        const ytdlpArgs = [
            '--no-playlist',
            '--no-warnings',
            '--no-progress',
            '--cookies', COOKIE_FILE,  // Add cookies file here
            '-f', format,
            '--merge-output-format', 'mp4',
            '--audio-quality', '0',
            '--add-metadata',
            '--embed-thumbnail',
            `https://youtube.com/watch?v=${video.youtubeId}`,
            '-o', outputPath
        ];

        const process = spawn('yt-dlp', ytdlpArgs);

        let errorOutput = '';

        process.stderr.on('data', (data) => {
            errorOutput += data.toString();
            console.error('yt-dlp stderr:', data.toString()); // Add logging
        });

        const timeout = setTimeout(() => {
            process.kill();
            reject(new Error('Download timed out'));
        }, 10 * 60 * 1000);

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
function cleanupDownloads() {
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    const now = Date.now();

    fs.readdir(OUTPUT_DIR, (err, files) => {
        if (err) {
            console.error('Error reading downloads directory:', err);
            return;
        }

        files.forEach(file => {
            const filePath = path.join(OUTPUT_DIR, file);
            fs.stat(filePath, (err, stats) => {
                if (err) {
                    console.error('Error stating file:', err);
                    return;
                }

                if (now - stats.mtimeMs > maxAge) {
                    fs.unlink(filePath, err => {
                        if (err) {
                            console.error('Error deleting old file:', err);
                        } else {
                            console.log('Cleaned up old file:', file);
                        }
                    });
                }
            });
        });
    });
}

// Run cleanup every 6 hours
setInterval(cleanupDownloads, 6 * 60 * 60 * 1000);

// In your Express server code, add these constants at the top
const ITEMS_PER_PAGE = 12;
const MAX_ITEMS = 100;

// Add this new cache for storing all fetched videos
const allVideosCache = new Map();

async function getTrendingSongs(countryCode = 'US', page = 1) {
    const cacheKey = countryCode.toUpperCase();
    let allVideos = allVideosCache.get(cacheKey)?.videos;
    const cacheTimestamp = allVideosCache.get(cacheKey)?.timestamp;

    if (!allVideos || !cacheTimestamp || (Date.now() - cacheTimestamp > TRENDING_CACHE_DURATION)) {
        try {
            const url = `https://music.youtube.com/trending?gl=${countryCode}`;
            const response = await fetch(url, {
                headers: {
                    ...HEADERS,
                    'Accept-Language': `${countryCode.toLowerCase()},en-US;q=0.9`
                }
            });

            const html = await response.text();
            allVideos = await processSearchResults(html);
            
            allVideosCache.set(cacheKey, {
                videos: allVideos,
                timestamp: Date.now()
            });
        } catch (error) {
            console.error(`Error fetching trending songs for ${countryCode}:`, error);
            throw error;
        }
    }

    const startIndex = (page - 1) * ITEMS_PER_PAGE;
    const endIndex = Math.min(startIndex + ITEMS_PER_PAGE, allVideos.length);
    return {
        videos: allVideos.slice(startIndex, endIndex),
        hasMore: endIndex < allVideos.length,
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
            '--cookies', COOKIE_FILE,  // Add cookies file here
            `https://youtube.com/watch?v=${youtubeId}`
        ]);
  
        // Rest of the function remains the same...
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
            
            const bestAudioFormat = audioFormats.length > 0 ? 
                audioFormats[audioFormats.length - 1].split(/\s+/)[0] : '140';

            const formats = output
                .split('\n')
                .filter(line => {
                    if (!line.match(/^[0-9]+\s+mp4/)) return false;
                    return line.includes('x');
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
                    const fps = fpsMatch ? fpsMatch[1] : '24';
                    
                    const hasAudio = !line.includes('video only');
                    
                    return {
                        formatId: hasAudio ? formatId : `${formatId}+${bestAudioFormat}`,
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

            const uniqueFormats = formats.reduce((acc, current) => {
                const resolution = current.resolution.split('x')[1];
                const existing = acc.find(f => f.resolution.split('x')[1] === resolution);
                
                if (!existing) {
                    acc.push(current);
                }
                return acc;
            }, []);

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
 

app.get('/api/fetch-cookies', (req, res) => {
    try {
        // Verify access key
        const providedKey = req.headers['x-cookie-access-key'];
        if (!providedKey || providedKey !== COOKIE_ACCESS_KEY) {
            return res.status(401).json({ error: 'Unauthorized access' });
        }

        // Check if cookie file exists
        if (!fs.existsSync(COOKIE_FILE)) {
            return res.status(404).json({ error: 'Cookie file not found' });
        }

        // Read cookie file
        const cookieData = fs.readFileSync(COOKIE_FILE, 'utf8');
        
        // Get cookie file stats
        const stats = fs.statSync(COOKIE_FILE);

        res.json({
            cookies: cookieData,
            lastModified: stats.mtime,
            fileSize: stats.size
        });
    } catch (error) {
        console.error('Error serving cookie file:', error);
        res.status(500).json({ error: 'Failed to read cookie file' });
    }
});

// Add an endpoint to check cookie status
app.get('/api/cookie-health', (req, res) => {
    try {
        // Verify access key
        const providedKey = req.headers['x-cookie-access-key'];
        if (!providedKey || providedKey !== COOKIE_ACCESS_KEY) {
            return res.status(401).json({ error: 'Unauthorized access' });
        }

        const stats = fs.existsSync(COOKIE_FILE) ? fs.statSync(COOKIE_FILE) : null;
        const cookieManager = CookieManager.getInstance();

        res.json({
            cookieExists: fs.existsSync(COOKIE_FILE),
            lastModified: stats ? stats.mtime : null,
            fileSize: stats ? stats.size : 0,
            managerStatus: cookieManager.getStatus()
        });
    } catch (error) {
        console.error('Error checking cookie health:', error);
        res.status(500).json({ error: 'Failed to check cookie status' });
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
        
        res.setHeader('Content-Type', 'audio/mp3');
        res.setHeader('Transfer-Encoding', 'chunked');
        
        const process = spawn('yt-dlp', [
            '--format', 'bestaudio[ext=m4a]',
            '--cookies', COOKIE_FILE,
            '-o', '-',
            '--no-warnings',
            '--quiet',
            `https://music.youtube.com/watch?v=${videoId}`
        ]);

        process.on('error', (error) => {
            console.error('Stream error:', error);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Streaming failed' });
            }
        });

        process.stdout.pipe(res);
        
        res.on('close', () => process.kill());
    } catch (error) {
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


app.listen(port,'0.0.0.0', async () => {
    console.log(`Server running at http://localhost:${port}`);
    try {
        await cookieManager.start();
        console.log('Cookie manager started successfully');
    } catch (error) {
        console.error('Failed to start cookie manager:', error);
    }
});