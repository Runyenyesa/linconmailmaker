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
const { client_id, client_secret, redirect_uris } = credentials.web;

const oauth2Client = new google.auth.OAuth2(
  client_id, client_secret, process.env.REDIRECT_URI || 'http://localhost:3000/auth/callback'
);

let userTokens = null;

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

app.post('/send', async (req, res) => {
  if (!userTokens) return res.status(401).json({ error: 'Not authenticated' });

  const { recipients, subject, body, isHtml } = req.body;
  oauth2Client.setCredentials(userTokens);
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  let sent = 0, failed = 0;

  await Promise.all(recipients.map(async (r) => {
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
      sent++;
    } catch (e) {
      failed++;
    }
  }));

  res.json({ sent, failed, total: recipients.length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ LinconMailmaker running at http://localhost:${PORT}`);
});
