const express = require('express');
const puppeteer = require('puppeteer');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

// Configuration constants - these should be set via environment variables
const NEXTCAPTCHA_SOLVER_URL = process.env.NEXTCAPTCHA_SOLVER_URL || 'https://api.nextcaptcha.com/solve';
const NEXTCAPTCHA_API_KEY = process.env.NEXTCAPTCHA_API_KEY || 'your-api-key-here';

// Function to inject Discord token
async function injectDiscordToken(page, token) {
  try {
    await page.evaluateOnNewDocument((tok) => {
      // Store Discord token in localStorage under 'token' as Discord expects
      Object.defineProperty(window, "localStorage", {
        value: {
          getItem: (key) => key === "token" ? `"${tok}"` : null,
          setItem: () => {},
          removeItem: () => {},
          clear: () => {},
        },
        writable: true
      });
    }, token);
  } catch (error) {
    console.error('Failed to inject Discord token:', error);
    throw error;
  }
}

app.post('/api/solve', async (req, res) => {
  const { token, uid, captcha_url } = req.body;
  
  // Input validation
  if (!token || !uid || !captcha_url) {
    return res.status(400).json({ error: 'Missing token, uid, or captcha_url' });
  }
  if (!captcha_url.includes(uid)) {
    return res.status(400).json({ error: 'captcha_url does not match uid' });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor'
      ]
    });
    
    const page = await browser.newPage();

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    // Inject Discord token
    await injectDiscordToken(page, token);

    // Go to captcha URL (Cloudflare should be bypassed by browser)
    await page.goto(captcha_url, { waitUntil: 'networkidle2', timeout: 60000 });

    // Wait for and extract reCAPTCHA iframe
    const recaptchaFrame = await page.waitForSelector('iframe[src*="recaptcha"]', { timeout: 30000 });
    const recaptchaSrc = await recaptchaFrame.evaluate(el => el.src);

    // Extract sitekey from reCAPTCHA URL
    const sitekeyMatch = recaptchaSrc.match(/[?&]k=([A-Za-z0-9_-]+)/);
    if (!sitekeyMatch) {
      throw new Error('Could not extract sitekey from reCAPTCHA URL');
    }
    const sitekey = sitekeyMatch[1];

    // Solve captcha using NextCaptcha service
    const solverResp = await fetch(NEXTCAPTCHA_SOLVER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': NEXTCAPTCHA_API_KEY
      },
      body: JSON.stringify({
        sitekey,
        url: captcha_url,
        type: 'recaptcha'
      })
    });
    const solverData = await solverResp.json();
    if (!solverData.solution) {
      throw new Error('Captcha not solved: ' + JSON.stringify(solverData));
    }
    const solution = solverData.solution;

    // Inject the solution into the page
    await page.evaluate((token) => {
      const textarea = document.querySelector('textarea[name="g-recaptcha-response"]') || 
                      document.querySelector('textarea[id="g-recaptcha-response"]');
      if (textarea) {
        textarea.value = token;
        textarea.style.display = 'block';
        // Trigger change event
        const event = new Event('change', { bubbles: true });
        textarea.dispatchEvent(event);
        // Also trigger input event
        const inputEvent = new Event('input', { bubbles: true });
        textarea.dispatchEvent(inputEvent);
      }
      // Set all possible reCAPTCHA response textareas
      document.querySelectorAll('textarea[name="g-recaptcha-response"]').forEach(el => {
        el.value = token;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }, solution);

    // Verify the solution was set correctly
    const responseToken = await page.evaluate(() => {
      const textarea = document.querySelector('textarea[name="g-recaptcha-response"]') || 
                       document.querySelector('textarea[id="g-recaptcha-response"]');
      return textarea ? textarea.value : null;
    });
    if (responseToken !== solution) {
      throw new Error('Failed to set the solution token in the textarea');
    }

    // Find and click the verify button
    let verifyBtn = await page.$('button[type="submit"]');
    if (!verifyBtn) {
      // Try to find button with "Verify" text
      const buttons = await page.$x("//button[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'verify')]");
      if (buttons.length > 0) {
        verifyBtn = buttons[0];
      } else {
        // Try input submit
        verifyBtn = await page.$('input[type="submit"]');
      }
    }
    if (!verifyBtn) {
      throw new Error("Couldn't find the Verify button");
    }
    await verifyBtn.click();

    // Wait for navigation or error
    const navigationPromise = page.waitForNavigation({ 
      waitUntil: 'networkidle0', 
      timeout: 30000 
    }).then(() => 'navigation').catch(() => 'navigation_timeout');
    const errorPromise = page.waitForSelector('.error-message, .error, .alert-danger', { 
      timeout: 5000 
    }).then(() => 'error').catch(() => 'no_error');
    const result = await Promise.race([navigationPromise, errorPromise]);

    if (result === 'error') {
      const errorText = await page.evaluate(() => {
        const el = document.querySelector('.error-message, .error, .alert-danger');
        return el ? el.innerText : 'Unknown error';
      });
      throw new Error(`Captcha verification failed: ${errorText}`);
    } else if (result === 'navigation_timeout') {
      throw new Error('Timed out waiting for navigation after captcha verification');
    }

    // Wait for and click authorize button if present
    try {
      await page.waitForSelector('form', { timeout: 10000 });
      const authorizeButtons = await page.$x(
        "//button[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'authorize')]"
      );
      if (authorizeButtons.length > 0) {
        const authorizeBtn = authorizeButtons[0];
        await authorizeBtn.evaluate(btn => btn.scrollIntoView());
        await page.waitForTimeout(1000); // Wait for scroll to complete
        await authorizeBtn.click();
      }
    } catch (authorizeError) {
      console.log('No authorize button found or failed to click:', authorizeError.message);
      // Might be expected, don't throw
    }

    await browser.close();
    return res.json({ success: true, message: 'Verification complete!' });
    
  } catch (error) {
    console.error('Captcha solving error:', error);
    if (browser) {
      await browser.close();
    }
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Captcha solver server running on port ${PORT}`);
});
