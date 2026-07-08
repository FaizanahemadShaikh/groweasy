import { Router, Request, Response, NextFunction } from 'express';
import { processBatchWithGroq, detectSchemaWithGroq } from '../services/groq.js';
import { ValidationResult } from '../types/index.js';

const router = Router();

// Route 1: Detect schema mapping based on headers and sample rows
router.post('/detect-schema', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { headers, sampleRows } = req.body;
    
    if (!headers || !Array.isArray(headers)) {
       res.status(400).json({
        success: false,
        message: 'Invalid headers list. It must be an array of strings.'
      });
      return;
    }

    const apiKey = (req.headers['x-groq-key'] as string) || (req.headers['x-claude-key'] as string) || (req.headers['x-openrouter-key'] as string) || (req.headers['x-gemini-key'] as string) || process.env.GROQ_API_KEY || process.env.CLAUDE_API_KEY || process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) {
       res.status(400).json({
        success: false,
        message: 'Groq API Key is missing. Please provide it in the UI settings or configure GROQ_API_KEY in the backend.'
      });
      return;
    }

    const mappings = await detectSchemaWithGroq(headers, sampleRows || [], apiKey);
    
    res.json({
      success: true,
      mappings
    });

  } catch (error: any) {
    console.error('Error in detect-schema route:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'An error occurred during schema detection.'
    });
  }
});

// Route 2: Process batch standardization with validation & skips
router.post('/process-batch', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { records, headers, mappings } = req.body;

    if (!records || !Array.isArray(records)) {
       res.status(400).json({
        success: false,
        message: 'Records are missing or not formatted as a JSON array.'
      });
      return;
    }

    if (!headers || !Array.isArray(headers)) {
       res.status(400).json({
        success: false,
        message: 'Headers array is missing.'
      });
      return;
    }

    // Direct Gemini API key validation check
    const apiKey = (req.headers['x-groq-key'] as string) || (req.headers['x-claude-key'] as string) || (req.headers['x-openrouter-key'] as string) || (req.headers['x-gemini-key'] as string) || process.env.GROQ_API_KEY || process.env.CLAUDE_API_KEY || process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) {
       res.status(400).json({
        success: false,
        message: 'Groq API Key is missing. Please provide it in the UI settings or configure GROQ_API_KEY in the backend.'
      });
      return;
    }

    console.log(`Processing batch of ${records.length} records with Groq...`);
    
    // Call Groq to standardize the records
    const processedRecords = await processBatchWithGroq(records, headers, apiKey, mappings || {});

    // Apply strict CRM validation rules:
    // "Records without both an email address and a mobile number should be skipped."
    const validationResults: Array<ValidationResult> = processedRecords.map((record, index) => {
      const emailVal = record.email ? record.email.trim() : '';
      const mobileVal = record.mobile_without_country_code ? record.mobile_without_country_code.trim() : '';
      
      const hasEmail = emailVal.length > 0;
      const hasMobile = mobileVal.length > 0;

      // Skip condition: lacks BOTH email AND mobile number
      const isSkipped = !hasEmail && !hasMobile;

      return {
        ...record,
        skipped: isSkipped,
        skipReason: isSkipped ? 'Missing both email address and mobile number' : null,
        originalIndex: index
      };
    });

    res.json({
      success: true,
      batchSize: records.length,
      records: validationResults
    });

  } catch (error: any) {
    console.error('Error processing batch:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'An error occurred during batch processing'
    });
  }
});

export default router;
