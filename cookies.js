const path = require('path');
const COOKIE_FILE = path.join(process.cwd(), 'cookies.txt');

async function initializeCookies() {
    console.log('Using existing cookies file');
    return true;
}

module.exports = {
    COOKIE_FILE,
    initializeCookies
};