'use strict';
/**
 * Module registry.
 *
 * Every tool in the platform (RFIs, Submittals, Commitments, ...) is described
 * declaratively here. The generic resource engine uses these definitions to
 * build CRUD routes, validation, numbering, OpenAPI docs and integration
 * mappings, and the web client uses the same definitions (via /api/meta) to
 * render lists, forms and detail pages. Adding a new tool is usually just a
 * matter of adding an entry to MODULES.
 *
 * Field types:
 *   text, textarea, number, currency, percent, date, datetime, boolean,
 *   select (options), multiselect (options), user, company, ref (module),
 *   lines (sub-table; `fields` describes the columns)
 */

const GROUPS = {
  core: 'Core Tools',
  project_management: 'Project Management',
  quality_safety: 'Quality & Safety',
  financials: 'Financial Management',
  resource: 'Resource Management',
  preconstruction: 'Preconstruction',
};

const PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];
const TRADES = [
  'General', 'Sitework', 'Concrete', 'Masonry', 'Metals', 'Carpentry', 'Thermal & Moisture',
  'Doors & Windows', 'Finishes', 'Specialties', 'Equipment', 'Furnishings', 'Conveying',
  'Fire Suppression', 'Plumbing', 'HVAC', 'Electrical', 'Communications', 'Earthwork', 'Landscaping',
];
const COST_CATEGORIES = ['Labor', 'Material', 'Equipment', 'Subcontract', 'Other'];

const costLines = (extra = []) => ({
  key: 'line_items',
  label: 'Line Items',
  type: 'lines',
  fields: [
    { key: 'cost_code', label: 'Cost Code', type: 'text' },
    { key: 'description', label: 'Description', type: 'text' },
    ...extra,
    { key: 'amount', label: 'Amount', type: 'currency' },
  ],
});

