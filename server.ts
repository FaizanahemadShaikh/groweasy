import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import importRouter from './routes/import.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5001;

// Enable CORS for all routes (configured to allow frontend access)
app.use(cors({
  origin: '*', // Allows access from any port (e.g. Next.js dev on 3000)
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-gemini-key', 'x-openrouter-key', 'x-groq-key']
}));

// Express middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    time: new Date(),
    hasServerKey: !!process.env.GROQ_API_KEY || !!process.env.OPENROUTER_API_KEY || !!process.env.GEMINI_API_KEY
  });
});

// Import route mounting
app.use('/api/import', importRouter);

// Start server listening
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
