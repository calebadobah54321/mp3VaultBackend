const axios = require('axios');
const dns = require('dns').promises;
const https = require('https');

async function testProxy(proxyConfig) {
    console.log('\n=== Starting Proxy Test ===');
    const results = {
        basic: false,
        dns: false,
        youtube: false,
        speed: 0,
        errors: []
    };

    // Create axios instance with proxy configuration
    const axiosInstance = axios.create({
        proxy: {
            host: proxyConfig.host,
            port: proxyConfig.port,
            protocol: proxyConfig.type
        },
        httpsAgent: new https.Agent({
            rejectUnauthorized: false // Only if you need to bypass SSL verification
        }),
        timeout: 60000 // 10 second timeout
    });

    try {
        // 1. Test DNS resolution of proxy host
        console.log('\n1. Testing DNS resolution...');
        try {
            const dnsResult = await dns.resolve4(proxyConfig.host);
            console.log(`✓ DNS Resolution successful: ${dnsResult[0]}`);
            results.dns = true;
        } catch (error) {
            console.error(`✗ DNS Resolution failed: ${error.message}`);
            results.errors.push(`DNS Error: ${error.message}`);
        }

        // 2. Basic connectivity test
        console.log('\n2. Testing basic connectivity...');
        const startTime = Date.now();
        try {
            const response = await axiosInstance.get('https://api.ipify.org?format=json');
            results.basic = true;
            results.speed = Date.now() - startTime;
            console.log(`✓ Basic connectivity successful`);
            console.log(`✓ Proxy IP: ${response.data.ip}`);
            console.log(`✓ Response time: ${results.speed}ms`);
        } catch (error) {
            console.error(`✗ Basic connectivity failed: ${error.message}`);
            results.errors.push(`Connectivity Error: ${error.message}`);
            // Log detailed error information
            if (error.response) {
                console.error('Response Error:', {
                    status: error.response.status,
                    headers: error.response.headers,
                    data: error.response.data
                });
            }
        }

        // 3. YouTube-specific test
        console.log('\n3. Testing YouTube connectivity...');
        try {
            const ytResponse = await axiosInstance.get('https://www.youtube.com', {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5'
                }
            });
            
            if (ytResponse.status === 200) {
                console.log(`✓ YouTube connectivity successful`);
                results.youtube = true;
            } else {
                console.error(`✗ YouTube returned status: ${ytResponse.status}`);
                results.errors.push(`YouTube Error: HTTP ${ytResponse.status}`);
            }
        } catch (error) {
            console.error(`✗ YouTube connectivity failed: ${error.message}`);
            results.errors.push(`YouTube Error: ${error.message}`);
            // Log detailed error information
            if (error.response) {
                console.error('YouTube Response Error:', {
                    status: error.response.status,
                    headers: error.response.headers,
                    data: error.response.data
                });
            }
        }

        // Summary
        console.log('\n=== Test Summary ===');
        console.log(`DNS Resolution: ${results.dns ? 'Pass' : 'Fail'}`);
        console.log(`Basic Connectivity: ${results.basic ? 'Pass' : 'Fail'}`);
        console.log(`YouTube Access: ${results.youtube ? 'Pass' : 'Fail'}`);
        console.log(`Response Time: ${results.speed}ms`);
        if (results.errors.length > 0) {
            console.log('\nErrors encountered:');
            results.errors.forEach(error => console.log(`- ${error}`));
        }

        return results;

    } catch (error) {
        console.error('\n✗ Test failed with error:', error.message);
        results.errors.push(`General Error: ${error.message}`);
        return results;
    }
}

// Example usage:
const proxyConfig = {
    host: '8.219.131.17',
    port: 3128,
    type: 'http',
    timeout: 30000  // 30 seconds
};

// Run the test
testProxy(proxyConfig).then(results => {
    console.log('\nTest completed!');
    if (results.errors.length === 0 && results.basic && results.youtube) {
        console.log('✓ Proxy appears to be working correctly!');
    } else {
        console.log('✗ Some tests failed. Please check the errors above.');
    }
});