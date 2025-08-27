import express from "express";
import fetch from "node-fetch"; 
import { ChatOpenAI } from "@langchain/openai";
import { Tool } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

const router = express.Router();

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

router.get("/recent-companies", async (req, res) => {
  try {
    const response = await agent.invoke({
        input: "Fetch recently funded startups of this month with their description and domains in JSON format"
    });

    let startups;
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

    res.json(enriched);
    
  } catch (err) {
    console.error("Agent B error:", err);
    res.status(500).json({ error: err.message });
  }
});
