import express from "express";
import fetch from "node-fetch"; 
import { ChatOpenAI } from "@langchain/openai";
import { DynamicTool } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import brevo from "@getbrevo/brevo";
//import { HumanMessage } from "@langchain/core/messages";
import path from "path";
import fs from "fs";
import { google } from "googleapis";
import multer from "multer";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
// pdf-parse is dynamically imported inside the tool to avoid side effects on module load

dotenv.config();

// ESM-friendly __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

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


function requireAuth(requiredScopes){
  return async (req, res, next) => {
    try {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      if (!token) return res.status(401).json({ error: 'Missing bearer token' });

      // Validate access or session token
      const { token: claims } = await descope.validateSession(token);

      // Scopes are space-separated in the "scope" claim (OAuth convention)
      const scopes = (claims?.scope || '').split(' ').filter(Boolean);
      const ok = requiredScopes.every(s => scopes.includes(s));
      if (!ok) return res.status(403).json({ error: 'Insufficient scope' });

      req.user = claims; // sub, email, roles, scope, etc.
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}


// --------------------- Fetch Recently Funded Startups Tool --------------------
const fundedStartupsTool = new DynamicTool({
  name: "fetch_funded_startups",
  description: "Fetch recently funded startups of the current month with their description and domain",
  func: async () => {
    const query = `recently funded startups of ${new Date().toLocaleString("default", {
      month: "long",
      year: "numeric"
    })} site:crunchbase.com OR site:techcrunch.com`;

    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`, {
      headers: {
        "Accept": "application/json",
        "X-Subscription-Token": process.env.BRAVE_API_KEY,
      },
    });

    if (!res.ok) throw new Error("Brave API failed");
    const data = await res.json();

    return JSON.stringify(
      data.web.results.map(r => {
        const domain = new URL(r.url).hostname.replace("www.", "");
        return {
          company: r.title,
          description: r.snippet,
          url: r.url,
          domain,
        };
      }),
      null,
      2
    );
  },
});

// --------------------- Email Content Extraction Tool -----------------------------------
const emailContentExtractionTool = new DynamicTool({
  name: "email_content_extraction",
  description: "Extract all information from email content from specified users",
  func: async (input) => {
    const {auth, messageId} = JSON.parse(input);

    const gmail = google.gmail({ version: "v1", auth });

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
  description: "Generate a personalized email given resume summary, company name, and description",
  func: async (input) => {
    const { resumeSummary, companyName, recipientName } = JSON.parse(input);

    const prompt = `
      You are writing a professional cold email.
      - Resume Summary: ${resumeSummary}
      - Company: ${companyName}
      - Recipient: ${recipientName}

      Write a concise email introducing myself and aligning my skills with their company.
      Use recipient's name and company name dynamically.
    `;

    const response = await llm.invoke(prompt);
    return response.content[0].text;
  },
});

// -------------------- Send Email --------------------
const sendEmailTool = new DynamicTool({
  name: "send_email",
  description: "Send emails to multiple recipients using Brevo",
  func: async (input) => {
    const { fromEmail, toEmail, subject, body } = JSON.parse(input);

    const recipients = toEmail.map((email) => ({ email }));

    const sendSmtpEmail = {
      sender: { email: fromEmail}, // Must be verified in Brevo
      to: recipients,
      subject,
      htmlContent: `<p>${body}</p>`,
    };

    const result = await brevoClient.sendTransacEmail(sendSmtpEmail);
    return JSON.stringify({ success: true, messageId: result.messageId, recipients: toEmail });
  },
});

const agentB = createReactAgent({
  llm: llm,
  tools: [fundedStartupsTool, emailCuratorTool, sendEmailTool],
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

let curated_resume;

router.post("/upload", upload.single('pdf'), async(req, res)=>{
  try {
    console.log("File metadata:", req.file.filename);

    const filePath = path.join(__dirname, 'uploads', req.file.filename);
    console.log("File Uploaded now going to summarize", filePath);

    /*const summary = await agentA.invoke({
      input: `Summarize the uploaded resume in 5 bullet points.`,
      tools: [{ name: "resume_summarizer", args: filePath }],
    });*/

    const summary = await resumeSummarizerTool.invoke(filePath);

    /*const summary = await agentA.invoke(
      { messages: [new HumanMessage("Summarize ")] },
    );*/

    console.log("Summary: ", summary)
    curated_resume = summary;
    res.json({ summary });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to summarize resume" });
  }
})

let startups = [];

router.get("/recent-companies", requireAuth(['access:agentB']), async (req, res) => {
  try {
    const response = await agentB.invoke({
        input: "Fetch recently funded startups of this month with their description and domains in JSON format"
    });

    try{
        startups = JSON.parse(response.output);
    } catch (err) {
        console.error("Failed to parse agent response:", err);
        return res.status(500).json({ error: "Failed to parse agent response" });
    }

    const enriched = await Promise.all(
      startups.map(async (s) => {
        const emails = await fetchCompanyEmails(s.domain);
        return { ...s, emails };
      })
    );

    return res.status(200).json(enriched);

  } catch (err) {
    console.error("Agent B error:", err);
    return res.status(500).json({ error: err.message });
  }
});

router.post('/email', requireAuth(['access:agentB']), async(req, res)=>{
  try{
    if (!curated_resume) {
      return res.status(400).json({ error: "No resume summary found. Please call /summarize_resume first." });
    }
    if (!startups || startups.length === 0) {
      return res.status(400).json({ error: "No cached companies. Please call /recent_companies first." });
    }

    const {email} = req.user;
    if(!email){
      return res.status(400).json({ error: "No email found in user context." });
    }

    let results = [];

    for (const company of startups) {
      if (!company.emails || company.emails.length === 0) continue;

      // Use the first email as recipient name if name not available
      for (const toEmail of company.emails) {
        const recipientName = toEmail.split('@')[0]; // crude fallback, ideally use real name if available

        // 1. Curate personalized email
        const emailContent = await emailCuratorTool.func(JSON.stringify({
          resumeSummary: curated_resume,
          companyName: company.company,
          recipientName
        }));

        // 2. Send email
        const sendResult = await sendEmailTool.func(JSON.stringify({
          fromEmail,
          toEmail: [toEmail],
          subject: `Opportunities at ${company.company}`,
          body: emailContent
        }));

        results.push({
          company: company.company,
          toEmail,
          sendResult: JSON.parse(sendResult)
        });
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
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: 'consent',
    scope: ["https://www.googleapis.com/auth/gmail.readonly"]
  });
  res.redirect(url);
});

// Callback from Google
router.get("/auth/callback", async (req, res) => {
  try{
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Get logged-in Descope user
    const sessionJwt = req.headers["authorization"]?.split(" ")[1];
    const descopeClient = DescopeClient({ projectId: process.env.DESCOPE_PROJECT_ID });
    const user = await descopeClient.validateJwt(sessionJwt);

    gmailTokens[user.userId] = tokens;

    res.send("Gmail connected successfully!");
  }catch(e){
    console.error("Google OAuth error:", e);
    res.status(500).json({ error: "Google OAuth failed" });
  }
});


router.get("/get_emails", requireAuth(["access:agentA"]), async (req, res) => {
  try {
    const userId = req.user.sub; // Descope user ID
    const tokens = gmailTokens[userId];
    if (!tokens) {
      return res.status(401).json({ error: "User has not connected Gmail" });
    }

    // Init Gmail client with saved tokens
    oauth2Client.setCredentials(tokens);
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

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

      // Step 2: run your extraction tool on each message
      for (const msg of listRes.data.messages) {
        const extracted = await emailContentExtractionTool.func(
          JSON.stringify({ auth: oauth2Client, messageId: msg.id })
        );

        matchedEmails.push(extracted);
      }
    }

    let answer = []; //answer: {sender, summary, result}

    for(const email of matchedEmails) {
      const { from, subject, body } = email;
      const {summary, result} = await emailSummaryTool.func(JSON.stringify({ subject, body }));
      answer.push({ sender: from, summary, result });
    }

    res.json(answer);
  } catch (e) {
    console.error("Error fetching emails:", e);
    res.status(500).json({ error: "Failed to fetch emails" });
  }
});

export default router;