const MODULES = [
  // ───────────────────────────── Core Tools ─────────────────────────────
  {
    key: 'directory', label: 'Directory', singular: 'Company', group: 'core', scope: 'company',
    prefix: 'CO', titleField: 'name', icon: '🏢',
    statuses: ['Active', 'Inactive'], closedStatuses: ['Inactive'],
    fields: [
      { key: 'name', label: 'Company Name', type: 'text', required: true, list: true },
      { key: 'company_type', label: 'Type', type: 'select', options: ['Subcontractor', 'Supplier', 'Architect', 'Engineer', 'Owner', 'Consultant', 'Inspector', 'General Contractor'], list: true },
      { key: 'trade', label: 'Trade', type: 'select', options: TRADES, list: true },
      { key: 'primary_contact', label: 'Primary Contact', type: 'text', list: true },
      { key: 'email', label: 'Email', type: 'text' },
      { key: 'phone', label: 'Phone', type: 'text', list: true },
      { key: 'address', label: 'Address', type: 'textarea' },
      { key: 'license_number', label: 'License #', type: 'text' },
      { key: 'insurance_expiration', label: 'Insurance Expiration', type: 'date', list: true },
      { key: 'minority_owned', label: 'MBE/WBE/DBE Certified', type: 'boolean' },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
  {
    key: 'tasks', label: 'Tasks', singular: 'Task', group: 'core', prefix: 'TSK', titleField: 'title', icon: '✅',
    statuses: ['Open', 'In Progress', 'Completed', 'Void'], closedStatuses: ['Completed', 'Void'],
    dueField: 'due_date', assigneeFields: ['assignee'],
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true, list: true },
      { key: 'category', label: 'Category', type: 'select', options: ['General', 'Administrative', 'Closeout', 'Contract', 'Design', 'Preconstruction', 'Safety', 'Warranty'], list: true },
      { key: 'assignee', label: 'Assignee', type: 'user', list: true },
      { key: 'due_date', label: 'Due Date', type: 'date', list: true },
      { key: 'priority', label: 'Priority', type: 'select', options: PRIORITIES, list: true },
      { key: 'description', label: 'Description', type: 'textarea' },
    ],
  },
  {
    key: 'documents', label: 'Documents', singular: 'Document', group: 'core', prefix: 'DOC', titleField: 'title', icon: '📁',
    statuses: ['Draft', 'Published', 'Archived'], closedStatuses: ['Archived'], defaultStatus: 'Published',
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true, list: true },
      { key: 'folder', label: 'Folder', type: 'select', options: ['Contracts', 'Permits', 'Reports', 'Closeout', 'Correspondence', 'Estimates', 'Insurance', 'Other'], list: true },
      { key: 'version', label: 'Version', type: 'text', list: true },
      { key: 'private', label: 'Private', type: 'boolean' },
      { key: 'description', label: 'Description', type: 'textarea' },
    ],
  },
  {
    key: 'photos', label: 'Photos', singular: 'Photo', group: 'core', prefix: 'PH', titleField: 'title', icon: '📷',
    statuses: ['Active', 'Archived'], closedStatuses: ['Archived'],
    fields: [
      { key: 'title', label: 'Caption', type: 'text', required: true, list: true },
      { key: 'album', label: 'Album', type: 'select', options: ['Progress', 'Safety', 'Quality', 'Before', 'After', 'Damage', 'Other'], list: true },
      { key: 'location', label: 'Location', type: 'text', list: true },
      { key: 'taken_on', label: 'Taken On', type: 'date', list: true },
      { key: 'description', label: 'Description', type: 'textarea' },
    ],
  },
  {
    key: 'schedule', label: 'Schedule', singular: 'Activity', group: 'core', prefix: 'ACT', titleField: 'name', icon: '📅',
    statuses: ['Not Started', 'In Progress', 'Complete'], closedStatuses: ['Complete'], dueField: 'finish_date',
    fields: [
      { key: 'name', label: 'Activity Name', type: 'text', required: true, list: true },
      { key: 'wbs', label: 'WBS', type: 'text', list: true },
      { key: 'start_date', label: 'Start', type: 'date', required: true, list: true },
      { key: 'finish_date', label: 'Finish', type: 'date', required: true, list: true },
      { key: 'percent_complete', label: '% Complete', type: 'percent', list: true },
      { key: 'milestone', label: 'Milestone', type: 'boolean' },
      { key: 'critical', label: 'Critical Path', type: 'boolean' },
      { key: 'predecessors', label: 'Predecessors (activity #s)', type: 'text' },
      { key: 'responsible_company', label: 'Responsible Company', type: 'company', list: true },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },

  // ───────────────────────── Project Management ─────────────────────────
  {
    key: 'rfis', label: 'RFIs', singular: 'RFI', group: 'project_management', prefix: 'RFI', titleField: 'subject', icon: '❓',
    statuses: ['Draft', 'Open', 'Answered', 'Closed'], closedStatuses: ['Closed'], defaultStatus: 'Open',
    dueField: 'due_date', assigneeFields: ['assignee', 'ball_in_court'],
    fields: [
      { key: 'subject', label: 'Subject', type: 'text', required: true, list: true },
      { key: 'question', label: 'Question', type: 'textarea', required: true },
      { key: 'answer', label: 'Official Answer', type: 'textarea' },
      { key: 'assignee', label: 'Assignee', type: 'user', list: true },
      { key: 'ball_in_court', label: 'Ball in Court', type: 'user', list: true },
      { key: 'responsible_company', label: 'Responsible Contractor', type: 'company' },
      { key: 'due_date', label: 'Due Date', type: 'date', list: true },
      { key: 'priority', label: 'Priority', type: 'select', options: PRIORITIES, list: true },
      { key: 'drawing_number', label: 'Drawing #', type: 'text' },
      { key: 'spec_section', label: 'Spec Section', type: 'text' },
      { key: 'location', label: 'Location', type: 'text' },
      { key: 'cost_impact', label: 'Cost Impact', type: 'select', options: ['Yes', 'No', 'TBD', 'N/A'] },
      { key: 'cost_impact_amount', label: 'Cost Impact Amount', type: 'currency', showIf: { field: 'cost_impact', equals: 'Yes' } },
      { key: 'schedule_impact', label: 'Schedule Impact', type: 'select', options: ['Yes', 'No', 'TBD', 'N/A'] },
      { key: 'schedule_impact_days', label: 'Schedule Impact (days)', type: 'number', showIf: { field: 'schedule_impact', equals: 'Yes' } },
    ],
  },
  {
    key: 'submittals', label: 'Submittals', singular: 'Submittal', group: 'project_management', prefix: 'SUB', titleField: 'title', icon: '📤',
    statuses: ['Draft', 'Open', 'Submitted', 'Revise and Resubmit', 'Approved', 'Approved as Noted', 'Rejected', 'Closed'],
    closedStatuses: ['Approved', 'Approved as Noted', 'Closed'], defaultStatus: 'Open',
    dueField: 'due_date', assigneeFields: ['approver', 'ball_in_court'],
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true, list: true },
      { key: 'spec_section', label: 'Spec Section', type: 'text', list: true },
      { key: 'submittal_type', label: 'Type', type: 'select', options: ['Shop Drawing', 'Product Data', 'Sample', 'Mock-Up', 'O&M Manual', 'Warranty', 'Certificate', 'Test Report', 'Other'], list: true },
      { key: 'revision', label: 'Revision', type: 'number', default: 0 },
      { key: 'responsible_company', label: 'Responsible Contractor', type: 'company', list: true },
      { key: 'approver', label: 'Approver', type: 'user' },
      { key: 'ball_in_court', label: 'Ball in Court', type: 'user', list: true },
      { key: 'received_date', label: 'Received From Sub', type: 'date' },
      { key: 'due_date', label: 'Due Date', type: 'date', list: true },
      { key: 'required_on_site', label: 'Required On-Site', type: 'date' },
      { key: 'lead_time_days', label: 'Lead Time (days)', type: 'number' },
      { key: 'description', label: 'Description', type: 'textarea' },
      {
        key: 'workflow', label: 'Approval Workflow', type: 'lines',
        fields: [
          { key: 'reviewer', label: 'Reviewer', type: 'text' },
          { key: 'role', label: 'Role', type: 'text' },
          { key: 'response', label: 'Response', type: 'select', options: ['Pending', 'Approved', 'Approved as Noted', 'Revise and Resubmit', 'Rejected'] },
          { key: 'returned', label: 'Returned', type: 'date' },
        ],
      },
    ],
  },
  {
    key: 'drawings', label: 'Drawings', singular: 'Drawing', group: 'project_management', prefix: 'DWG', titleField: 'title', icon: '📐',
    statuses: ['Current', 'Superseded', 'Void'], closedStatuses: ['Superseded', 'Void'], defaultStatus: 'Current',
    fields: [
      { key: 'sheet_number', label: 'Sheet #', type: 'text', required: true, list: true },
      { key: 'title', label: 'Title', type: 'text', required: true, list: true },
      { key: 'discipline', label: 'Discipline', type: 'select', options: ['General', 'Civil', 'Landscape', 'Architectural', 'Structural', 'Mechanical', 'Plumbing', 'Electrical', 'Fire Protection', 'Telecom'], list: true },
      { key: 'revision', label: 'Revision', type: 'text', list: true },
      { key: 'drawing_set', label: 'Set', type: 'text', list: true },
      { key: 'drawing_date', label: 'Drawing Date', type: 'date' },
      { key: 'received_date', label: 'Received Date', type: 'date' },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
  {
    key: 'specifications', label: 'Specifications', singular: 'Spec Section', group: 'project_management', prefix: 'SPEC', titleField: 'title', icon: '📘',
    statuses: ['Current', 'Superseded'], closedStatuses: ['Superseded'],
    fields: [
      { key: 'section_number', label: 'Section #', type: 'text', required: true, list: true },
      { key: 'title', label: 'Title', type: 'text', required: true, list: true },
      { key: 'division', label: 'Division', type: 'text', list: true },
      { key: 'revision', label: 'Revision', type: 'text', list: true },
      { key: 'issued_date', label: 'Issued Date', type: 'date' },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
  {
    key: 'daily_logs', label: 'Daily Log', singular: 'Daily Log', group: 'project_management', prefix: 'DL', titleField: 'log_date', icon: '📓',
    statuses: ['Draft', 'Submitted', 'Approved'], closedStatuses: ['Approved'], defaultStatus: 'Draft',
    fields: [
      { key: 'log_date', label: 'Date', type: 'date', required: true, list: true },
      { key: 'weather', label: 'Weather', type: 'select', options: ['Clear', 'Partly Cloudy', 'Overcast', 'Rain', 'Snow', 'Wind', 'Fog', 'Extreme Heat'], list: true },
      { key: 'temperature_high', label: 'High (°F)', type: 'number' },
      { key: 'temperature_low', label: 'Low (°F)', type: 'number' },
      { key: 'weather_delay', label: 'Weather Delay', type: 'boolean', list: true },
      {
        key: 'manpower', label: 'Manpower', type: 'lines',
        fields: [
          { key: 'company', label: 'Company', type: 'text' },
          { key: 'workers', label: 'Workers', type: 'number' },
          { key: 'hours', label: 'Hours Each', type: 'number' },
          { key: 'location', label: 'Location', type: 'text' },
          { key: 'notes', label: 'Notes', type: 'text' },
        ],
      },
      {
        key: 'equipment_log', label: 'Equipment', type: 'lines',
        fields: [
          { key: 'equipment', label: 'Equipment', type: 'text' },
          { key: 'hours_operating', label: 'Hours Operating', type: 'number' },
          { key: 'hours_idle', label: 'Hours Idle', type: 'number' },
        ],
      },
      {
        key: 'deliveries', label: 'Deliveries', type: 'lines',
        fields: [
          { key: 'vendor', label: 'Vendor', type: 'text' },
          { key: 'contents', label: 'Contents', type: 'text' },
          { key: 'time', label: 'Time', type: 'text' },
        ],
      },
      { key: 'visitors', label: 'Visitors', type: 'textarea' },
      { key: 'work_performed', label: 'Work Performed', type: 'textarea' },
      { key: 'delays', label: 'Delays / Issues', type: 'textarea' },
      { key: 'safety_notes', label: 'Safety Notes', type: 'textarea' },
    ],
  },
  {
    key: 'meetings', label: 'Meetings', singular: 'Meeting', group: 'project_management', prefix: 'MTG', titleField: 'title', icon: '👥',
    statuses: ['Scheduled', 'In Progress', 'Minutes Draft', 'Distributed'], closedStatuses: ['Distributed'], defaultStatus: 'Scheduled',
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true, list: true },
      { key: 'meeting_type', label: 'Type', type: 'select', options: ['OAC', 'Subcontractor', 'Safety', 'Preconstruction', 'Coordination', 'Closeout', 'Other'], list: true },
      { key: 'meeting_date', label: 'Date', type: 'datetime', list: true },
      { key: 'location', label: 'Location', type: 'text', list: true },
      { key: 'attendees', label: 'Attendees', type: 'textarea' },
      { key: 'agenda', label: 'Agenda', type: 'textarea' },
      {
        key: 'items', label: 'Meeting Items', type: 'lines',
        fields: [
          { key: 'topic', label: 'Topic', type: 'text' },
          { key: 'discussion', label: 'Discussion', type: 'text' },
          { key: 'owner', label: 'Action By', type: 'text' },
          { key: 'due', label: 'Due', type: 'date' },
          { key: 'status', label: 'Status', type: 'select', options: ['Open', 'Closed'] },
        ],
      },
      { key: 'minutes', label: 'Minutes / Notes', type: 'textarea' },
    ],
  },
  {
    key: 'correspondence', label: 'Correspondence', singular: 'Correspondence', group: 'project_management', prefix: 'COR', titleField: 'subject', icon: '✉️',
    statuses: ['Draft', 'Sent', 'Responded', 'Closed'], closedStatuses: ['Closed', 'Responded'], defaultStatus: 'Draft',
    dueField: 'response_due', assigneeFields: ['assignee'],
    fields: [
      { key: 'subject', label: 'Subject', type: 'text', required: true, list: true },
      { key: 'correspondence_type', label: 'Type', type: 'select', options: ['Letter', 'Notice', 'Memo', 'Notice of Delay', 'Notice to Proceed', 'Backcharge', 'Issue', 'Other'], list: true },
      { key: 'to_company', label: 'To', type: 'company', list: true },
      { key: 'assignee', label: 'Assignee', type: 'user' },
      { key: 'response_due', label: 'Response Due', type: 'date', list: true },
      { key: 'body', label: 'Body', type: 'textarea' },
    ],
  },
  {
    key: 'transmittals', label: 'Transmittals', singular: 'Transmittal', group: 'project_management', prefix: 'TRN', titleField: 'subject', icon: '📨',
    statuses: ['Draft', 'Sent', 'Received', 'Closed'], closedStatuses: ['Received', 'Closed'], defaultStatus: 'Draft',
    dueField: 'due_by',
    fields: [
      { key: 'subject', label: 'Subject', type: 'text', required: true, list: true },
      { key: 'to_company', label: 'To', type: 'company', list: true },
      { key: 'sent_via', label: 'Sent Via', type: 'select', options: ['Email', 'Courier', 'Mail', 'Hand Delivery', 'FTP'], list: true },
      { key: 'purpose', label: 'Purpose', type: 'select', options: ['For Approval', 'For Review', 'For Information', 'For Construction', 'As Requested'] },
      { key: 'due_by', label: 'Response Due', type: 'date', list: true },
      {
        key: 'items', label: 'Items Transmitted', type: 'lines',
        fields: [
          { key: 'copies', label: 'Copies', type: 'number' },
          { key: 'description', label: 'Description', type: 'text' },
        ],
      },
      { key: 'remarks', label: 'Remarks', type: 'textarea' },
    ],
  },
  {
    key: 'action_plans', label: 'Action Plans', singular: 'Action Plan', group: 'project_management', prefix: 'AP', titleField: 'title', icon: '🗺️',
    statuses: ['Draft', 'In Progress', 'Complete'], closedStatuses: ['Complete'], defaultStatus: 'Draft',
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true, list: true },
      { key: 'plan_type', label: 'Type', type: 'select', options: ['Closeout', 'Commissioning', 'Mobilization', 'Pre-Task Plan', 'Quality Plan', 'Turnover', 'Other'], list: true },
      { key: 'owner', label: 'Plan Manager', type: 'user', list: true },
      {
        key: 'steps', label: 'Steps', type: 'lines',
        fields: [
          { key: 'step', label: 'Step', type: 'text' },
          { key: 'assignee', label: 'Assignee', type: 'text' },
          { key: 'due', label: 'Due', type: 'date' },
          { key: 'done', label: 'Done', type: 'boolean' },
        ],
      },
      { key: 'description', label: 'Description', type: 'textarea' },
    ],
  },

  // ─────────────────────────── Quality & Safety ───────────────────────────
  {
    key: 'punch_list', label: 'Punch List', singular: 'Punch Item', group: 'quality_safety', prefix: 'PL', titleField: 'title', icon: '📌',
    statuses: ['Draft', 'Work Required', 'Ready for Review', 'Not Accepted', 'Closed'], closedStatuses: ['Closed'], defaultStatus: 'Work Required',
    dueField: 'due_date', assigneeFields: ['assignee', 'final_approver'],
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true, list: true },
      { key: 'location', label: 'Location', type: 'text', list: true },
      { key: 'trade', label: 'Trade', type: 'select', options: TRADES, list: true },
      { key: 'responsible_company', label: 'Responsible Contractor', type: 'company', list: true },
      { key: 'assignee', label: 'Assignee', type: 'user' },
      { key: 'final_approver', label: 'Final Approver', type: 'user' },
      { key: 'due_date', label: 'Due Date', type: 'date', list: true },
      { key: 'priority', label: 'Priority', type: 'select', options: PRIORITIES, list: true },
      { key: 'cost_impact', label: 'Cost Impact', type: 'currency' },
      { key: 'description', label: 'Description', type: 'textarea' },
    ],
  },
  {
    key: 'inspections', label: 'Inspections', singular: 'Inspection', group: 'quality_safety', prefix: 'INS', titleField: 'title', icon: '🔍',
    statuses: ['Open', 'In Review', 'Closed'], closedStatuses: ['Closed'], defaultStatus: 'Open',
    dueField: 'inspection_date', assigneeFields: ['inspector'],
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true, list: true },
      { key: 'inspection_type', label: 'Type', type: 'select', options: ['Quality', 'Safety', 'Commissioning', 'Environmental', 'Pre-Pour', 'Framing', 'MEP Rough-In', 'Final', 'Third Party'], list: true },
      { key: 'inspection_date', label: 'Date', type: 'date', list: true },
      { key: 'inspector', label: 'Inspector', type: 'user', list: true },
      { key: 'location', label: 'Location', type: 'text', list: true },
      { key: 'trade', label: 'Trade', type: 'select', options: TRADES },
      {
        key: 'checklist', label: 'Checklist', type: 'lines',
        fields: [
          { key: 'item', label: 'Item', type: 'text' },
          { key: 'result', label: 'Result', type: 'select', options: ['Pass', 'Fail', 'N/A'] },
          { key: 'notes', label: 'Notes', type: 'text' },
        ],
      },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
  {
    key: 'observations', label: 'Observations', singular: 'Observation', group: 'quality_safety', prefix: 'OBS', titleField: 'title', icon: '👁️',
    statuses: ['Initiated', 'Ready for Review', 'Not Accepted', 'Closed'], closedStatuses: ['Closed'], defaultStatus: 'Initiated',
    dueField: 'due_date', assigneeFields: ['assignee'],
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true, list: true },
      { key: 'observation_type', label: 'Type', type: 'select', options: ['Safety', 'Quality', 'Environmental', 'Commissioning', 'Warranty', 'Work to Complete'], list: true },
      { key: 'hazard', label: 'Hazard', type: 'select', options: ['Fall', 'Electrical', 'Struck By', 'Caught In/Between', 'Housekeeping', 'PPE', 'Fire', 'Chemical', 'Other'] },
      { key: 'contributing_behavior', label: 'Contributing Behavior', type: 'select', options: ['Inattention', 'Rushing', 'Complacency', 'Lack of Training', 'Improper Tool Use', 'None'] },
      { key: 'priority', label: 'Priority', type: 'select', options: PRIORITIES, list: true },
      { key: 'location', label: 'Location', type: 'text', list: true },
      { key: 'responsible_company', label: 'Responsible Contractor', type: 'company' },
      { key: 'assignee', label: 'Assignee', type: 'user', list: true },
      { key: 'due_date', label: 'Due Date', type: 'date', list: true },
      { key: 'description', label: 'Description', type: 'textarea' },
    ],
  },
  {
    key: 'incidents', label: 'Incidents', singular: 'Incident', group: 'quality_safety', prefix: 'INC', titleField: 'title', icon: '🚑',
    statuses: ['Open', 'Under Investigation', 'Closed'], closedStatuses: ['Closed'], defaultStatus: 'Open',
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true, list: true },
      { key: 'occurred_at', label: 'Occurred At', type: 'datetime', required: true, list: true },
      { key: 'incident_type', label: 'Type', type: 'select', options: ['Injury/Illness', 'Near Miss', 'Property Damage', 'Environmental', 'Vehicle', 'Theft', 'Other'], list: true },
      { key: 'severity', label: 'Severity', type: 'select', options: ['First Aid', 'Medical Treatment', 'Restricted Duty', 'Lost Time', 'Fatality', 'None'], list: true },
      { key: 'osha_recordable', label: 'OSHA Recordable', type: 'boolean', list: true },
      { key: 'days_away', label: 'Days Away From Work', type: 'number' },
      { key: 'location', label: 'Location', type: 'text' },
      { key: 'involved_company', label: 'Involved Company', type: 'company' },
      { key: 'description', label: 'Description', type: 'textarea', required: true },
      { key: 'witnesses', label: 'Witnesses', type: 'textarea' },
      { key: 'root_cause', label: 'Root Cause', type: 'textarea' },
      { key: 'corrective_action', label: 'Corrective Action', type: 'textarea' },
    ],
  },

  // ─────────────────────────────── Financials ───────────────────────────────
  {
    key: 'budget', label: 'Budget', singular: 'Budget Line', group: 'financials', prefix: 'BL', titleField: 'description', icon: '💰',
    statuses: ['Active', 'Locked'], closedStatuses: [],
    fields: [
      { key: 'cost_code', label: 'Cost Code', type: 'text', required: true, list: true },
      { key: 'description', label: 'Description', type: 'text', required: true, list: true },
      { key: 'category', label: 'Cost Type', type: 'select', options: COST_CATEGORIES, list: true },
      { key: 'original_budget', label: 'Original Budget', type: 'currency', required: true, list: true },
      { key: 'budget_modifications', label: 'Budget Modifications', type: 'currency' },
      { key: 'forecast_to_complete', label: 'Forecast to Complete (override)', type: 'currency' },
    ],
  },
  {
    key: 'prime_contracts', label: 'Prime Contracts', singular: 'Prime Contract', group: 'financials', prefix: 'PC', titleField: 'title', icon: '📜',
    statuses: ['Draft', 'Out for Signature', 'Approved', 'Complete', 'Terminated'], closedStatuses: ['Complete', 'Terminated'], defaultStatus: 'Draft',
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true, list: true },
      { key: 'owner_company', label: 'Owner / Client', type: 'company', list: true },
      { key: 'contract_type', label: 'Contract Type', type: 'select', options: ['Lump Sum', 'GMP', 'Cost Plus', 'Unit Price', 'Design-Build', 'T&M'], list: true },
      { key: 'executed_date', label: 'Executed Date', type: 'date' },
      { key: 'substantial_completion', label: 'Substantial Completion', type: 'date' },
      { key: 'retainage_percent', label: 'Default Retainage %', type: 'percent', default: 10 },
      costLines(),
      { key: 'inclusions', label: 'Inclusions', type: 'textarea' },
      { key: 'exclusions', label: 'Exclusions', type: 'textarea' },
    ],
  },
  {
    key: 'commitments', label: 'Commitments', singular: 'Commitment', group: 'financials', prefix: 'SC', titleField: 'title', icon: '🤝',
    statuses: ['Draft', 'Out for Bid', 'Out for Signature', 'Approved', 'Complete', 'Terminated'], closedStatuses: ['Complete', 'Terminated'], defaultStatus: 'Draft',
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true, list: true },
      { key: 'commitment_type', label: 'Type', type: 'select', options: ['Subcontract', 'Purchase Order'], required: true, list: true },
      { key: 'vendor', label: 'Contract Company', type: 'company', required: true, list: true },
      { key: 'executed_date', label: 'Executed Date', type: 'date' },
      { key: 'retainage_percent', label: 'Default Retainage %', type: 'percent', default: 10 },
      { key: 'insurance_required', label: 'Insurance Required', type: 'boolean', default: true },
      costLines(),
      { key: 'scope', label: 'Scope of Work', type: 'textarea' },
    ],
  },
  {
    key: 'change_events', label: 'Change Events', singular: 'Change Event', group: 'financials', prefix: 'CE', titleField: 'title', icon: '⚡',
    statuses: ['Open', 'Pending', 'Closed', 'Void'], closedStatuses: ['Closed', 'Void'], defaultStatus: 'Open',
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true, list: true },
      { key: 'change_reason', label: 'Reason', type: 'select', options: ['Owner Change', 'Design Development', 'Unforeseen Condition', 'Allowance', 'Client Request', 'Existing Condition', 'Backcharge'], list: true },
      { key: 'scope', label: 'Scope', type: 'select', options: ['In Scope', 'Out of Scope', 'TBD'], list: true },
      { key: 'origin_rfi', label: 'Origin RFI', type: 'ref', module: 'rfis' },
      costLines(),
      { key: 'description', label: 'Description', type: 'textarea' },
    ],
  },
  {
    key: 'change_orders', label: 'Change Orders', singular: 'Change Order', group: 'financials', prefix: 'CO', titleField: 'title', icon: '🔁',
    statuses: ['Draft', 'Pending', 'Approved', 'Rejected', 'Void'], closedStatuses: ['Approved', 'Rejected', 'Void'], defaultStatus: 'Draft',
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true, list: true },
      { key: 'contract_kind', label: 'Contract', type: 'select', options: ['Prime Contract', 'Commitment'], required: true, list: true },
      { key: 'prime_contract', label: 'Prime Contract', type: 'ref', module: 'prime_contracts', showIf: { field: 'contract_kind', equals: 'Prime Contract' } },
      { key: 'commitment', label: 'Commitment', type: 'ref', module: 'commitments', showIf: { field: 'contract_kind', equals: 'Commitment' } },
      { key: 'change_event', label: 'Change Event', type: 'ref', module: 'change_events' },
      { key: 'schedule_impact_days', label: 'Schedule Impact (days)', type: 'number' },
      { key: 'due_date', label: 'Due Date', type: 'date' },
      costLines(),
      { key: 'description', label: 'Description', type: 'textarea' },
    ],
  },
  {
    key: 'invoices', label: 'Invoicing', singular: 'Payment Application', group: 'financials', prefix: 'PAY', titleField: 'title', icon: '🧾',
    statuses: ['Draft', 'Under Review', 'Revise and Resubmit', 'Approved', 'Paid'], closedStatuses: ['Paid'], defaultStatus: 'Draft',
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true, list: true },
      { key: 'contract_kind', label: 'Contract', type: 'select', options: ['Prime Contract', 'Commitment'], required: true, list: true },
      { key: 'prime_contract', label: 'Prime Contract', type: 'ref', module: 'prime_contracts', showIf: { field: 'contract_kind', equals: 'Prime Contract' } },
      { key: 'commitment', label: 'Commitment', type: 'ref', module: 'commitments', showIf: { field: 'contract_kind', equals: 'Commitment' } },
      { key: 'period_start', label: 'Period Start', type: 'date', list: true },
      { key: 'period_end', label: 'Period End', type: 'date', list: true },
      { key: 'retainage_percent', label: 'Retainage %', type: 'percent', default: 10 },
      costLines([{ key: 'percent_complete', label: '% Complete', type: 'percent' }]),
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
  {
    key: 'direct_costs', label: 'Direct Costs', singular: 'Direct Cost', group: 'financials', prefix: 'DC', titleField: 'description', icon: '💵',
    statuses: ['Draft', 'Pending', 'Approved', 'Revise and Resubmit'], closedStatuses: ['Approved'], defaultStatus: 'Pending',
    fields: [
      { key: 'description', label: 'Description', type: 'text', required: true, list: true },
      { key: 'cost_type', label: 'Type', type: 'select', options: ['Invoice', 'Expense', 'Payroll', 'Subcontractor Invoice'], list: true },
      { key: 'vendor', label: 'Vendor', type: 'company', list: true },
      { key: 'cost_code', label: 'Cost Code', type: 'text', required: true, list: true },
      { key: 'cost_date', label: 'Date', type: 'date', list: true },
      { key: 'invoice_number', label: 'Invoice #', type: 'text' },
      { key: 'amount', label: 'Amount', type: 'currency', required: true, list: true },
    ],
  },

  // ───────────────────────────── Preconstruction ─────────────────────────────
  {
    key: 'bid_packages', label: 'Bidding', singular: 'Bid Package', group: 'preconstruction', prefix: 'BID', titleField: 'title', icon: '🏷️',
    statuses: ['Draft', 'Open for Bidding', 'Leveling', 'Awarded', 'Closed'], closedStatuses: ['Awarded', 'Closed'], defaultStatus: 'Draft',
    dueField: 'bid_due',
    fields: [
      { key: 'title', label: 'Package Title', type: 'text', required: true, list: true },
      { key: 'trade', label: 'Trade', type: 'select', options: TRADES, list: true },
      { key: 'bid_due', label: 'Bids Due', type: 'datetime', list: true },
      { key: 'pre_bid_walk', label: 'Pre-Bid Walk', type: 'datetime' },
      { key: 'estimate', label: 'Internal Estimate', type: 'currency', list: true },
      {
        key: 'bidders', label: 'Bidders', type: 'lines',
        fields: [
          { key: 'company', label: 'Company', type: 'text' },
          { key: 'status', label: 'Status', type: 'select', options: ['Invited', 'Will Bid', 'Declined', 'Submitted', 'Awarded'] },
          { key: 'amount', label: 'Bid Amount', type: 'currency' },
          { key: 'notes', label: 'Notes', type: 'text' },
        ],
      },
      { key: 'scope', label: 'Scope / Instructions', type: 'textarea' },
    ],
  },
  {
    key: 'estimates', label: 'Estimating', singular: 'Estimate', group: 'preconstruction', prefix: 'EST', titleField: 'title', icon: '🧮',
    statuses: ['Draft', 'In Review', 'Final'], closedStatuses: ['Final'], defaultStatus: 'Draft',
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true, list: true },
      { key: 'estimate_type', label: 'Stage', type: 'select', options: ['Conceptual', 'Schematic', 'Design Development', 'Construction Documents', 'GMP'], list: true },
      { key: 'markup_percent', label: 'Markup %', type: 'percent', default: 8 },
      costLines([
        { key: 'quantity', label: 'Qty', type: 'number' },
        { key: 'unit', label: 'Unit', type: 'text' },
        { key: 'unit_cost', label: 'Unit Cost', type: 'currency' },
      ]),
      { key: 'assumptions', label: 'Assumptions', type: 'textarea' },
    ],
  },

  // ─────────────────────────── Resource Management ───────────────────────────
  {
    key: 'timesheets', label: 'Timesheets', singular: 'Time Entry', group: 'resource', prefix: 'TS', titleField: 'worker', icon: '⏱️',
    statuses: ['Pending', 'Approved', 'Rejected', 'Exported'], closedStatuses: ['Approved', 'Exported'], defaultStatus: 'Pending',
    fields: [
      { key: 'worker', label: 'Worker', type: 'text', required: true, list: true },
      { key: 'work_date', label: 'Date', type: 'date', required: true, list: true },
      { key: 'cost_code', label: 'Cost Code', type: 'text', list: true },
      { key: 'classification', label: 'Classification', type: 'select', options: ['Laborer', 'Carpenter', 'Operator', 'Foreman', 'Superintendent', 'Electrician', 'Plumber', 'Ironworker', 'Other'], list: true },
      { key: 'regular_hours', label: 'Regular Hours', type: 'number', required: true, list: true },
      { key: 'overtime_hours', label: 'Overtime Hours', type: 'number', list: true },
      { key: 'hourly_rate', label: 'Hourly Rate', type: 'currency' },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
  {
    key: 'equipment', label: 'Equipment', singular: 'Equipment', group: 'resource', scope: 'company', prefix: 'EQ', titleField: 'name', icon: '🚜',
    statuses: ['Available', 'On Site', 'In Maintenance', 'Retired'], closedStatuses: ['Retired'], defaultStatus: 'Available',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true, list: true },
      { key: 'equipment_type', label: 'Type', type: 'select', options: ['Excavator', 'Loader', 'Crane', 'Lift', 'Truck', 'Generator', 'Compressor', 'Tool', 'Other'], list: true },
      { key: 'serial_number', label: 'Serial #', type: 'text', list: true },
      { key: 'ownership', label: 'Ownership', type: 'select', options: ['Owned', 'Rented', 'Leased'], list: true },
      { key: 'hourly_rate', label: 'Hourly Rate', type: 'currency', list: true },
      { key: 'current_location', label: 'Current Location', type: 'text', list: true },
      { key: 'next_service', label: 'Next Service', type: 'date' },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
];

// Normalise definitions: add status field, defaults, and index by key.
const byKey = {};
for (const m of MODULES) {
  m.scope = m.scope || 'project';
  m.defaultStatus = m.defaultStatus || m.statuses[0];
  m.closedStatuses = m.closedStatuses || [];
  m.assigneeFields = m.assigneeFields || [];
  if (!m.fields.find((f) => f.key === 'status')) {
    m.fields.push({ key: 'status', label: 'Status', type: 'select', options: m.statuses, list: true, default: m.defaultStatus });
  }
  byKey[m.key] = m;
}

function getModule(key) {
  return byKey[key] || null;
}

module.exports = { MODULES, GROUPS, getModule, TRADES, COST_CATEGORIES };
