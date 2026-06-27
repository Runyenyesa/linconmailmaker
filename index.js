require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const fs = require('fs');
const https = require('https');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const credentials = process.env.CREDENTIALS_JSON 
  ? JSON.parse(process.env.CREDENTIALS_JSON)
  : JSON.parse(fs.readFileSync('credentials.json'));
const { client_id, client_secret } = credentials.web;

const oauth2Client = new google.auth.OAuth2(
  client_id, client_secret, process.env.REDIRECT_URI || 'http://localhost:3000/auth/callback'
);

let userEmail = null;
let userTokens = null;

const sentLog = {};
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

app.get('/auth', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/userinfo.email'
    ],
    prompt: 'consent'
  });
  res.redirect(authUrl);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  userTokens = tokens;
  const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
  const { data } = await oauth2.userinfo.get();
  userEmail = data.email;
  res.redirect('/?authed=true');
});

app.get('/auth/status', (req, res) => {
  res.json({ authed: userTokens !== null, email: userEmail });
});

function sendViaBrevo(toEmail, toName, fromEmail, subject, body, isHtml) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      sender: { name: process.env.SENDER_NAME || fromEmail, email: fromEmail },
      to: [{ email: toEmail, name: toName || toEmail }],
      subject: subject,
      ...(isHtml ? { htmlContent: body } : { textContent: body })
    });

    const options = {
      hostname: 'api.brevo.com',
      path: '/v3/smtp/email',
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'api-key': process.env.BREVO_API_KEY,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`Brevo error ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

app.post('/send', async (req, res) => {
  if (!userTokens) return res.status(401).json({ error: 'Not authenticated' });
  if (!process.env.BREVO_API_KEY) return res.status(500).json({ error: 'Brevo API key not configured' });

  const { recipients, subject, body, isHtml, campaignKey } = req.body;
  const fromEmail = userEmail || 'lincoln.tubayooperations@gmail.com';

  const key = campaignKey || subject.trim().toLowerCase();
  if (!sentLog[key]) sentLog[key] = new Set();

  const freshRecipients = recipients.filter(r => !sentLog[key].has(r.email.toLowerCase()));
  const skipped = recipients.length - freshRecipients.length;

  let sent = 0, failed = 0;
  const BATCH_SIZE = 10;
  const DELAY_MS = 1000;

  for (let i = 0; i < freshRecipients.length; i += BATCH_SIZE) {
    const batch = freshRecipients.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (r) => {
      const personalBody = body.replace(/\{\{name\}\}/gi, r.name || r.email.split('@')[0]);
      try {
        await sendViaBrevo(r.email, r.name, fromEmail, subject, personalBody, isHtml);
        sentLog[key].add(r.email.toLowerCase());
        sent++;
      } catch (e) {
        console.error(`Failed to send to ${r.email}:`, e.message);
        failed++;
      }
    }));
    if (i + BATCH_SIZE < freshRecipients.length) await sleep(DELAY_MS);
  }

  res.json({ sent, failed, skipped, total: recipients.length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ LinconMailmaker running at http://localhost:${PORT}`);
});