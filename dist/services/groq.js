function cleanJsonResponse(text) {
    let cleaned = text.trim();
    if (cleaned.startsWith('```json')) {
        cleaned = cleaned.substring(7);
    }
    else if (cleaned.startsWith('```')) {
        cleaned = cleaned.substring(3);
    }
    if (cleaned.endsWith('```')) {
        cleaned = cleaned.substring(0, cleaned.length - 3);
    }
    return cleaned.trim();
}
// JSON Schema to enforce structured CRM format output from Groq according to PDF specs
const crmResponseSchema = {
    type: 'object',
    properties: {
        records: {
            type: 'array',
            description: 'List of standardized CRM records extracted from the raw input rows.',
            items: {
                type: 'object',
                properties: {
                    created_at: { type: 'string', description: 'Lead registration/submission date. Format MUST be YYYY-MM-DD HH:mm:ss.' },
                    name: { type: 'string', description: 'The lead/customer full name. Combine first/last names if split.' },
                    email: { type: 'string', description: 'The primary contact email address (first one found).' },
                    country_code: { type: 'string', description: 'The phone country code if present (e.g., +91, 91), otherwise empty string.' },
                    mobile_without_country_code: { type: 'string', description: 'The primary mobile number excluding country code (e.g. 9876543210).' },
                    company: { type: 'string', description: 'Company name, organization, or employer.' },
                    city: { type: 'string', description: 'City location.' },
                    state: { type: 'string', description: 'State or region.' },
                    country: { type: 'string', description: 'Country location.' },
                    lead_owner: { type: 'string', description: 'The assigned lead owner, representative, or agent.' },
                    crm_status: {
                        type: 'string',
                        enum: ['GOOD_LEAD_FOLLOW_UP', 'DID_NOT_CONNECT', 'BAD_LEAD', 'SALE_DONE'],
                        description: 'Must be exactly one of: GOOD_LEAD_FOLLOW_UP, DID_NOT_CONNECT, BAD_LEAD, SALE_DONE.'
                    },
                    crm_note: { type: 'string', description: 'Includes remarks, comments, and crucially: any secondary/alternative emails or phone numbers.' },
                    data_source: {
                        type: 'string',
                        enum: ['leads_on_demand', 'meridian_tower', 'eden_park', 'varah_swamy', 'sarjapur_plots'],
                        description: 'Must be exactly one of: leads_on_demand, meridian_tower, eden_park, varah_swamy, sarjapur_plots. Do not include if none match confidently.'
                    },
                    possession_time: { type: 'string', description: 'Property possession time, timeline, or move-in date.' },
                    description: { type: 'string', description: 'General description, biography, or background about the lead.' }
                },
                required: [
                    'created_at', 'name', 'email', 'country_code', 'mobile_without_country_code', 'company', 'city', 'state', 'country',
                    'lead_owner', 'crm_status', 'crm_note', 'possession_time', 'description'
                ],
                additionalProperties: false
            }
        }
    },
    required: ['records'],
    additionalProperties: false
};
// JSON Schema for AI Schema Detection Mappings
const schemaDetectionResponseSchema = {
    type: 'object',
    properties: {
        mappings: {
            type: 'object',
            description: 'Mappings from standard CRM fields to the matching CSV headers.',
            properties: {
                created_at: { type: 'string', description: 'The CSV header that represents the lead submission date.' },
                name: { type: 'string', description: 'The CSV header that represents the lead name.' },
                email: { type: 'string', description: 'The CSV header that represents the email address.' },
                country_code: { type: 'string', description: 'The CSV header that represents the phone country code.' },
                mobile_without_country_code: { type: 'string', description: 'The CSV header that represents the phone or mobile number.' },
                company: { type: 'string', description: 'The CSV header for company name.' },
                city: { type: 'string', description: 'The CSV header for city.' },
                state: { type: 'string', description: 'The CSV header for state.' },
                country: { type: 'string', description: 'The CSV header for country.' },
                lead_owner: { type: 'string', description: 'The CSV header for lead owner/rep.' },
                crm_status: { type: 'string', description: 'The CSV header for lead status.' },
                crm_note: { type: 'string', description: 'The CSV header for general notes/remarks.' },
                data_source: { type: 'string', description: 'The CSV header for source.' },
                possession_time: { type: 'string', description: 'The CSV header for possession timeline.' },
                description: { type: 'string', description: 'The CSV header for descriptions.' }
            },
            required: [
                'created_at', 'name', 'email', 'country_code', 'mobile_without_country_code', 'company', 'city', 'state', 'country',
                'lead_owner', 'crm_status', 'crm_note', 'data_source', 'possession_time', 'description'
            ],
            additionalProperties: false
        }
    },
    required: ['mappings'],
    additionalProperties: false
};
/**
 * Standardizes a batch of raw records using Groq API
 * @param records - Raw CSV rows
 * @param headers - Headers of the CSV
 * @param apiKey - Groq API Key
 * @param mappings - Custom CRM Field to CSV Column mappings
 * @returns Standardized CRM records
 */
