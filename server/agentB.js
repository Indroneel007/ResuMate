import express from "express";
import fetch from "node-fetch"; 
import { ChatOpenAI } from "@langchain/openai";
import { Tool } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import brevo from "@getbrevo/brevo";
import { HumanMessage } from "@langchain/core/messages";
import path from "path";
import fs from "fs";

const router = express.Router();

const brevoClient = new brevo.TransactionalEmailsApi();
brevoClient.setApiKey(
  brevo.TransactionalEmailsApiApiKeys.apiKey,
  process.env.BREVO_API_KEY
)

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
const fundedStartupsTool = new Tool({
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

// --------------------- Resume Summarizer Tool --------------------
const resumeSummarizerTool = new Tool({
  name: "resume_summarizer",
  description: "Summarize resumes into 5 bullet points highlighting experience & skills",
  func: async (filePath) => {
    const response = await llm.invoke([
      new HumanMessage({
        content: [
          {
            type: "input_text",
            text: "Summarize this resume in 5 bullet points highlighting experience & skills.",
          },
          { type: "input_file", file_data: { path: filePath } },
        ],
      }),
    ]);

    fs.unlinkSync(filePath);
    return response.content[0].text;
  },
});

const llm = new ChatOpenAI({
  openAIApiKey: process.env.OPENAI_API_KEY,
  model: "gpt-oss-20b:free",
  temperature: 0.7,
});

const agentA = createReactAgent({
  llm: llm,
  tools: [resumeSummarizerTool],
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
const emailCuratorTool = new Tool({
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
const sendEmailTool = new Tool({
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

let curated_resume;

router.post("/upload", requireAuth(['access:agentA']), async(req, res)=>{
  try {
    const filePath = path.join(__dirname, "..", req.file.path);
    const summary = await resumeSummarizerTool.func(filePath);

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

export default router;