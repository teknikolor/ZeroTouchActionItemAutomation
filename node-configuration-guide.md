# Node Configuration Guide - Linear Meeting Intelligence Workflow

## Prerequisites

1. **Linear API Token**
   - Go to Linear Settings → API → Personal API keys
   - Create a new token with read/write access to issues
   - Save as n8n credential

2. **Claude API Key**
   - Get from Anthropic Console
   - Save as Header Auth credential in n8n (header name: `x-api-key`)

3. **GitHub Repository**
   - Create a public repo (or private with access token)
   - Upload the prompt template as `linear-meeting-prompt.md`

---

## Node-by-Node Configuration

### 1. Webhook (Trigger)
**Type:** n8n-nodes-base.webhook

**Settings:**
- **HTTP Method:** POST
- **Path:** `krisp-transcript`
- **Response Mode:** Using 'Respond to Webhook' node
- **Authentication:** None (or add if needed)

**Expected Input:**
```json
{
  "meeting_title": "Meeting title from Krisp",
  "transcript": "Full transcript text..."
}
```

---

### 2. Linear: Get All Issues
**Type:** n8n-nodes-base.linear

**Settings:**
- **Resource:** Issue
- **Operation:** Get Many
- **Team:** Select your team or use expression `{{ YOUR_TEAM_ID }}`
- **Return All:** Yes
- **Filters:** 
  - State → Type → In → ["unstarted", "started", "backlog"]
  - Or exclude completed/canceled states

**Output:** Array of Linear issues

---

### 3. Fetch GitHub Prompt
**Type:** n8n-nodes-base.httpRequest

**Settings:**
- **Method:** GET
- **URL:** `https://raw.githubusercontent.com/teknikolor/ZeroTouchActionItemAutomation/refs/heads/main/automated_action_items_prompt.md`
- **Response Format:** Text
- **Options:**
  - **Timeout:** 30000

**Output:** Markdown template with placeholders

---

### 4. Format Linear Data (Code Node)
**Type:** n8n-nodes-base.code

**Settings:**
- **Language:** JavaScript
- **Code:** See "CODE NODE 1" in the code reference

**Output:** Combined webhook and Linear data

---

### 5. Merge
**Type:** n8n-nodes-base.merge

**Settings:**
- **Mode:** Combine
- **Combination Mode:** By Position
- **Output Data:** All Items

**Inputs:**
1. GitHub prompt (Input 1)
2. Formatted Linear data (Input 2)

**Output:** Single merged object

---

### 6. Prompt Builder (Code Node)
**Type:** n8n-nodes-base.code

**Settings:**
- **Language:** JavaScript
- **Code:** See "CODE NODE 2" in the code reference

**Output:** Prompt and Claude request configuration

---

### 7. Claude API (HTTP Request)
**Type:** n8n-nodes-base.httpRequest

**Settings:**
- **Method:** POST
- **URL:** `https://api.anthropic.com/v1/messages`
- **Authentication:** Predefined Credential Type → Header Auth
- **Headers:**
  - `anthropic-version`: `2023-06-01`
  - `content-type`: `application/json`
- **Body:**
  - **Content Type:** JSON
  - **Specify Body:** Using JSON
  - **JSON:** (Expression mode) `{{ $json.claudeRequestBody }}`
- **Options:**
  - **Timeout:** 120000
  - **Response Format:** JSON

---

### 8. Parse Claude Response (Code Node)
**Type:** n8n-nodes-base.code

**Settings:**
- **Language:** JavaScript
- **Code:** See "CODE NODE 3" in the code reference

**Output:** Separated CREATE and UPDATE arrays

---

### 9. Split Create Items (Code Node)
**Type:** n8n-nodes-base.code

**Settings:**
- **Language:** JavaScript
- **Code:** See "CODE NODE 4" in the code reference

**Output:** Individual items for creation

---

### 10. Split Update Items (Code Node)
**Type:** n8n-nodes-base.code

**Settings:**
- **Language:** JavaScript
- **Code:** See "CODE NODE 5" in the code reference

**Output:** Individual items for updating

---