export async function processBatchWithGroq(records, headers, apiKey, mappings = {}) {
    if (!apiKey) {
        throw new Error('Groq API key is required. Please set it in your environment or provide it in the settings panel.');
    }
    const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
    const systemInstruction = `You are an expert CRM data migration specialist for GrowEasy CRM.
Your objective is to analyze a batch of raw record data parsed from a CSV file and map/clean it into standard GrowEasy CRM fields.

Rules:
1. Examine the column headers, raw row values, and the provided User-Confirmed Schema Mappings.
   - If a CRM field has a mapped CSV column header in the mappings, extract values for that CRM field from that specific CSV column.
   - For fields without mappings, use semantic matching (e.g. "Customer_Name" or "Lead Contact" -> "name").
2. Handling Multiple Contacts:
   - If a record has multiple email addresses: store the FIRST email in the "email" field. Append all other emails to the "crm_note" field, labeled as "Additional Email: [value]".
   - If a record has multiple phone numbers: store the FIRST phone in "mobile_without_country_code" (excluding country code) and the country code (e.g., +91, 91) in "country_code". Append all other phone numbers to the "crm_note" field, labeled as "Additional Phone: [value]".
3. Allowed CRM Status Values:
   - You MUST standardize the lead's status into EXACTLY ONE of the following uppercase status values:
     * GOOD_LEAD_FOLLOW_UP (e.g. for interested, qualified, warm, follow-up, new lead)
     * DID_NOT_CONNECT (e.g. for did not connect, no answer, busy, wrong number, not reachable)
     * BAD_LEAD (e.g. for bad lead, not interested, junk, invalid number, spam)
     * SALE_DONE (e.g. for deal closed, sale won, onboarding, onboarding in progress)
4. Allowed Data Source Values:
   - You MUST map the source to EXACTLY ONE of these values:
     * leads_on_demand
     * meridian_tower
     * eden_park
     * varah_swamy
     * sarjapur_plots
   - If none match confidently, omit the data_source property from the record.
5. Date Format:
   - Standardize the "created_at" field to "YYYY-MM-DD HH:mm:ss" format so that it is convertible using JavaScript's new Date(created_at).
6. Do not lose context. Any fields or information in the CSV that do not map to the standard schema must be formatted nicely and appended to the "crm_note" field. For example: "Original columns: [Header: Value, Header: Value]".
7. Do not invent details. Leave fields empty string "" if there is no equivalent data in the row.
8. Output Format:
   - You MUST return a JSON object with a single root key "records", containing an array of records matching this JSON structure:
     {
       "records": [
         {
           "created_at": "YYYY-MM-DD HH:mm:ss",
           "name": "Full Name",
           "email": "email@example.com",
           "country_code": "+91",
           "mobile_without_country_code": "9876543210",
           "company": "Company Name",
           "city": "City",
           "state": "State",
           "country": "Country",
           "lead_owner": "Lead Owner",
           "crm_status": "GOOD_LEAD_FOLLOW_UP",
           "crm_note": "CRM Note",
           "data_source": "leads_on_demand",
           "possession_time": "Possession Time",
           "description": "Description"
         }
       ]
     }
   - Do not include any explanations, introduction texts, markdown wrappers, or trailing text. Return ONLY the JSON object.`;
    const prompt = `CSV Column Headers: ${JSON.stringify(headers)}
User-Confirmed Schema Mappings: ${JSON.stringify(mappings, null, 2)}

Raw Rows to process:
${JSON.stringify(records, null, 2)}

Return the standardized JSON representation following the schema.`;
    try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: systemInstruction },
                    { role: 'user', content: prompt }
                ],
                response_format: {
                    type: 'json_object'
                },
                temperature: 0.1
            })
        });
        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Groq API error (status ${response.status}): ${errText}`);
        }
        const data = await response.json();
        const responseText = data.choices?.[0]?.message?.content;
        if (!responseText) {
            throw new Error('Groq API returned an empty response.');
        }
        const parsedResponse = JSON.parse(cleanJsonResponse(responseText));
        const results = (parsedResponse.records || []);
        return results.map(r => ({
            created_at: r.created_at || "",
            name: r.name || "",
            email: r.email || "",
            country_code: r.country_code || "",
            mobile_without_country_code: r.mobile_without_country_code || "",
            company: r.company || "",
            city: r.city || "",
            state: r.state || "",
            country: r.country || "",
            lead_owner: r.lead_owner || "",
            crm_status: r.crm_status || "GOOD_LEAD_FOLLOW_UP",
            crm_note: r.crm_note || "",
            data_source: r.data_source || "",
            possession_time: r.possession_time || "",
            description: r.description || ""
        }));
    }
    catch (error) {
        console.error('Error calling Groq API:', error);
        throw new Error(`Groq processing failed: ${error.message}`);
    }
}
/**
 * Detects mapping from CSV columns to CRM fields using Groq API
 * @param headers - Headers of the CSV
 * @param sampleRows - A few sample rows (2-3) of the CSV
 * @param apiKey - Groq API Key
 * @returns Mapping dictionary: crmField -> csvHeader
 */
export async function detectSchemaWithGroq(headers, sampleRows, apiKey) {
    if (!apiKey) {
        throw new Error('Groq API key is required to detect schema.');
    }
    const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
    const systemInstruction = `You are a schema matching expert. Given a list of CSV headers and a few sample rows, you must identify which CSV headers correspond to the following standard CRM fields:
