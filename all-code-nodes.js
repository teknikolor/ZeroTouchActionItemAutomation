// ============================================
// CODE NODE 1: Format Linear Data
// ============================================
// Purpose: Combines webhook data with Linear issues data
// Inputs: Webhook data and Linear issues from previous nodes
// Output: Structured object with webhookData and linearData

// Get the webhook data
const webhookData = $('Webhook').first().json.body;

// Get all Linear issues  
const linearIssues = $('Linear: Get All Issues').all().map(item => item.json);

// Extract team members from assignees (unique list)
const teamMembers = [...new Set(
  linearIssues
    .filter(issue => issue.assignee)
    .map(issue => issue.assignee.name || issue.assignee.displayName || issue.assignee.email)
)];

// Get unique states
const states = [...new Set(
  linearIssues
    .filter(issue => issue.state)
    .map(issue => issue.state.name)
)];

// Format the output
return {
  webhookData: webhookData,
  linearData: {
    issues: linearIssues,
    issueCount: linearIssues.length,
    teamMembers: teamMembers,
    states: states
  }
};


// ============================================
// CODE NODE 2: Prompt Builder
// ============================================
// Purpose: Builds Claude prompt with context and configuration
// Inputs: GitHub prompt template + formatted data from merge
// Output: Prompt, configuration, and Claude request body

// Prompt Builder - n8n Code Node

// Get the single merged input
const input = $input.first().json;

// Extract data from the merged input
const promptTemplate = input.data;
const webhookData = input.webhookData || {};
const linearData = input.linearData || {};

// Validate required fields
if (!promptTemplate) {
  throw new Error('Missing prompt template from GitHub');
}
if (!webhookData.meeting_title) {
  throw new Error('Missing meeting_title in webhook data');
}
if (!webhookData.transcript) {
  throw new Error('Missing transcript in webhook data');
}

console.log('Processing meeting:', webhookData.meeting_title);

// Extract configuration from markdown comments
const extractConfig = (template) => {
  const config = {
    model: 'claude-3-5-sonnet-20241022',
    temperature: 0.3,
    maxTokens: 4096
  };
  
  const modelMatch = template.match(/<!--\s*model:\s*([^\s]+)\s*-->/);
  const tempMatch = template.match(/<!--\s*temperature:\s*([0-9.]+)\s*-->/);
  const tokensMatch = template.match(/<!--\s*max_tokens:\s*([0-9]+)\s*-->/);
  
  if (modelMatch) config.model = modelMatch[1];
  if (tempMatch) config.temperature = parseFloat(tempMatch[1]);
  if (tokensMatch) config.maxTokens = parseInt(tokensMatch[1]);
  
  return config;
};

// Helper function to format existing issues
const formatExistingIssues = (issues) => {
  if (!issues || issues.length === 0) {
    return "No existing issues found.";
  }
  
  return issues.map(issue => {
    return `- ID: ${issue.id}
  Identifier: ${issue.identifier}
  Title: ${issue.title}
  Description: ${issue.description || 'No description'}
  State: ${issue.state}
  Assignee: ${issue.assignee || 'Unassigned'}
  Priority: ${issue.priority}
  Due Date: ${issue.dueDate || 'No due date'}`;
  }).join('\n\n');
};

// Helper function to format team members
const formatTeamMembers = (members) => {
  if (!members || members.length === 0) {
    return "No team members found in Linear.";
  }
  return members.map(m => typeof m === 'string' ? `- ${m}` : `- ${m.name}`).join('\n');
};

// Extract configuration
const config = extractConfig(promptTemplate);

// Create replacements
const replacements = {
  '{{MEETING_TITLE}}': webhookData.meeting_title,
  '{{CURRENT_DATE}}': new Date().toISOString().split('T')[0],
  '{{TRANSCRIPT}}': webhookData.transcript,
  '{{ISSUE_COUNT}}': linearData.issueCount.toString(),
  '{{EXISTING_ISSUES}}': formatExistingIssues(linearData.issues),
  '{{TEAM_MEMBERS}}': formatTeamMembers(linearData.teamMembers),
  '{{AVAILABLE_STATES}}': linearData.states.join(', ')
};