### 11. Linear: Create Issue
**Type:** n8n-nodes-base.linear

**Settings:**
- **Resource:** Issue
- **Operation:** Create
- **Team:** Your team ID
- **Project:** (Optional) Your project ID
- **Title:** (Expression) `{{ $json.linear_fields.title }}`
- **Description:** (Expression) `{{ $json.linear_fields.description }}`
- **Additional Fields:**
  - **Priority:** (Expression) `{{ $json.linear_fields.priority }}`
  - **Due Date:** (Expression) `{{ $json.linear_fields.dueDate }}`
  - **State:** (Optional) Set default state ID

---

### 12. Linear: Get Issue
**Type:** n8n-nodes-base.linear

**Settings:**
- **Resource:** Issue
- **Operation:** Get
- **Issue ID:** (Expression) `{{ $json.linear_fields.issueId }}`

---

### 13. Linear: Update Issue
**Type:** n8n-nodes-base.linear

**Settings:**
- **Resource:** Issue
- **Operation:** Update
- **Issue ID:** (Expression) `{{ $json.linear_fields.issueId }}`
- **Update Fields:**
  - **Description:** (Expression) `{{ $('Linear: Get Issue').item.json.description }}{{ $json.linear_fields.description_append }}`
  - **Priority:** (Expression) `{{ $json.linear_fields.priority }}`
  - **Due Date:** (Expression) `{{ $json.linear_fields.dueDate }}`

---

### 14. Merge Results
**Type:** n8n-nodes-base.merge

**Settings:**
- **Mode:** Combine
- **Combination Mode:** Merge By Index
- **Join:** Inner Join
- **Output Data:** All Matches

**Inputs:**
1. Created issues
2. Updated issues

---

### 15. Format Response (Code Node)
**Type:** n8n-nodes-base.code

**Settings:**
- **Language:** JavaScript
- **Code:** See "CODE NODE 6" in the code reference

**Output:** Final formatted response

---

### 16. Respond to Webhook
**Type:** n8n-nodes-base.respondToWebhook

**Settings:**
- **Respond With:** First Incoming Item
- **Response Code:** 200

---

## External Configuration

### Zapier Zap Configuration
1. **Trigger:** New Krisp Meeting Transcript
2. **Action:** Webhook (POST)
3. **URL:** `https://YOUR-N8N-URL/webhook/krisp-transcript`
4. **Body:**
   ```json
   {
     "meeting_title": "{{krisp_meeting_title}}",
     "transcript": "{{krisp_transcript}}"
   }
   ```

### GitHub Prompt Template
Create `linear-meeting-prompt.md` with:
```markdown
<!-- Configuration -->
<!-- model: claude-3-5-sonnet-20241022 -->
<!-- temperature: 0.3 -->
<!-- max_tokens: 4096 -->

# Linear Meeting Intelligence Prompt
[Rest of template with {{PLACEHOLDERS}}]
```

---

## Testing & Debugging

### Test Webhook Payload
```json
{
  "meeting_title": "Test Meeting",
  "transcript": "John: We need to update the API docs. Jane: I'll handle that by Friday."
}
```

### Common Issues

1. **Merge node returning multiple items**
   - Ensure "Combination Mode" is set to "By Position"

2. **Claude not returning JSON**
   - Check prompt ends with "Return ONLY the JSON object"
   - Verify temperature is not too high

3. **Linear authentication failing**
   - Regenerate API token
   - Check team ID is correct

4. **Missing meeting_title error**
   - Check webhook payload structure
   - Verify Format Linear Data node is passing data correctly

---

## Performance Optimization

1. **Batch Operations**
   - Consider batching Linear API calls for large volumes

2. **Caching**
   - Cache GitHub prompt with longer timeout
   - Store team member mappings

3. **Error Handling**
   - Add IF nodes to handle empty results
   - Implement retry logic for API failures

---

## Security Considerations

1. **Webhook Security**
   - Add webhook authentication
   - Validate incoming data

2. **API Keys**
   - Use n8n credentials system
   - Rotate keys regularly

3. **Data Privacy**
   - Ensure transcripts don't contain sensitive info
   - Consider data retention policies
