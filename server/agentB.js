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
import multer from "multer";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import {chromium} from "playwright";

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
  apiKey: process.env.OPENROUTER_API_KEY, // your OpenRouter key (sk-or-v...)
  model: "moonshotai/kimi-k2:free",     // <-- use the correct slug from OpenRouter
  temperature: 0,
  configuration: {
    baseURL: "https://openrouter.ai/api/v1",  // point to OpenRouter
    defaultHeaders: {
      "HTTP-Referer": "http://localhost:5248", // your app URL or domain
      "X-Title": "ResuMate"
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

      // Validate either session (for web) or access JWT (for API)
      let claims = null;
      try {
        const out = await descope.validateSession(token);
        claims = out?.token || out; // SDK may return { token }
      } catch (_) {
        try {
          claims = await descope.validateJwt(token);
        } catch (e) {
          return res.status(401).json({ error: 'Invalid or expired token' });
        }
      }

      // Basic identity checks
      if (!claims?.sub && !claims?.userId) {
        return res.status(401).json({ error: 'Invalid token: missing subject' });
      }

      // Scopes are space-separated in the "scope" claim (OAuth convention)
      const scopeStr = claims?.scope || claims?.scp || '';
      const scopes = String(scopeStr).split(/[\s,]+/).filter(Boolean);
      const ok = requiredScopes.every((s) => scopes.includes(s));
      if (!ok) return res.status(403).json({ error: 'Insufficient scope' });

      req.user = claims; // subject, scope, etc.
      next();
    } catch (e) {
      console.error('Auth middleware error:', e);
      return res.status(401).json({ error: 'Unauthorized' });
    }
  };
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
          return res.status(401).json({ error: 'Invalid or expired token' });
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

// --------------------- Email Content Extraction Tool -----------------------------------
const emailContentExtractionTool = new DynamicTool({
  name: "email_content_extraction",
  description: "Extract all information from email content from specified users",
  func: async (input) => {
    // Accept either { tokens, messageId } or { messageId } if a global OAuth is desired
    const { tokens, messageId } = JSON.parse(input);

    if (!messageId) throw new Error("messageId is required");

    let gmail;
    if (tokens) {
      const oauth = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
      );
      oauth.setCredentials(tokens);
      gmail = google.gmail({ version: "v1", auth: oauth });
    } else {
      throw new Error("Missing tokens for Gmail client");
    }

    // Fetch full message
    const msgRes = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });

    const msg = msgRes.data;

    // Extract headers
    const headers = msg.payload.headers;
    const getHeader = (name) => {
      const header = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
      return header ? header.value : null;
    };

    // Extract snippet (preview text)
    const snippet = msg.snippet;

    // Extract body (plain text if available)
    let body = "";
    if (msg.payload.parts) {
      // Multi-part email (text/plain, text/html, etc.)
      const plainPart = msg.payload.parts.find((p) => p.mimeType === "text/plain");
      if (plainPart && plainPart.body.data) {
        body = Buffer.from(plainPart.body.data, "base64").toString("utf-8");
      } else {
        // fallback: use first available part
        body = Buffer.from(msg.payload.parts[0].body.data, "base64").toString("utf-8");
      }
    } else if (msg.payload.body && msg.payload.body.data) {
      // Single-part email
      body = Buffer.from(msg.payload.body.data, "base64").toString("utf-8");
    }

    // Final clean JSON
    return {
      id: msg.id,
      threadId: msg.threadId,
      from: getHeader("From"),
      to: getHeader("To"),
      subject: getHeader("Subject"),
      date: getHeader("Date"),
      snippet: snippet,
      body: body.trim(),
    };
  },
});

