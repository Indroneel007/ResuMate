import express from "express";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";
import {path} from "path";
import {fs} from "fs";

const router = express.Router();

const llm = new ChatOpenAI({
  openAIApiKey: process.env.OPENAI_API_KEY,
  model: "gpt-oss-20b:free",
  temperature: 0.7,
});

router.post("/", async(req, res)=>{
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

export default AgentA;