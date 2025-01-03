const path = require('path');

// Use absolute path for the cookie file
const COOKIE_FILE = path.join(__dirname, 'cookie.txt');

async function initializeCookies() {
    const fs = require('fs');
    if (!fs.existsSync(COOKIE_FILE)) {
        console.error('Cookie file not found:', COOKIE_FILE);
        throw new Error('Cookie file not found');
    }
    console.log('Using cookie file:', COOKIE_FILE);
}

module.exports = {
    COOKIE_FILE,
    initializeCookies
};