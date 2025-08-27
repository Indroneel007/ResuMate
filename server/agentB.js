import express from "express";
import fetch from "node-fetch"; 
import { ChatOpenAI } from "@langchain/openai";
import { Tool } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import brevo from "@getbrevo/brevo";
import { HumanMessage } from "@langchain/core/messages";
import {path} from "path";
import {fs} from "fs";

const router = express.Router();

let defaultClient = brevo.ApiClient.instance;
let apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;
let apiInstance = new brevo.TransactionalEmailsApi();
let sendSmtpEmail = new brevo.SendSmtpEmail();

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


// Tool: Query Brave Search
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

const llm = new ChatOpenAI({
  openAIApiKey: process.env.OPENAI_API_KEY,
  model: "gpt-oss-20b:free",
  temperature: 0.7,
});

const agent = createReactAgent({
  llm: llm,
  tools: [fundedStartupsTool],
});

const buildTicketPrompt = (searchData) => `
Generate a JSON array with properties:
1. companyName
2. description (one-liner)

Here is some web search data:
${searchData.map((r, i) => `${i+1}. ${r.title}`).join("\n")}
Return exactly JSON.
`;

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

router.post("/upload", requireAuth(['access:agentA']), async(req, res)=>{
  try{
    const filePath = path.join(__dirname, "..", req.file.path);

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

    res.json({ summary: response.content[0].text });
  }catch(e){
    console.error(e);
    res.status(500).json({ error: 'Failed to curate resume' });
  }
})

let startups;

router.get("/recent-companies", requireAuth(['access:agentB']), async (req, res) => {
  try {
    const response = await agent.invoke({
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

  }catch(e){

  }
})

export default router;