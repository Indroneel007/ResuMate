import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import DescopeClient from '@descope/node-sdk';
import multer from "multer";
import pdfParse from "pdf-parse";
import AgentA from "./curate_resume.js";
import AgentB from "./agentB.js";
dotenv.config();

const app = express();

app.use(cors({ origin: ["http://localhost:3000"], credentials: true }));
app.use(express.json());

const descope = new DescopeClient({
  projectId: process.env.DESCOPE_PROJECT_ID,
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

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

app.use('/upload', upload.single('resume'), requireAuth(['curate:resume']), AgentA)
app.use('/agentB', requireAuth(['access:agentB']), AgentB)