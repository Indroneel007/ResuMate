import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import DescopeClient from '@descope/node-sdk';
//const Descope = require("@descope/node-sdk");
//import multer from "multer";
import AgentB from "./agentB.js";
import bodyParser from "body-parser";
import https from "https";
import fs from "fs";
dotenv.config();

const app = express();

app.use(cors({ origin: ["http://localhost:3000"], credentials: true }));
app.use(express.json());
app.use(bodyParser.json());

const descope = DescopeClient({
  projectId: process.env.DESCOPE_PROJECT_ID,
})

const options = {
  key: fs.readFileSync("./key.pem"),
  cert: fs.readFileSync("./cert.pem"),
};

const PORT = process.env.PORT || 5248;

const userGmailTokens = new Map();

https.createServer(options, app).listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

//app.use('/upload', upload.single('resume'), requireAuth(['curate:resume']), AgentA)
app.use('/', AgentB)