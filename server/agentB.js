import express from "express";
import fetch from "node-fetch"; 
import { ChatOpenAI } from "@langchain/openai";
import { Tool } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

const router = express.Router();

// Tool: Query Brave Search
const searchRecentlyFunded = new Tool({
  name: "search_recent_funding",
  description: "Search web for recently funded startups this month.",
  func: async (arg) => {
    const params = new URLSearchParams({
      q: arg, count: "10", country: "us", search_lang: "en",
    });
    const url = `https://api.search.brave.com/res/v1/web/search?${params.toString()}`;
    const res = await fetch(url, {
      headers: { "X-Subscription-Token": process.env.BRAVE_API_KEY },
    });
    if (!res.ok) throw new Error(`Brave search failed: ${res.status}`);
    const json = await res.json();
    return json.web?.results.map(r => ({ title: r.title, snippet: r.snippet }));
  },
});

const llm = new ChatOpenAI({
  openAIApiKey: process.env.OPENAI_API_KEY,
  model: "gpt-oss-20b:free",
  temperature: 0.7,
});

const agent = createReactAgent({
  llm: llm,
  tools: [searchRecentlyFunded],
});

const buildTicketPrompt = (searchData) => `
Generate a JSON array with properties:
1. companyName
2. description (one-liner)

Here is some web search data:
${searchData.map((r, i) => `${i+1}. ${r.title}`).join("\n")}
Return exactly JSON.
`;

router.get("/recent-companies", async (req, res) => {
  try {
    const query = `recently funded startups of ${new Date().toLocaleString("default", {
      month: "long", year: "numeric"
    })}`;
    const searchResults = await agent.run(query);
    const parsed = JSON.parse(searchResults);
    return res.json(parsed);
  } catch (err) {
    console.error("Agent B error:", err);
    res.status(500).json({ error: err.message });
  }
});
