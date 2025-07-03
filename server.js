const puppeteer = require('puppeteer');
const axios = require('axios');

const NEXTCAPTCHA_API_KEY = 'YOUR_NEXTCAPTCHA_API_KEY';

async function getSitekeyAndCookies(uid) {
    const url = `https://verify.poketwo.net/captcha/${uid}`;
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();

    // Go to the target URL (waits for CF JS challenge automatically)
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    // Wait for the reCAPTCHA iframe to appear on the page
    await page.waitForSelector('iframe[src*="recaptcha"]', { timeout: 20000 });

    // Extract the sitekey from the page
    const sitekey = await page.evaluate(() => {
        const elem = document.querySelector('[data-sitekey]');
        return elem ? elem.getAttribute('data-sitekey') : null;
    });

    // Get cookies set by Cloudflare/session
    const cookies = await page.cookies();

    await browser.close();
    return { sitekey, cookies };
}

async function solveRecaptchaWithNextCaptcha(sitekey, uid) {
    const url = `https://verify.poketwo.net/captcha/${uid}`;
    const payload = {
        clientKey: NEXTCAPTCHA_API_KEY,
        task: {
            type: 'RecaptchaV2TaskProxyless',
            websiteURL: url,
            websiteKey: sitekey
        }
    };

    // Create the task
    const createResp = await axios.post('https://api-v2.nextcaptcha.com/createTask', payload, {
        headers: { 'Content-Type': 'application/json' }
    });

    const { taskId } = createResp.data;

    // Poll for the result
    while (true) {
        await new Promise(res => setTimeout(res, 5000));
        const resResp = await axios.post('https://api-v2.nextcaptcha.com/getTaskResult', {
            clientKey: NEXTCAPTCHA_API_KEY,
            taskId
        }, { headers: { 'Content-Type': 'application/json' } });

        if (resResp.data.status === 'ready' && resResp.data.solution && resResp.data.solution.gRecaptchaResponse) {
            return resResp.data.solution.gRecaptchaResponse;
        } else if (resResp.data.status === 'failed') {
            throw new Error('Captcha solving failed: ' + JSON.stringify(resResp.data));
        }
        // Otherwise, keep waiting
    }
}

// MAIN FUNCTION
async function main(uid) {
    console.log('Navigating to page and bypassing Cloudflare...');
    const { sitekey, cookies } = await getSitekeyAndCookies(uid);

    if (!sitekey) {
        throw new Error('Could not find reCAPTCHA sitekey!');
    }
    console.log('Found sitekey:', sitekey);

    const token = await solveRecaptchaWithNextCaptcha(sitekey, uid);
    console.log('Solved captcha token:', token);

    // You can now submit this token to the Pokétwo verification endpoint, using the cookies you received if needed
    // (This part depends on the rest of your automation)
}

// Usage: node solve_poketwo_captcha.js <uid>
if (require.main === module) {
    const uid = process.argv[2];
    if (!uid) {
        console.error('Usage: node solve_poketwo_captcha.js <uid>');
        process.exit(1);
    }
    main(uid).catch(err => {
        console.error('Error:', err);
        process.exit(1);
    });
}