- created_at (created at, date, submission date)
- name (full name, lead name, customer, contact person)
- email (e-mail, mail id, email address)
- country_code (country code, e.g. +91)
- mobile_without_country_code (phone, mobile number, contact no, telephone)
- company (company name, firm, organization)
- city (city, location)
- state (state, region)
- country (country)
- lead_owner (lead owner, sales rep, assigned to)
- crm_status (status, stage, lead status)
- crm_note (remarks, notes, comments)
- data_source (source, campaign, medium)
- possession_time (possession, move-in date, timeline)
- description (description, details, about)

For each CRM field, select the EXACT header string from the CSV columns list. If a CRM field has no matching header, set it to an empty string "". Use the sample rows to understand the semantic meaning of the headers (e.g. if a header is "Contact Info" but the values are "john@doe.com", it maps to email, not name).

Output Format:
- You MUST return a JSON object with a single root key "mappings" containing the mapping dictionary from standard CRM fields to CSV headers, like this:
  {
    "mappings": {
      "created_at": "CSV_HEADER_NAME",
      "name": "CSV_HEADER_NAME",
      "email": "CSV_HEADER_NAME",
      "country_code": "CSV_HEADER_NAME",
      "mobile_without_country_code": "CSV_HEADER_NAME",
      "company": "CSV_HEADER_NAME",
      "city": "CSV_HEADER_NAME",
      "state": "CSV_HEADER_NAME",
      "country": "CSV_HEADER_NAME",
      "lead_owner": "CSV_HEADER_NAME",
      "crm_status": "CSV_HEADER_NAME",
      "crm_note": "CSV_HEADER_NAME",
      "data_source": "CSV_HEADER_NAME",
      "possession_time": "CSV_HEADER_NAME",
      "description": "CSV_HEADER_NAME"
    }
  }
- Do not include any explanations, introduction texts, markdown wrappers, or trailing text. Return ONLY the JSON object.`;
    const prompt = `CSV Column Headers: ${JSON.stringify(headers)}
Sample Rows:
${JSON.stringify(sampleRows, null, 2)}

Return the schema mapping JSON representation.`;
    try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: systemInstruction },
                    { role: 'user', content: prompt }
                ],
                response_format: {
                    type: 'json_object'
                },
                temperature: 0.1
            })
        });
        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Groq API error (status ${response.status}): ${errText}`);
        }
        const data = await response.json();
        const responseText = data.choices?.[0]?.message?.content;
        if (!responseText) {
            throw new Error('Groq API returned an empty response during schema detection.');
        }
        const parsedResponse = JSON.parse(cleanJsonResponse(responseText));
        return (parsedResponse.mappings || {});
    }
    catch (error) {
        console.error('Error calling Groq API for schema detection:', error);
        throw new Error(`Schema detection failed: ${error.message}`);
    }
}
