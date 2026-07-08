import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
// JSON Schema to enforce structured CRM format output from Gemini according to PDF specs
const crmResponseSchema = {
    type: SchemaType.OBJECT,
    properties: {
        records: {
            type: SchemaType.ARRAY,
            description: 'List of standardized CRM records extracted from the raw input rows.',
            items: {
                type: SchemaType.OBJECT,
                properties: {
                    created_at: { type: SchemaType.STRING, description: 'Lead registration/submission date. Format MUST be YYYY-MM-DD HH:mm:ss.' },
                    name: { type: SchemaType.STRING, description: 'The lead/customer full name. Combine first/last names if split.' },
                    email: { type: SchemaType.STRING, description: 'The primary contact email address (first one found).' },
                    country_code: { type: SchemaType.STRING, description: 'The phone country code if present (e.g., +91, 91), otherwise empty string.' },
                    mobile_without_country_code: { type: SchemaType.STRING, description: 'The primary mobile number excluding country code (e.g. 9876543210).' },
                    company: { type: SchemaType.STRING, description: 'Company name, organization, or employer.' },
                    city: { type: SchemaType.STRING, description: 'City location.' },
                    state: { type: SchemaType.STRING, description: 'State or region.' },
                    country: { type: SchemaType.STRING, description: 'Country location.' },
                    lead_owner: { type: SchemaType.STRING, description: 'The assigned lead owner, representative, or agent.' },
                    crm_status: {
                        type: SchemaType.STRING,
                        enum: ['GOOD_LEAD_FOLLOW_UP', 'DID_NOT_CONNECT', 'BAD_LEAD', 'SALE_DONE'],
                        description: 'Must be exactly one of: GOOD_LEAD_FOLLOW_UP, DID_NOT_CONNECT, BAD_LEAD, SALE_DONE.'
                    },
                    crm_note: { type: SchemaType.STRING, description: 'Includes remarks, comments, and crucially: any secondary/alternative emails or phone numbers.' },
                    data_source: {
                        type: SchemaType.STRING,
                        enum: ['leads_on_demand', 'meridian_tower', 'eden_park', 'varah_swamy', 'sarjapur_plots'],
                        description: 'Must be exactly one of: leads_on_demand, meridian_tower, eden_park, varah_swamy, sarjapur_plots. Do not include if none match confidently.'
                    },
                    possession_time: { type: SchemaType.STRING, description: 'Property possession time, timeline, or move-in date.' },
                    description: { type: SchemaType.STRING, description: 'General description, biography, or background about the lead.' }
                },
                required: [
                    'created_at', 'name', 'email', 'country_code', 'mobile_without_country_code', 'company', 'city', 'state', 'country',
                    'lead_owner', 'crm_status', 'crm_note', 'possession_time', 'description'
                ]
            }
        }
    },
    required: ['records']
};
/**
 * Standardizes a batch of raw records using Gemini API
 * @param records - Raw CSV rows
 * @param headers - Headers of the CSV
 * @param apiKey - Gemini API Key
 * @param mappings - Custom CRM Field to CSV Column mappings
 * @returns Standardized CRM records
 */
