import express from "express";
import fetch from "node-fetch"; 
import { ChatOpenAI } from "@langchain/openai";
import { DynamicTool } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import brevo from "@getbrevo/brevo";
import { HumanMessage } from "@langchain/core/messages";
import path from "path";
import fs from "fs";
import { google } from "googleapis";
import DescopeClient from "@descope/node-sdk";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import {chromium} from "playwright";
import crypto from "crypto";

dotenv.config();

// ESM-friendly __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Shared Descope client
const descope = DescopeClient({ projectId: process.env.DESCOPE_PROJECT_ID });

const brevoClient = new brevo.TransactionalEmailsApi();
brevoClient.setApiKey(
  brevo.TransactionalEmailsApiApiKeys.apiKey,
  process.env.BREVO_API_KEY
)

const llm = new ChatOpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  model: "moonshotai/kimi-k2:free",
  temperature: 0,
  configuration: {
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      "HTTP-Referer": "http://localhost:5248",
      "X-Title": "ResuMate-AgentB"
    }
  }
});

const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
);


function requireAuth(requiredScopes = []){
  return async (req, res, next) => {
    try {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      if (!token) return res.status(401).json({ error: 'Missing bearer token' });

      let claims = null;
      try {
        const out = await descope.validateSession(token);
        claims = out?.token || out;
      } catch (_) {
        try {
          claims = await descope.validateJwt(token);
        } catch (e) {
          const rt = req.headers['x-refresh-token'];
          if (rt && typeof rt === 'string') {
            try {
              const refreshed = await descope.validateJwt(rt);
              claims = refreshed?.token || refreshed;
              res.setHeader('X-New-Session', rt);
            } catch (e2) {
              return res.status(401).json({ error: 'Invalid or expired token' });
            }
          } else {
            return res.status(401).json({ error: 'Invalid or expired token' });
          }
        }
      }

      if (!claims?.sub && !claims?.userId) {
        return res.status(401).json({ error: 'Invalid token: missing subject' });
      }

      const scopeStr = claims?.scope || claims?.scp || '';
      const scopes = String(scopeStr).split(/[\s,]+/).filter(Boolean);
      const ok = requiredScopes.every((s) => scopes.includes(s));
      if (!ok) return res.status(403).json({ error: 'Insufficient scope' });

      req.user = claims;
      next();
    } catch (e) {
      console.error('Auth middleware error:', e);
      return res.status(401).json({ error: 'Unauthorized' });
    }
  };
}

// Inter-agent authentication middleware using Descope roles
function requireAgentAuth(req, res, next) {
  return requireAuth()(req, res, (err) => {
    if (err) return next(err);
    
    // Check if user has agent-a or agent-b role for inter-agent communication
    const userRoles = req.user?.roles || [];
    const hasAgentRole = userRoles.includes('agent-a') || userRoles.includes('agent-b');
    
    if (!hasAgentRole) {
      return res.status(403).json({ 
        error: 'Insufficient permissions. Agent role required.',
        requiredRoles: ['agent-a', 'agent-b'],
        userRoles: userRoles 
      });
    }
    
    next();
  });
}

