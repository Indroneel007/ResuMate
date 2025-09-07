import express from "express";
import { ChatOpenAI } from "@langchain/openai";
import { DynamicTool } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage } from "@langchain/core/messages";
import path from "path";
import fs from "fs";
import { google } from "googleapis";
import DescopeClient from "@descope/node-sdk";
import multer from "multer";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

// ESM-friendly __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Shared Descope client
const descope = DescopeClient({ projectId: process.env.DESCOPE_PROJECT_ID });

const llm = new ChatOpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  model: "moonshotai/kimi-k2:free",
  temperature: 0,
  configuration: {
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      "HTTP-Referer": "http://localhost:5248",
      "X-Title": "ResuMate-AgentA"
    }
  }
});

// Authentication middleware for user requests
function requireAuth(requiredScopes = []) {
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

// --------------------- Resume Summarizer Tool --------------------
const resumeSummarizerTool = new DynamicTool({
  name: "resume_summarizer",
  description: "Summarize resumes into 5 bullet points highlighting experience & skills",
  func: async (filePath) => {
    const { default: pdf } = await import("pdf-parse");
    const dataBuffer = fs.readFileSync(filePath);
    const pdfData = await pdf(dataBuffer);
    const resumeText = pdfData.text || "";

    const prompt = `Summarize the following resume in 5 concise bullet points highlighting experience and skills.

${resumeText.substring(0, 12000)}`;

    const response = await llm.invoke(prompt);

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

// --------------------- Email Content Extraction Tool -----------------------------------
const emailContentExtractionTool = new DynamicTool({
  name: "email_content_extraction",
  description: "Extract all information from email content from specified users",
  func: async (input) => {
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

    const msgRes = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });

    const msg = msgRes.data;
    const headers = msg.payload.headers;
    const getHeader = (name) => {
      const header = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
      return header ? header.value : null;
    };

    const snippet = msg.snippet;

    let body = "";
    if (msg.payload.parts) {
      const plainPart = msg.payload.parts.find((p) => p.mimeType === "text/plain");
      if (plainPart && plainPart.body.data) {
        body = Buffer.from(plainPart.body.data, "base64").toString("utf-8");
      } else {
        body = Buffer.from(msg.payload.parts[0].body.data, "base64").toString("utf-8");
      }
    } else if (msg.payload.body && msg.payload.body.data) {
      body = Buffer.from(msg.payload.body.data, "base64").toString("utf-8");
    }

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

// Create Agent A with its specific tools
const agentA = createReactAgent({
  llm: llm,
  tools: [resumeSummarizerTool, emailContentExtractionTool, emailSummaryTool],
  maxIterations: 3,
});

// File upload configuration
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/')
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
    cb(null, `${uniqueSuffix}-${file.originalname}`)
  }
});

const upload = multer({ storage: storage });

// Store user data
const user_data = {};

// --------------------- AGENT A ENDPOINTS --------------------

// Resume upload and summarization (User-facing endpoint)
router.post("/process-resume", requireAuth(), upload.single("pdf"), async (req, res) => {
  try {
    const filePath = path.join(__dirname, "uploads", req.file.filename);
    const summary = await resumeSummarizerTool.invoke(filePath);
    
    const userID = req.user.userId;
    if (!user_data[userID]) user_data[userID] = {};
    user_data[userID].curated_resume = summary;
    
    res.json({ summary });
  } catch (e) {
    console.error('Resume processing error:', e);
    res.status(500).json({ error: "Failed to summarize resume" });
  }
});

// Get resume summary (Inter-agent endpoint)
router.get("/resume-summary/:userId", requireAuth(), async (req, res) => {
  try {
    const { userId } = req.params;
    const userData = user_data[userId];
    
    if (!userData || !userData.curated_resume) {
      return res.status(404).json({ error: "Resume summary not found" });
    }
    
    res.json({ summary: userData.curated_resume });
  } catch (e) {
    console.error('Get resume summary error:', e);
    res.status(500).json({ error: "Failed to get resume summary" });
  }
});

// Email analysis endpoint (Inter-agent endpoint)
router.post("/analyze-emails", requireAuth(), async (req, res) => {
  try {
    const { emails } = req.body;
    
    if (!Array.isArray(emails)) {
      return res.status(400).json({ error: "emails must be an array" });
    }
    
    const analyses = [];
    
    for (const email of emails) {
      const { from, subject, body } = email;
      const analysis = await emailSummaryTool.func(JSON.stringify({ subject, body }));
      analyses.push({ 
        sender: from, 
        summary: analysis.summary, 
        result: analysis.result 
      });
    }
    
    res.json({ analyses });
  } catch (e) {
    console.error('Email analysis error:', e);
    res.status(500).json({ error: "Failed to analyze emails" });
  }
});

// Extract email content (Inter-agent endpoint)
router.post("/extract-email-content", requireAuth(), async (req, res) => {
  try {
    const { tokens, messageIds } = req.body;
    
    if (!Array.isArray(messageIds)) {
      return res.status(400).json({ error: "messageIds must be an array" });
    }
    
    const extractedEmails = [];
    
    for (const messageId of messageIds) {
      try {
        const extracted = await emailContentExtractionTool.invoke(
          JSON.stringify({ tokens, messageId })
        );
        extractedEmails.push(extracted);
      } catch (e) {
        console.error(`Failed to extract email ${messageId}:`, e);
        // Continue with other emails
      }
    }
    
    res.json({ emails: extractedEmails });
  } catch (e) {
    console.error('Email extraction error:', e);
    res.status(500).json({ error: "Failed to extract email content" });
  }
});

// Health check endpoint
router.get("/health", (req, res) => {
  res.json({ 
    status: "healthy", 
    agent: "A", 
    capabilities: ["resume_processing", "email_analysis", "email_extraction"] 
  });
});

// Get API key for inter-agent communication (Admin endpoint)
router.get("/api-key", requireAuth(['admin']), (req, res) => {
  res.json({ apiKey: null });
});

export default router;
