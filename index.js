require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const fs = require('fs');

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

let userTokens = null;

// Track sent emails per campaign: { campaignKey: Set of emails }
const sentLog = {};

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
  res.redirect('/?authed=true');
});

app.get('/auth/status', (req, res) => {
  res.json({ authed: userTokens !== null });
});

// Check which emails already received a campaign
app.post('/check-duplicates', (req, res) => {
  const { campaignKey, emails } = req.body;
  const alreadySent = sentLog[campaignKey] || new Set();
  const duplicates = emails.filter(e => alreadySent.has(e.toLowerCase()));
  const fresh = emails.filter(e => !alreadySent.has(e.toLowerCase()));
  res.json({ duplicates: duplicates.length, fresh: fresh.length });
});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

app.post('/send', async (req, res) => {
  if (!userTokens) return res.status(401).json({ error: 'Not authenticated' });

  const { recipients, subject, body, isHtml, campaignKey } = req.body;
  oauth2Client.setCredentials(userTokens);
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  // Filter out duplicates
  const key = campaignKey || subject.trim().toLowerCase();
  if (!sentLog[key]) sentLog[key] = new Set();

  const freshRecipients = recipients.filter(r => !sentLog[key].has(r.email.toLowerCase()));
  const skipped = recipients.length - freshRecipients.length;

  let sent = 0, failed = 0;
  const BATCH_SIZE = 10;
  const DELAY_MS = 1500;

  for (let i = 0; i < freshRecipients.length; i += BATCH_SIZE) {
    const batch = freshRecipients.slice(i, i + BATCH_SIZE);

    await Promise.all(batch.map(async (r) => {
      const personalBody = body.replace(/\{\{name\}\}/gi, r.name || r.email);
      const contentType = isHtml ? 'text/html' : 'text/plain';
      const messageParts = [
        `To: ${r.email}`,
        `Subject: ${subject}`,
        `MIME-Version: 1.0`,
        `Content-Type: ${contentType}; charset=UTF-8`,
        ``,
        personalBody
      ];
      const message = messageParts.join('\r\n');
      const encoded = Buffer.from(message)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      try {
        await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encoded } });
        sentLog[key].add(r.email.toLowerCase());
        sent++;
      } catch (e) {
        failed++;
      }
    }));

    // Wait between batches to avoid Gmail rate limiting
    if (i + BATCH_SIZE < freshRecipients.length) {
      await sleep(DELAY_MS);
    }
  }

  res.json({ sent, failed, skipped, total: recipients.length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ LinconMailmaker running at http://localhost:${PORT}`);
});