export async function processBatchWithGemini(records, headers, apiKey, mappings = {}) {
    if (!apiKey) {
        throw new Error('Gemini API key is required. Please set it in your environment or provide it in the settings panel.');
    }
    const genAI = new GoogleGenerativeAI(apiKey);
    // Use gemini-2.5-flash for speed, cost efficiency, and structured output capabilities.
    const model = genAI.getGenerativeModel({
        model: 'gemini-2.5-flash',
        generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: crmResponseSchema,
            temperature: 0.1 // Low temperature for high determinism in mapping
        },
        systemInstruction: `You are an expert CRM data migration specialist for GrowEasy CRM.
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
7. Do not invent details. Leave fields empty string "" if there is no equivalent data in the row.`
    });
    const prompt = `CSV Column Headers: ${JSON.stringify(headers)}
User-Confirmed Schema Mappings: ${JSON.stringify(mappings, null, 2)}

Raw Rows to process:
${JSON.stringify(records, null, 2)}

Return the standardized JSON representation following the schema.`;
    try {
        const result = await model.generateContent(prompt);
        const responseText = result.response.text();
        if (!responseText) {
            throw new Error('Gemini API returned an empty response.');
        }
        const parsedResponse = JSON.parse(responseText);
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
        console.error('Error calling Gemini API:', error);
        throw new Error(`Gemini processing failed: ${error.message}`);
    }
}
// JSON Schema for AI Schema Detection Mappings
const schemaDetectionResponseSchema = {
    type: SchemaType.OBJECT,
    properties: {
        mappings: {
            type: SchemaType.OBJECT,
            description: 'Mappings from standard CRM fields to the matching CSV headers.',
            properties: {
                created_at: { type: SchemaType.STRING, description: 'The CSV header that represents the lead submission date.' },
                name: { type: SchemaType.STRING, description: 'The CSV header that represents the lead name.' },
                email: { type: SchemaType.STRING, description: 'The CSV header that represents the email address.' },
                country_code: { type: SchemaType.STRING, description: 'The CSV header that represents the phone country code.' },
                mobile_without_country_code: { type: SchemaType.STRING, description: 'The CSV header that represents the phone or mobile number.' },
                company: { type: SchemaType.STRING, description: 'The CSV header for company name.' },
                city: { type: SchemaType.STRING, description: 'The CSV header for city.' },
                state: { type: SchemaType.STRING, description: 'The CSV header for state.' },
                country: { type: SchemaType.STRING, description: 'The CSV header for country.' },
                lead_owner: { type: SchemaType.STRING, description: 'The CSV header for lead owner/rep.' },
                crm_status: { type: SchemaType.STRING, description: 'The CSV header for lead status.' },
                crm_note: { type: SchemaType.STRING, description: 'The CSV header for general notes/remarks.' },
                data_source: { type: SchemaType.STRING, description: 'The CSV header for source.' },
                possession_time: { type: SchemaType.STRING, description: 'The CSV header for possession timeline.' },
                description: { type: SchemaType.STRING, description: 'The CSV header for descriptions.' }
            }
        }
    },
    required: ['mappings']
};
/**
 * Detects mapping from CSV columns to CRM fields using Gemini API
 * @param headers - Headers of the CSV
 * @param sampleRows - A few sample rows (2-3) of the CSV
 * @param apiKey - Gemini API Key
 * @returns Mapping dictionary: crmField -> csvHeader
 */
export async function detectSchemaWithGemini(headers, sampleRows, apiKey) {
    if (!apiKey) {
        throw new Error('Gemini API key is required to detect schema.');
    }
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
        model: 'gemini-2.5-flash',
        generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: schemaDetectionResponseSchema,
            temperature: 0.1
        },
        systemInstruction: `You are a schema matching expert. Given a list of CSV headers and a few sample rows, you must identify which CSV headers correspond to the following standard CRM fields:
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

For each CRM field, select the EXACT header string from the CSV columns list. If a CRM field has no matching header, set it to an empty string "". Use the sample rows to understand the semantic meaning of the headers (e.g. if a header is "Contact Info" but the values are "john@doe.com", it maps to email, not name).`
    });
    const prompt = `CSV Column Headers: ${JSON.stringify(headers)}
Sample Rows:
${JSON.stringify(sampleRows, null, 2)}

Return the schema mapping JSON representation.`;
    try {
        const result = await model.generateContent(prompt);
        const responseText = result.response.text();
        if (!responseText) {
            throw new Error('Gemini API returned an empty response during schema detection.');
        }
        const parsedResponse = JSON.parse(responseText);
        return (parsedResponse.mappings || {});
    }
    catch (error) {
        console.error('Error calling Gemini API for schema detection:', error);
        throw new Error(`Schema detection failed: ${error.message}`);
    }
}