// Replace all placeholders
let finalPrompt = promptTemplate;
for (const [placeholder, value] of Object.entries(replacements)) {
  while (finalPrompt.includes(placeholder)) {
    finalPrompt = finalPrompt.replace(placeholder, value);
  }
}

// Remove configuration comments
finalPrompt = finalPrompt.replace(/<!--[^>]*-->\n*/g, '');

// Return data with Claude request body
return {
  json: {
    prompt: finalPrompt.trim(),
    model: config.model,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    meeting_title: webhookData.meeting_title,
    
    claudeRequestBody: {
      model: config.model,
      messages: [
        {
          role: "user",
          content: finalPrompt.trim()
        }
      ],
      max_tokens: config.maxTokens,
      temperature: config.temperature
    },
    
    metadata: {
      meeting_title: webhookData.meeting_title,
      issue_count: linearData.issueCount,
      timestamp: new Date().toISOString()
    }
  }
};


// ============================================
// CODE NODE 3: Parse Claude Response
// ============================================
// Purpose: Parse Claude's JSON and separate CREATE vs UPDATE items
// Inputs: Claude API response
// Output: itemsToCreate[], itemsToUpdate[], summary

// Parse Claude Response - INTELLIGENT VERSION
// This version separates items into CREATE and UPDATE actions

// Get Claude's response
const input = $input.first().json;

// Handle both array and object responses from HTTP node
const response = Array.isArray(input) ? input[0] : input;

// Get meeting title from the previous node (Prompt Builder)
// Try multiple paths in case the data structure varies
const meeting_title = $('Prompt Builder').first().json.meeting_title || 
                     $('Prompt Builder').first().json.metadata?.meeting_title ||
                     $('Webhook').first().json.body?.meeting_title ||
                     'Meeting';

// Extract the text content from Claude's response
let claudeText = '';

// Handle different Claude response formats
if (response.content && Array.isArray(response.content)) {
  claudeText = response.content[0].text?.trim() || '';
} else if (typeof response === 'string') {
  claudeText = response.trim();
} else if (response.text) {
  claudeText = response.text.trim();
}

// Log for debugging
console.log("Meeting title:", meeting_title);
console.log("Raw Claude response:", claudeText.substring(0, 200) + "...");

