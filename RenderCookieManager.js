const fs = require('fs');
const path = require('path');


class RenderCookieManager {
    constructor(options = {}) {
        this.cookieFile = options.cookieFile || path.join(process.cwd(), 'cookies.txt');
        this.refreshInterval = options.refreshInterval || 5 * 60 * 1000; // 5 minutes
        this.sourceUrl = options.sourceUrl || process.env.COOKIE_SOURCE_URL;
        this.accessKey = options.accessKey || process.env.COOKIE_ACCESS_KEY;
        this.running = false;
        this.lastRefreshTime = null;
        this.retryAttempts = options.retryAttempts || 3;
        this.retryDelay = options.retryDelay || 5000;
    }

    async refreshCookies() {
        let attempts = 0;

        while (attempts < this.retryAttempts) {
            try {
                console.log('[RenderCookieManager] Fetching cookies from source...');

                // First check the cookie health
                const healthResponse = await fetch(`${this.sourceUrl}/api/cookie-health`, {
                    headers: {
                        'x-cookie-access-key': this.accessKey
                    }
                });

                if (!healthResponse.ok) {
                    throw new Error(`Health check failed: ${healthResponse.statusText}`);
                }

                const healthData = await healthResponse.json();
                
                // If the cookies we have are still fresh, skip update
                if (this.lastRefreshTime && healthData.lastModified) {
                    const remoteLastModified = new Date(healthData.lastModified);
                    if (this.lastRefreshTime >= remoteLastModified) {
                        console.log('[RenderCookieManager] Local cookies are up to date');
                        return true;
                    }
                }

                // Fetch new cookies
                const response = await fetch(`${this.sourceUrl}/api/fetch-cookies`, {
                    headers: {
                        'x-cookie-access-key': this.accessKey
                    }
                });

                if (!response.ok) {
                    throw new Error(`Failed to fetch cookies: ${response.statusText}`);
                }

                const data = await response.json();

                // Backup existing cookie file
                if (fs.existsSync(this.cookieFile)) {
                    fs.copyFileSync(this.cookieFile, `${this.cookieFile}.backup`);
                }

                // Write new cookies
                fs.writeFileSync(this.cookieFile, data.cookies);
                fs.chmodSync(this.cookieFile, '644');

                this.lastRefreshTime = new Date();
                console.log('[RenderCookieManager] Cookies refreshed successfully');
                
                return true;
            } catch (error) {
                console.error(`[RenderCookieManager] Attempt ${attempts + 1} failed:`, error.message);
                attempts++;
                
                if (attempts < this.retryAttempts) {
                    await new Promise(resolve => setTimeout(resolve, this.retryDelay));
                }
            }
        }

        throw new Error('Failed to refresh cookies after multiple attempts');
    }

    async start() {
        if (this.running) return;
        
        if (!this.sourceUrl || !this.accessKey) {
            throw new Error('Cookie source URL and access key are required');
        }

        this.running = true;
        console.log('[RenderCookieManager] Starting service...');
        
        try {
            await this.refreshCookies();
            
            this.interval = setInterval(async () => {
                try {
                    await this.refreshCookies();
                } catch (error) {
                    console.error('[RenderCookieManager] Refresh interval failed:', error.message);
                }
            }, this.refreshInterval);
        } catch (error) {
            this.running = false;
            throw error;
        }
    }

    async stop() {
        if (!this.running) return;
        
        clearInterval(this.interval);
        this.running = false;
        console.log('[RenderCookieManager] Service stopped');
    }

    getStatus() {
        return {
            running: this.running,
            lastRefreshTime: this.lastRefreshTime,
            cookieFile: this.cookieFile,
            refreshInterval: this.refreshInterval,
            sourceUrl: this.sourceUrl
        };
    }
}

module.exports = RenderCookieManager;