// --------------------- Email Summary Tool --------------------
const emailSummaryTool = new DynamicTool({
  name: "email_summary",
  description: "Summarize email content into one liner with result",
  func: async (input) => {
    const { subject, body } = JSON.parse(input);

    const prompt = `
      You are an assistant that classifies emails about job applications.
      The email content is below.
      Return a JSON with:
      - "summary": a 1-line plain English summary of the email
      - "result": one of [
        "accepted" :- If the candidate is qualified for the job,
        "pending" :- If the application is under review or further interview processes are scheduled,
        "rejected" :- If the candidate is not a fit or there was no opening at the moment
      ]

      Email Subject: ${subject}
      Email Body: ${body}
    `;

    const response = await llm.invoke(prompt);
    
    let parsed;
    
    try {
      parsed = JSON.parse(response.content);
    } catch (e) {
      parsed = { summary: "Could not parse", result: "pending" };
    }

    return parsed;
  },
});

// --------------------- Resume Summarizer Tool --------------------
const resumeSummarizerTool = new DynamicTool({
  name: "resume_summarizer",
  description: "Summarize resumes into 5 bullet points highlighting experience & skills",
  func: async (filePath) => {
    // Lazy import avoids module side effects at startup
    const { default: pdf } = await import("pdf-parse");
    const dataBuffer = fs.readFileSync(filePath);
    const pdfData = await pdf(dataBuffer);
    const resumeText = pdfData.text || "";

    const prompt = `Summarize the following resume in 5 concise bullet points highlighting experience and skills.

${resumeText.substring(0, 12000)}`;

    const response = await llm.invoke(prompt);

    // Robust normalization across SDK versions/providers
    let out = "";
    if (typeof response?.content === "string") {
      out = response.content;
    } else if (Array.isArray(response?.content)) {
      out = response.content
        .map((p) => (typeof p === "string" ? p : (p?.text ?? "")))
        .filter(Boolean)
        .join("\n");
    } else if (response?.text) {
      out = response.text;
    } else {
      out = String(response ?? "");
    }

    fs.unlinkSync(filePath);
    return out.trim();
  },
});


const agentA = createReactAgent({
  llm: llm,
  tools: [resumeSummarizerTool, emailContentExtractionTool, emailSummaryTool],
  maxIterations: 3,
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

// ---------------------------- File Upload ---------------------------------
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
      cb(null, 'uploads/')
  },
  filename: function (req, file, cb) {
      console.log(file)
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
      cb(null, `${uniqueSuffix}-${file.originalname}`)
  }
})

const upload = multer({storage: storage})

//let curated_resume;
const user_data = {};

router.post("/upload", requireAuth(), upload.single("pdf"), async (req, res) => {
  try {
    // console.log("File metadata:", req.file.filename);

    const filePath = path.join(__dirname, "uploads", req.file.filename);
    // console.log("File Uploaded now going to summarize", filePath);

    let summary = "";
    try {
      // Try via agent first
      const result = await agentA.invoke({
        messages: [
          new HumanMessage(
            [
              "You must use the tool 'resume_summarizer' with the EXACT argument provided below.",
              "Do not summarize yourself. Call the tool and return ONLY the tool result.",
              "",
              `ARGUMENT: ${filePath}`,
            ].join("\n")
          ),
        ],
      });

      const last = result?.messages?.[result.messages.length - 1];
      if (last) {
        summary = Array.isArray(last.content)
          ? last.content
              .map((p) => (typeof p === "string" ? p : p?.text ?? ""))
              .filter(Boolean)
              .join("\n")
          : last.content ?? "";
      }
    } catch (agentErr) {
      // If agent fails (e.g., model lacks tool support), fall back to direct tool
      console.warn("Agent failed; falling back to tool:", agentErr?.message || agentErr);
    }

    if (!summary || !summary.trim()) {
      summary = await resumeSummarizerTool.invoke(filePath);
    }

    //console.log(summary)

    //curated_resume = summary;
    
    const userID =req.user.userId;
    if (!userData[userID]) userData[userID] = {};
    userData[userID].curated_resume = summary;
    
    res.json({ summary });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to summarize resume" });
  }
});

let startups = [];

