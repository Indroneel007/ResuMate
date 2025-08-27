import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import DescopeClient from '@descope/node-sdk';
import multer from "multer";
import pdfParse from "pdf-parse";
import AgentB from "./agentB.js";
dotenv.config();

const app = express();

app.use(cors({ origin: ["http://localhost:3000"], credentials: true }));
app.use(express.json());

const descope = new DescopeClient({
  projectId: process.env.DESCOPE_PROJECT_ID,
}).catch(err => {
  console.error("Descope initialization error:", err);
});

const PORT = process.env.PORT || 5248;

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

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

//app.use('/upload', upload.single('resume'), requireAuth(['curate:resume']), AgentA)
app.use('/', AgentB)