// Helper function to call Agent A using Descope token
async function callAgentA(endpoint, data = null, method = 'GET', userToken = null) {
  const baseUrl = process.env.AGENT_A_URL || 'http://localhost:5249';
  const url = `${baseUrl}${endpoint}`;
  
  console.log(`Calling Agent A: ${method} ${url}`);
  
  if (!userToken) {
    throw new Error('User token required for inter-agent communication');
  }
  
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${userToken}`
    }
  };
  
  if (data && method !== 'GET') {
    options.body = JSON.stringify(data);
  }
  
  try {
    const response = await fetch(url, options);
    console.log(`Agent A response status: ${response.status}`);
    
    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      console.error(`Agent A error response: ${errorText}`);
      throw new Error(`Agent A call failed: ${response.status} ${response.statusText} - ${errorText}`);
    }
    
    return response.json();
  } catch (error) {
    console.error(`Agent A call error:`, error);
    throw error;
  }
}

// Authorization middleware for email sending
function requireEmailAuth(requiredScopes = []) {
  return async (req, res, next) => {
    try {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      if (!token) return res.status(401).json({ error: 'Authentication required to send emails' });

      // Validate token and get user
      let user = null;
      try {
        const out = await descope.validateSession(token);
        user = out?.token || out;
      } catch (_) {
        try {
          user = await descope.validateJwt(token);
        } catch {
          // Try refresh token if provided
          const rt = req.headers['x-refresh-token'];
          if (rt && typeof rt === 'string') {
            try {
              const refreshed = await descope.validateJwt(rt);
              user = refreshed?.token || refreshed;
              res.setHeader('X-New-Session', rt);
            } catch {
              return res.status(401).json({ error: 'Invalid or expired token' });
            }
          } else {
            return res.status(401).json({ error: 'Invalid or expired token' });
          }
        }
      }

      if (!user?.sub && !user?.userId) return res.status(401).json({ error: 'Invalid user token' });

      // Scope check for email endpoints
      if (requiredScopes.length) {
        const scopeStr = user?.scope || user?.scp || '';
        const scopes = String(scopeStr).split(/[\s,]+/).filter(Boolean);
        const ok = requiredScopes.every((s) => scopes.includes(s));
        if (!ok) return res.status(403).json({ error: 'Insufficient scope' });
      }

      // Check if user has connected Gmail
      const userId = user.sub;
      const tokens = gmailTokens[userId] || gmailTokens['default'];
      if (!tokens) {
        return res.status(403).json({ error: 'Gmail not connected. Please connect Gmail first to send emails.' });
      }

      // Get user's email from Gmail profile
      try {
        const oauth2Client = new google.auth.OAuth2(
          process.env.GOOGLE_CLIENT_ID,
          process.env.GOOGLE_CLIENT_SECRET,
          process.env.GOOGLE_REDIRECT_URI
        );
        oauth2Client.setCredentials(tokens);
        
        // Check if tokens are valid and refresh if needed
        try {
          await oauth2Client.getAccessToken();
        } catch (tokenError) {
          console.error('Token refresh failed:', tokenError);
          return res.status(403).json({ error: 'Gmail tokens expired. Please reconnect Gmail.' });
        }
        
        const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
        const profile = await oauth2.userinfo.get();
        
        if (!profile.data.email) {
          console.error('No email in Gmail profile');
          return res.status(403).json({ error: 'Unable to get email from Gmail profile' });
        }
        
        req.user = user;
        req.userEmail = profile.data.email;
        req.gmailTokens = tokens;
        next();
      } catch (e) {
        console.error('Failed to get Gmail profile:', e.message, e.response?.data);
        return res.status(403).json({ error: `Failed to verify Gmail connection: ${e.message}` });
      }
    } catch (e) {
      console.error('Email auth error:', e);
      return res.status(500).json({ error: 'Authentication error' });
    }
  };
}


// --------------------- Fetch Recently Funded Startups Tool --------------------
const fundedStartupsTool = new DynamicTool({
  name: "fetch_funded_startups",
  description: "Fetch recently funded startups of the current month with their description and domain",
  func: async (input) => {
    // Accept either a plain string URL or a JSON string { url }
    let url = String(input || "").trim();
    try {
      const parsed = JSON.parse(String(input));
      if (parsed && typeof parsed.url === "string") url = parsed.url;
    } catch {}

    if (!url) return JSON.stringify([]);

    // Step 1: Scrape article
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });

    const content = await page.evaluate(() => {
      const paragraphs = Array.from(document.querySelectorAll("h1,h2,h3,p,li"))
        .map(p => p.innerText)
        .join("\n\n");
      return paragraphs;
    });
    await browser.close();

    // Step 2: Ask LLM to extract companies (return a JSON string array)
    const prompt = `Extract a JSON array of companies from the article text below.
Each item must be an object with keys: company (string), domain ("company.com" string).
Respond with ONLY valid JSON (no markdown, no preface).

Article text:
${content}`;

    const response = await llm.invoke(prompt);

    // Normalize and ensure we return a JSON string
    let out = "";
    if (typeof response?.content === "string") out = response.content;
    else if (Array.isArray(response?.content)) {
      out = response.content.map((p) => (typeof p === "string" ? p : (p?.text ?? ""))).join("\n");
    } else if (response?.text) out = response.text;
    else out = String(response ?? "");

    out = out.trim();
    try {
      const parsed = JSON.parse(out);
      // Ensure we only return the first 5 companies
      const topFive = Array.isArray(parsed) ? parsed.slice(0, 5) : [];
      return JSON.stringify(topFive);
    } catch {
      // If not valid JSON, return empty list to avoid crashing the agent
      return JSON.stringify([]);
    }
  },
});


const buildTicketPrompt = (searchData) => `
Generate a JSON array with properties:
1. companyName
2. description (one-liner)

Here is some web search data:
${searchData.map((r, i) => `${i+1}. ${r.title}`).join("\n")}
Return exactly JSON.
`;
// -------------------- Fetch Company Emails --------------------
async function fetchCompanyEmails(domain) {
  try {
    const url = `https://api.hunter.io/v2/domain-search?domain=${domain}&api_key=${process.env.HUNTER_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok){
        console.error("Hunter API error:", res.statusText);
        return { error: res.statusText };
    }
    const json = await res.json();

    if (!json.data || !json.data.emails) return { error: "No emails found" };

    // filter for ceo, cto, hr
    const filtered = json.data.emails.filter(e => {
      const pos = (e.position || "").toLowerCase();
      return pos.includes("ceo") || pos.includes("cto") || pos.includes("hr") || pos.includes("founder") || pos.includes("Chief Technology Officer") || pos.includes("Human Resources") || pos.includes("Chief Technology Officer") || pos.includes("Talent Acquisition");
    });

    return filtered.map(e => e.value); // array of email strings
  } catch (err) {
    console.error("Hunter error:", err.message);
    return [];
  }
}