router.get("/recent-companies", requireAuth(), async (req, res) => {
  try {
    console.log("Fetching recent companies...");
    const url = "https://startups.gallery/news";
    const response = await agentB.invoke({
        messages: [
          new HumanMessage(
            [
              "You must use the tool 'fetch_funded_startups' with the EXACT argument provided below.",
              "Do not fetch yourself. Call the tool and return ONLY the tool result.",
              "",
              `ARGUMENT: ${url}`,
            ].join("\n")
          )
        ]
    });

   // console.log("Agent B response:", response.messages[response.messages.length - 1].content);
    try{
      startups = JSON.parse(response.messages[response.messages.length - 1].content);
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

router.post('/email', requireEmailAuth(["email:send"]), async(req, res)=>{
  try{
    const userID = req.user.userId;
    const user = user_data[userID] || {};
    const { curated_resume } = user;

    if (!curated_resume) {
      return res.status(400).json({ error: "No resume summary found. Please call /summarize_resume first." });
    }
    if (!startups || startups.length === 0) {
      return res.status(400).json({ error: "No cached companies. Please call /recent_companies first." });
    }

    console.log("Sending emails...");
    // Use the Gmail-connected user's email as sender
    const fromEmail = req.userEmail;
    console.log("From email:", fromEmail);
    let results = [];

    for (const company of startups) {
      // Ensure we have emails; fetch if missing
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

      // Use the first email as recipient name if name not available
      for (const toEmail of company.emails) {
        const recipientName = toEmail.split('@')[0]; // crude fallback, ideally use real name if available
        console.log("To email:", toEmail);
        console.log("Recipient name:", recipientName);

        // 1. Curate personalized email
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
        console.log(emailContent);

        // 2. Send email (direct function call)
        const subject = `Application for Opportunities at ${company.company}`;
        const sendResult = await sendEmail({
          fromEmail,
          toEmail: [toEmail],
          subject,
          body: typeof emailContent === 'string' ? emailContent : String(emailContent),
          tokens: req.gmailTokens,
        });
        console.log("Gmail send result:", sendResult);

        /*results.push({
          company: company.company,
          toEmail,
          sendResult: JSON.parse(sendResult)
        });*/
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
      hint: "Set these in server/.env. Example: GOOGLE_REDIRECT_URI=https://localhost:5248/api/auth/callback",
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


router.get("/get_emails", requireEmailAuth(["email:read"]), async (req, res) => {
  try {
    // Tokens already validated by requireEmailAuth()
    const tokens = req.gmailTokens;
    const oauth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    oauth.setCredentials(tokens);
    const gmail = google.gmail({ version: "v1", auth: oauth });

    // Target senders are the company emails you already pulled
    const targetSenders = startups.flatMap((s) => s.emails).filter(Boolean);

    let matchedEmails = [];

    for (const sender of targetSenders) {
      // Step 1: list last email from this sender
      const listRes = await gmail.users.messages.list({
        userId: "me",
        q: `from:${sender}`,
        maxResults: 1,
      });

      if (!listRes.data.messages) continue;

      // Step 2: run extraction tool directly for each message
      for (const msg of listRes.data.messages) {
        const extracted = await agentA.invoke({
          messages: [
            new HumanMessage(
              [
                "You must use the tool 'email_content_extraction' with the EXACT argument provided below.",
                "Do not fetch yourself. Call the tool and return ONLY the tool result.",
                "",
                `ARGUMENT: ${JSON.stringify({ tokens, messageId: msg.id })}`,
              ].join("\n")
            )
          ]
        });
        matchedEmails.push(extracted);
      }
    }

    let answer = []; //answer: {sender, summary, result}

    for(const email of matchedEmails) {
      const { from, subject, body } = email;
      //const {summary, result} = await emailSummaryTool.func(JSON.stringify({ subject, body }));
      const {summary, result} = await agentA.invoke({
        messages: [
          new HumanMessage(
            [
              "You must use the tool 'email_summary' with the EXACT argument provided below.",
              "Do not summarize yourself. Call the tool and return ONLY the tool result.",
              "",
              `ARGUMENT: ${JSON.stringify({ subject, body })}`,
            ].join("\n")
          ),
        ],
      });
      answer.push({ sender: from, summary, result });
    }

    res.json(answer);
  } catch (e) {
    console.error("Error fetching emails:", e);
    res.status(500).json({ error: "Failed to fetch emails" });
  }
});

export default router;