// Clean up the response if it has markdown code blocks
if (claudeText.includes('```')) {
  claudeText = claudeText.replace(/```json\n/g, '').replace(/```\n/g, '').replace(/```/g, '').trim();
}

try {
  // Parse the JSON response
  const claudeData = JSON.parse(claudeText);
  
  // Validate we have action_items array
  if (!claudeData.action_items || !Array.isArray(claudeData.action_items)) {
    throw new Error('Claude did not return action_items array');
  }
  
  // Separate items into CREATE and UPDATE arrays
  const itemsToCreate = [];
  const itemsToUpdate = [];
  
  claudeData.action_items.forEach((item, index) => {
    // Build description with meeting context
    let baseDescription = `${item.description || 'No additional context provided'}`;
    
    // Add assignee info if mentioned
    if (item.assignee) {
      baseDescription += `\n\n**Assigned to: ${item.assignee}** *(from meeting transcript)*`;
    }
    
    // Add context if provided
    if (item.context) {
      baseDescription += `\n\n**Context:** ${item.context}`;
    }
    
    // Add due date if mentioned
    if (item.due_date) {
      baseDescription += `\n\n**Due Date Mentioned:** ${item.due_date}`;
    }
    
    // Common fields for both create and update
    const commonFields = {
      title: item.title,
      priority: item.priority || 3,
      dueDate: item.due_date || null,
      mentionedAssignee: item.assignee || null,
      originalIndex: index
    };
    
    // Check if this is an UPDATE or CREATE
    if (item.linear_action === 'update' && item.existing_issue_id) {
      // This is an UPDATE
      itemsToUpdate.push({
        ...commonFields,
        issueId: item.existing_issue_id,
        identifier: item.existing_issue_identifier,
        existingTitle: item.existing_issue_title,
        confidence: item.confidence,
        reasoning: item.matching_reasoning,
        
        // For updates, create an append description
        updateDescription: `\n\n---\n**Update from Meeting: ${meeting_title}**\nDate: ${new Date().toISOString().split('T')[0]}\n\n${baseDescription}\n\n*Match Confidence: ${(item.confidence * 100).toFixed(0)}%*\n*Reasoning: ${item.matching_reasoning}*`
      });
      
      console.log(`Item ${index}: UPDATE issue ${item.existing_issue_identifier} (${(item.confidence * 100).toFixed(0)}% confidence)`);
      
    } else {
      // This is a CREATE
      itemsToCreate.push({
        ...commonFields,
        // Full description for new issues
        description: `**From Meeting: ${meeting_title}**\nDate: ${new Date().toISOString().split('T')[0]}\n\n${baseDescription}`
      });
      
      console.log(`Item ${index}: CREATE new issue - "${item.title}"`);
    }
  });
  
  // Log summary
  console.log(`\nSummary:`);
  console.log(`Total action items: ${claudeData.action_items.length}`);
  console.log(`To CREATE: ${itemsToCreate.length} new issues`);
  console.log(`To UPDATE: ${itemsToUpdate.length} existing issues`);
  console.log(`Attendees: ${(claudeData.attendees || []).join(', ')}`);
  
  // Return a single object with both arrays
  return {
    json: {
      itemsToCreate: itemsToCreate,
      itemsToUpdate: itemsToUpdate,
      summary: {
        total: claudeData.action_items.length,
        creating: itemsToCreate.length,
        updating: itemsToUpdate.length,
        attendees: claudeData.attendees || [],
        decisions: claudeData.decisions || [],
        follow_ups: claudeData.follow_ups || []
      },
      meeting_title: meeting_title,
      processed_at: new Date().toISOString()
    }
  };
  
} catch (error) {
  // Return error information
  console.error("Parse error:", error.message);
  console.error("Claude response preview:", claudeText.substring(0, 500));
  
  return {
    json: {
      error: true,
      message: `Failed to parse Claude response: ${error.message}`,
      claudeResponse: claudeText.substring(0, 500),
      meeting_title: meeting_title
    }
  };
}


// ============================================
// CODE NODE 4: Split Create Items
// ============================================
// Purpose: Split items that need to be created into individual items
// Inputs: Parse Claude Response output
// Output: Individual items for Linear Create Issue node

// Split Create Items
// This node outputs each item that needs to be CREATED as a separate item

const input = $input.first().json;

// Check if we have items to create
if (!input.itemsToCreate || input.itemsToCreate.length === 0) {
  console.log("No items to create");
  return [];
}

console.log(`Splitting ${input.itemsToCreate.length} items for creation`);

// Return each item as a separate output
return input.itemsToCreate.map((item, index) => {
  console.log(`Create item ${index}: ${item.title}`);
  
  return {
    json: {
      // All fields from the parsed item
      ...item,
      
      // Add workflow metadata
      action: 'create',
      meeting_title: input.meeting_title,
      
      // Linear-specific fields for create operation
      linear_fields: {
        title: item.title,
        description: item.description,
        priority: item.priority,
        dueDate: item.dueDate,
        // Note: assigneeId would need to be mapped from name to ID
        // This might be done in the Linear Create node or a mapping node
        mentionedAssignee: item.mentionedAssignee
      }
    }
  };
});


// ============================================
// CODE NODE 5: Split Update Items
// ============================================
// Purpose: Split items that need to be updated into individual items
// Inputs: Parse Claude Response output
// Output: Individual items for Linear Update flow

// Split Update Items
// This node outputs each item that needs to be UPDATED as a separate item

const input = $input.first().json;

// Check if we have items to update
if (!input.itemsToUpdate || input.itemsToUpdate.length === 0) {
  console.log("No items to update");
  return [];
}

console.log(`Splitting ${input.itemsToUpdate.length} items for update`);

// Return each item as a separate output
return input.itemsToUpdate.map((item, index) => {
  console.log(`Update item ${index}: ${item.identifier} - ${item.existingTitle}`);
  console.log(`Confidence: ${(item.confidence * 100).toFixed(0)}%`);
  
  return {
    json: {
      // All fields from the parsed item
      ...item,
      
      // Add workflow metadata
      action: 'update',
      meeting_title: input.meeting_title,
      
      // Linear-specific fields for update operation
      linear_fields: {
        // Required field for update
        issueId: item.issueId,
        
        // Fields to update
        description_append: item.updateDescription,
        
        // Optional updates based on meeting
        priority: item.priority,
        dueDate: item.dueDate,
        
        // Keep track of what we're updating
        update_metadata: {
          identifier: item.identifier,
          original_title: item.existingTitle,
          confidence: item.confidence,
          reasoning: item.reasoning,
          mentioned_assignee: item.mentionedAssignee
        }
      }
    }
  };
});


// ============================================
// CODE NODE 6: Format Response
// ============================================
// Purpose: Format final response for webhook
// Inputs: Merged results from create/update paths
// Output: Comprehensive summary for Zapier

// Format Response - INTELLIGENT VERSION
// Handles both created and updated issues from the merge

// Get all items from the merge node
const mergedItems = $input.all();

// Get original data for context
const parseData = $('Parse Claude Response').first().json;
const promptData = $('Prompt Builder').first().json;
const meeting_title = parseData.meeting_title || promptData.meeting_title || 'Meeting';

// Separate successful operations from errors
const createdIssues = [];
const updatedIssues = [];
const errors = [];

// Process all merged items
mergedItems.forEach(item => {
  const data = item.json;
  
  // Check if this is an error
  if (data.error || !data.id) {
    errors.push({
      operation: data.action || 'unknown',
      title: data.title || data.existingTitle || 'Unknown item',
      identifier: data.identifier || null,
      error: data.message || data.error || 'Operation failed'
    });
  } else if (data.action === 'create') {
    // Successfully created issue
    createdIssues.push({
      id: data.id,
      identifier: data.identifier,
      title: data.title,
      url: data.url || `https://linear.app/team/issue/${data.identifier}`,
      state: data.state?.name || 'Todo',
      priority: data.priority || 3,
      assignee: data.assignee?.displayName || data.assignee?.name || 'Unassigned',
      mentioned_assignee: data.mentionedAssignee || null,
      created_at: data.createdAt || new Date().toISOString()
    });
  } else if (data.action === 'update') {
    // Successfully updated issue
    updatedIssues.push({
      id: data.id,
      identifier: data.identifier,
      title: data.title,
      url: data.url || `https://linear.app/team/issue/${data.identifier}`,
      state: data.state?.name || 'Unknown',
      priority: data.priority || 3,
      assignee: data.assignee?.displayName || data.assignee?.name || 'Unassigned',
      update_confidence: data.confidence ? `${(data.confidence * 100).toFixed(0)}%` : 'N/A',
      matching_reason: data.reasoning || data.matching_reasoning || 'No reason provided',
      updated_at: data.updatedAt || new Date().toISOString()
    });
  }
});