// -------------------- Personalized Email Curator --------------------
const emailCuratorTool = new DynamicTool({
  name: "email_curator",
  description: "Generate a personalized cold email using a fixed template with dynamic placeholders",
  func: async (input) => {
    const { resumeSummary, companyName, recipientName } = JSON.parse(input);

    // Fixed template email
    const emailTemplate = `
Hi ${recipientName},

I hope this message finds you well. I am reaching out to express my interest in opportunities at ${companyName}. 

Based on my background:
${resumeSummary}

I believe my skills and experience align closely with the work being done at ${companyName}, and I am confident I can contribute meaningfully to your team. 

I would greatly appreciate the opportunity to connect and discuss how I could add value.  
Looking forward to your response.

    `;

    return emailTemplate.trim();
  },
});

// -------------------- Send Email (function) --------------------
async function sendEmail({ fromEmail, toEmail, subject, body, tokens }) {
  if (!tokens) {
    throw new Error("Missing Gmail OAuth tokens in sendEmail");
  }
  const oauth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  oauth.setCredentials(tokens);
  const gmail = google.gmail({ version: "v1", auth: oauth });

  const makeRaw = (from, to, subj, html) => {
    const boundary = "mixed-" + Math.random().toString(36).slice(2);
    const message = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subj}`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/alternative; boundary=${boundary}`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      // Plain fallback by stripping tags
      html.replace(/<[^>]+>/g, " ").trim(),
      "",
      `--${boundary}`,
      "Content-Type: text/html; charset=utf-8",
      "",
      html,
      "",
      `--${boundary}--`,
      "",
    ].join("\r\n");
    // Base64url encoding
    return Buffer.from(message)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  };
  console.log("sendEmail() called with", toEmail);

  const recipients = Array.isArray(toEmail) ? toEmail : [toEmail];
  const sent = [];
  for (const recipient of recipients) {
    const raw = makeRaw(fromEmail, recipient, subject, `<p>${body}</p>`);
    const resp = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw },
    });
    sent.push({ recipient, id: resp.data.id, threadId: resp.data.threadId });
  }

  return { success: true, sent };
}

const agentB = createReactAgent({
  llm: llm,
  tools: [fundedStartupsTool, emailCuratorTool],
  maxIterations: 3,
});

// Store company data
const user_data = {};

let startups = [];

