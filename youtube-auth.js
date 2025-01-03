const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

let browser = null;
let isAuthenticated = false;

const AUTH_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes
const COOKIES_PATH = path.join(process.cwd(), 'youtube_cookies.json');
const USER_DATA_DIR = path.join(process.cwd(), 'chrome-data');

async function initAuth() {
    try {
        browser = await puppeteer.launch({
            headless: false, // Set to true in production
            userDataDir: USER_DATA_DIR,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        // Periodically check authentication status
        setInterval(checkAuthStatus, AUTH_CHECK_INTERVAL);
        
        return await checkAuthStatus();
    } catch (error) {
        console.error('Failed to initialize authentication:', error);
        throw error;
    }
}

async function checkAuthStatus() {
    if (!browser) {
        return false;
    }

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });

        // Navigate to YouTube
        await page.goto('https://www.youtube.com', {
            waitUntil: 'networkidle0',
            timeout: 30000
        });

        // Check if logged in by looking for avatar button
        const isLoggedIn = await page.evaluate(() => {
            const avatar = document.querySelector('button#avatar-btn');
            return !!avatar;
        });

        if (isLoggedIn) {
            // Save cookies if logged in
            const cookies = await page.cookies();
            await fs.promises.writeFile(COOKIES_PATH, JSON.stringify(cookies, null, 2));
            isAuthenticated = true;
        } else {
            isAuthenticated = false;
        }

        await page.close();
        return isAuthenticated;
    } catch (error) {
        console.error('Auth check failed:', error);
        return false;
    }
}

async function authenticate() {
    if (!browser) {
        await initAuth();
    }

    if (isAuthenticated) {
        return true;
    }

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });

        // Navigate to YouTube sign-in page
        await page.goto('https://accounts.google.com/signin/v2/identifier?service=youtube', {
            waitUntil: 'networkidle0',
            timeout: 30000
        });

        // Wait for manual login
        await page.waitForSelector('button#avatar-btn', { timeout: 300000 }); // 5 minute timeout

        // Save cookies after successful login
        const cookies = await page.cookies();
        await fs.promises.writeFile(COOKIES_PATH, JSON.stringify(cookies, null, 2));
        
        isAuthenticated = true;
        await page.close();
        return true;
    } catch (error) {
        console.error('Authentication failed:', error);
        return false;
    }
}

async function getCookies() {
    if (!isAuthenticated) {
        await authenticate();
    }
    
    try {
        const cookiesContent = await fs.promises.readFile(COOKIES_PATH, 'utf8');
        return JSON.parse(cookiesContent);
    } catch (error) {
        console.error('Failed to read cookies:', error);
        return null;
    }
}

async function cleanup() {
    if (browser) {
        await browser.close();
        browser = null;
    }
}

module.exports = {
    initAuth,
    authenticate,
    getCookies,
    cleanup,
    isAuthenticated: () => isAuthenticated
};