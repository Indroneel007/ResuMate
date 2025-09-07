import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import DescopeClient from '@descope/node-sdk';
import AgentA from "./agentA.js";
import AgentB from "./agentB.js";
import bodyParser from "body-parser";

dotenv.config();

const app = express();

app.use(cors({ origin: ["http://localhost:3000"], credentials: true }));
app.use(express.json());
app.use(bodyParser.json());

const descope = DescopeClient({
  projectId: process.env.DESCOPE_PROJECT_ID,
});

const PORT = process.env.PORT || 5248;
const AGENT_A_PORT = process.env.AGENT_A_PORT || 5249;

// Health check for the main orchestrator
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    service: 'ResuMate Orchestrator',
    agents: {
      agentA: `http://localhost:${AGENT_A_PORT}`,
      agentB: `http://localhost:${PORT}`
    }
  });
});

// Route user-facing resume processing to Agent A
app.use('/agent-a', AgentA);

// Route company research and email sending to Agent B  
app.use('/', AgentB);

// Start main server (Agent B)
app.listen(PORT, () => {
  console.log(`🚀 Agent B (Main Server) running on port ${PORT}`);
  console.log(`📊 Agent A should run on port ${AGENT_A_PORT}`);
  console.log(`🔗 Inter-agent communication secured with Descope roles`);
});

// Start Agent A on separate port
const agentAApp = express();
agentAApp.use(cors({ origin: ["http://localhost:3000", "http://localhost:5248"], credentials: true }));
agentAApp.use(express.json());
agentAApp.use(bodyParser.json());
agentAApp.use('/', AgentA);

agentAApp.listen(AGENT_A_PORT, () => {
  console.log(`🤖 Agent A (Resume & Email Analysis) running on port ${AGENT_A_PORT}`);
});