router.get("/recent-companies", requireAuth(), async (req, res) => {
  try {
    console.log("Fetching recent companies...");
    const url = "https://startups.gallery/news";
    const response = await fundedStartupsTool.invoke(url);

    console.log("Funded startups tool response:", response);
    try{
      startups = JSON.parse(response);
      } catch (err) {
        console.error("Failed to parse agent response:", err);
        return res.status(500).json({ error: "Failed to parse agent response" });
    }
    // Enrich with emails so downstream /email has recipients
    const enriched = await Promise.all(
      (Array.isArray(startups) ? startups : []).map(async (s) => {
        try {
          const emails = s?.domain ? await fetchCompanyEmails(s.domain) : [];
          return { ...s, emails };
        } catch (e) {
          console.warn('Email enrichment failed for', s?.domain, e?.message || e);
          return { ...s, emails: [] };
        }
      })
    );

    // Cache enriched list for /email endpoint
    startups = enriched;
    // Return array to match client expectations
    return res.status(200).json(enriched);
  } catch (err) {
    console.error("Agent B error:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.post('/email', requireEmailAuth(), async(req, res)=>{
  try{
    const userID = req.user.userId;
    
    // Extract the actual token from Authorization header
    const authHeader = req.headers.authorization || '';
    const userToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    
    if (!userToken) {
      return res.status(401).json({ error: "No authentication token found" });
    }
    
    // Get resume summary from Agent A
    let resumeData;
    try {
      resumeData = await callAgentA(`/resume-summary/${userID}`, null, 'GET', userToken);
    } catch (e) {
      console.error('Error calling Agent A:', e);
      return res.status(400).json({ error: "No resume summary found. Please upload resume first." });
    }
    
    const curated_resume = resumeData.summary;

    if (!startups || startups.length === 0) {
      return res.status(400).json({ error: "No cached companies. Please call /recent_companies first." });
    }

    console.log("Sending emails...");
    const fromEmail = req.userEmail;
    console.log("From email:", fromEmail);

    for (const company of startups) {
      if (!company.emails || company.emails.length === 0) {
        try {
          const fetched = company.domain ? await fetchCompanyEmails(company.domain) : [];
          company.emails = Array.isArray(fetched) ? fetched : [];
        } catch (e) {
          console.warn('Failed fetching emails for', company?.domain, e?.message || e);
          company.emails = [];
        }
      }
      if (!company.emails || company.emails.length === 0) continue;

      for (const toEmail of company.emails) {
        const recipientName = toEmail.split('@')[0];
        console.log("To email:", toEmail);
        console.log("Recipient name:", recipientName);

        const emailContent = await agentB.invoke({
          messages: [
            new HumanMessage(
              [
                "You must use the tool 'email_curator' with the EXACT argument provided below.",
                "Do not fetch yourself. Call the tool and return ONLY the tool result.",
                "",
                `ARGUMENT: ${JSON.stringify({
                  resumeSummary: curated_resume,
                  companyName: company.company,
                  recipientName,
                })}`,
              ].join("\n")
            )
          ]
        });

        let emailText = "";
        try {
          const last = emailContent?.messages?.[emailContent.messages.length - 1];
          if (last) {
            if (typeof last.content === "string") {
              emailText = last.content;
            } else if (Array.isArray(last.content)) {
              emailText = last.content
                .map((p) => (typeof p === "string" ? p : (p?.text ?? "")))
                .filter(Boolean)
                .join("\n");
            } else if (last?.text) {
              emailText = last.text;
            }
          }
        } catch {}

        if (!emailText || !emailText.trim()) {
          try {
            emailText = await emailCuratorTool.invoke(
              JSON.stringify({
                resumeSummary: curated_resume,
                companyName: company.company,
                recipientName,
              })
            );
          } catch (e) {
            console.warn("email_curator fallback failed:", e?.message || e);
            emailText = "";
          }
        }

        const subject = `Application for Opportunities at ${company.company}`;
        const sendResult = await sendEmail({
          fromEmail,
          toEmail: [toEmail],
          subject,
          body: (emailText && emailText.trim()) ? emailText : `Hi ${recipientName},\n\nI am reaching out to express my interest in opportunities at ${company.company}.\n\n${curated_resume}\n\nThanks,\n${fromEmail}`,
          tokens: req.gmailTokens,
        });
        console.log("Gmail send result:", sendResult);
      }
    }

    return res.status(200).json({ message: "Emails sent successfully." });
  }catch(e){
    console.error("Error sending emails:", e);
    return res.status(500).json({ error: "Failed to send emails." });
  }
})

// -------------------------GMAIL-----------------------------
const gmailTokens = {};

router.get("/auth/google", (req, res) => {
  const missing = [
    !process.env.GOOGLE_CLIENT_ID && "GOOGLE_CLIENT_ID",
    !process.env.GOOGLE_CLIENT_SECRET && "GOOGLE_CLIENT_SECRET",
    !process.env.GOOGLE_REDIRECT_URI && "GOOGLE_REDIRECT_URI",
  ].filter(Boolean);
  if (missing.length) {
    return res.status(500).json({
      error: "Missing Google OAuth env vars",
      missing,
      hint: "Set these in server/.env. Example: GOOGLE_REDIRECT_URI=http://localhost:5248/api/auth/callback",
    });
  }

  // Build client per-request to ensure redirect_uri is present
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  const url = client.generateAuthUrl({
    access_type: "offline",
    prompt: 'consent',
    scope: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile"
    ],
  });
  res.redirect(url);
});

// Simple status check (demo): returns true if any user connected
router.get("/auth/status", (req, res) => {
  try{
    const connected = Object.keys(gmailTokens).length > 0;
    return res.json({ connected });
  }catch(e){
    console.error("Status error:", e);
    return res.status(500).json({ connected: false });
  }
});

// Authenticated logout to clear Gmail association for this user
router.post("/auth/logout", requireAuth(), async (req, res) => {
  try {
    const userId = req.user?.sub || req.user?.userId;
    if (userId && gmailTokens[userId]) {
      delete gmailTokens[userId];
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("Logout error:", e);
    return res.status(500).json({ error: "Failed to logout" });
  }
});

// Callback from Google
router.get("/api/auth/callback", async (req, res) => {
  try{
    const { code } = req.query;
    // Use a fresh client with the configured redirect URI for token exchange
    const client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    // Try to associate with a Descope user if Authorization header is present; otherwise store under 'default'
    try {
      const sessionJwt = req.headers["authorization"]?.split(" ")[1];
      if (sessionJwt) {
        const descopeClient = DescopeClient({ projectId: process.env.DESCOPE_PROJECT_ID });
        const user = await descopeClient.validateJwt(sessionJwt);
        gmailTokens[user.userId] = tokens;
      } else {
        gmailTokens["default"] = tokens;
      }
    } catch (assocErr) {
      console.warn("OAuth callback: could not associate tokens to user, storing as 'default'", assocErr?.message || assocErr);
      gmailTokens["default"] = tokens;
    }

    res.send("Gmail connected successfully! You can close this tab.");
  }catch(e){
    console.error("Google OAuth error:", e);
    res.status(500).json({ error: "Google OAuth failed" });
  }
});


router.get("/get_emails", requireEmailAuth(), async (req, res) => {
  try {
    const tokens = req.gmailTokens;
    const oauth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    oauth.setCredentials(tokens);
    const gmail = google.gmail({ version: "v1", auth: oauth });

    const targetSenders = startups.flatMap((s) => s.emails).filter(Boolean);
    let messageIds = [];

    for (const sender of targetSenders) {
      const listRes = await gmail.users.messages.list({
        userId: "me",
        q: `from:${sender}`,
        maxResults: 1,
      });

      if (listRes.data.messages) {
        messageIds.push(...listRes.data.messages.map(msg => msg.id));
      }
    }

    // Call Agent A to extract and analyze emails
    const extractedData = await callAgentA('/extract-email-content', {
      tokens,
      messageIds
    }, 'POST', req.user.token);

    const analysisData = await callAgentA('/analyze-emails', {
      emails: extractedData.emails
    }, 'POST', req.user.token);

    res.json(analysisData.analyses);
  } catch (e) {
    console.error("Error fetching emails:", e);
    res.status(500).json({ error: "Failed to fetch emails" });
  }
});

// Health check endpoint
router.get("/health", (req, res) => {
  res.json({ 
    status: "healthy", 
    agent: "B", 
    capabilities: ["company_research", "email_sending", "startup_discovery"] 
  });
});

// Get API key for inter-agent communication (Admin endpoint)
router.get("/api-key", requireAuth(['admin']), (req, res) => {
  res.json({ apiKey: null });
});

export default router;