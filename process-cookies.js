const fs = require('fs');

function extractYouTubeCookies(inputPath, outputPath) {
    try {
        const cookieContent = fs.readFileSync(inputPath, 'utf8');
        let youtubeContent = '';
        
        // Handle Netscape cookie format
        if (cookieContent.includes('# Netscape HTTP Cookie File')) {
            youtubeContent = cookieContent
                .split('\n')
                // Only keep youtube.com cookies
                .filter(line => 
                    line && 
                    !line.startsWith('#') && 
                    (line.includes('youtube.com') || line.includes('.youtube.com'))
                )
                .map(line => {
                    const [domain, subdomain, path, secure, expiry, name, value] = line.split('\t');
                    return `${name}=${value}`;
                })
                .join('; ');
        } else {
            // Handle JSON format
            try {
                const cookiesJson = JSON.parse(cookieContent);
                youtubeContent = cookiesJson
                    .filter(cookie => 
                        cookie.domain.includes('youtube.com') || 
                        cookie.domain.includes('.youtube.com')
                    )
                    .map(cookie => `${cookie.name}=${cookie.value}`)
                    .join('; ');
            } catch (e) {
                console.error('Error parsing JSON:', e);
                return;
            }
        }

        // Create the .env format
        const envContent = `YOUTUBE_COOKIES=${youtubeContent}`;
        
        // Save to file
        fs.writeFileSync(outputPath, envContent);
        console.log(`Successfully saved YouTube cookies to ${outputPath}`);
        
    } catch (error) {
        console.error('Error processing cookies:', error);
    }
}

// Usage
extractYouTubeCookies('./cookies.txt', './youtube_cookies.env');