// Build comprehensive response
const response = {
  status: errors.length === 0 ? "success" : "partial_success",
  workflow: "transcript-to-linear-intelligent",
  timestamp: new Date().toISOString(),
  
  meeting: {
    title: meeting_title,
    processed_at: new Date().toISOString()
  },
  
  summary: {
    action_items_found: parseData.summary.total || 0,
    issues_created: createdIssues.length,
    issues_updated: updatedIssues.length,
    issues_failed: errors.length,
    attendees: parseData.summary.attendees || [],
    decisions: parseData.summary.decisions || [],
    follow_ups: parseData.summary.follow_ups || []
  },
  
  created_issues: createdIssues,
  updated_issues: updatedIssues,
  
  operation_details: {
    total_operations: parseData.summary.total || 0,
    creates_attempted: parseData.summary.creating || 0,
    creates_successful: createdIssues.length,
    updates_attempted: parseData.summary.updating || 0,
    updates_successful: updatedIssues.length,
    success_rate: parseData.summary.total > 0 
      ? Math.round(((createdIssues.length + updatedIssues.length) / parseData.summary.total) * 100) + '%' 
      : '0%'
  },
  
  errors: errors,
  
  metadata: {
    workflow_execution_id: $execution?.id || 'unknown',
    intelligent_matching_enabled: true,
    model_used: promptData.model || 'unknown'
  }
};

// Log summary
console.log(`\nOperation Summary:`);
console.log(`Meeting: ${meeting_title}`);
console.log(`Action items found: ${parseData.summary.total}`);
console.log(`Issues created: ${createdIssues.length}/${parseData.summary.creating}`);
console.log(`Issues updated: ${updatedIssues.length}/${parseData.summary.updating}`);
console.log(`Total failures: ${errors.length}`);

// Return the formatted response
return {
  json: response
};