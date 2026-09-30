'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { hashPassword } = require('./auth');

const d = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const dt = (offset, hour = 9) => `${d(offset)}T${String(hour).padStart(2, '0')}:00`;

const DEMO_PASSWORD = 'keystone123';

/** Populate an empty database with a realistic demo company. Idempotent: does nothing if users exist. */
function seed({ db, records }) {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return false;
  const users = {};
  const addUser = (key, email, name, title, role) => {
    const info = db.prepare('INSERT INTO users (email, name, title, role, password_hash) VALUES (?, ?, ?, ?, ?)').run(email, name, title, role, hashPassword(DEMO_PASSWORD));
    users[key] = Number(info.lastInsertRowid);
  };
  addUser('admin', 'admin@keystone.test', 'Alex Rivera', 'Operations Director', 'admin');
  addUser('pm', 'pm@keystone.test', 'Jordan Blake', 'Senior Project Manager', 'manager');
  addUser('super', 'super@keystone.test', 'Sam Okafor', 'Superintendent', 'superintendent');
  addUser('pe', 'engineer@keystone.test', 'Priya Natarajan', 'Project Engineer', 'manager');
  addUser('sub', 'sub@keystone.test', 'Chris Delgado', 'Foreman – Bayside Electric', 'subcontractor');
  addUser('owner', 'owner@keystone.test', 'Morgan Lee', "Owner's Rep", 'viewer');

  const sys = { user_id: users.admin, name: 'Alex Rivera', source: 'seed' };
  const co = {};
  const addCo = (key, data) => { co[key] = records.create('directory', null, data, sys).id; };
  addCo('owner', { name: 'Harborview Development LLC', company_type: 'Owner', primary_contact: 'Morgan Lee', email: 'mlee@harborview.dev', phone: '(415) 555-0100' });
  addCo('arch', { name: 'Studio Meridian Architects', company_type: 'Architect', primary_contact: 'Dana Kim', email: 'dkim@studiomeridian.com', phone: '(415) 555-0111' });
  addCo('struct', { name: 'Keel Structural Engineers', company_type: 'Engineer', trade: 'Metals', email: 'info@keelse.com' });
  addCo('elec', { name: 'Bayside Electric Inc.', company_type: 'Subcontractor', trade: 'Electrical', primary_contact: 'Chris Delgado', email: 'ar@baysideelectric.com', phone: '(415) 555-0133', insurance_expiration: d(21), license_number: 'C10-889231' });
  addCo('conc', { name: 'Summit Concrete Co.', company_type: 'Subcontractor', trade: 'Concrete', primary_contact: 'Ray Summers', email: 'billing@summitconcrete.com', phone: '(510) 555-0102', insurance_expiration: d(180), minority_owned: true });
  addCo('mech', { name: 'Coastal Mechanical', company_type: 'Subcontractor', trade: 'HVAC', primary_contact: 'Lena Park', email: 'lpark@coastalmech.com', phone: '(650) 555-0144', insurance_expiration: d(-5) });
  addCo('steel', { name: 'Pacific Steel Erectors', company_type: 'Subcontractor', trade: 'Metals', email: 'ap@pacsteel.com', phone: '(510) 555-0199', insurance_expiration: d(300) });
  addCo('plumb', { name: 'Golden Gate Plumbing', company_type: 'Subcontractor', trade: 'Plumbing', email: 'office@ggplumbing.com', insurance_expiration: d(90) });
  addCo('supply', { name: 'Bay Area Building Supply', company_type: 'Supplier', trade: 'General', email: 'orders@babs.com' });
  db.prepare('UPDATE users SET company_id = ? WHERE id = ?').run(co.elec, users.sub);

  for (const [name, type, serial, rate, status] of [
    ['CAT 320 Excavator', 'Excavator', 'CAT0320K8821', 185, 'On Site'],
    ['JLG 600S Boom Lift', 'Lift', 'JLG600-44120', 65, 'On Site'],
    ['Genie GS-3246 Scissor Lift', 'Lift', 'GS3246-99812', 35, 'Available'],
    ['Liebherr 172 EC-B Tower Crane', 'Crane', 'LH172-2231', 420, 'On Site'],
    ['Ford F-350 Crew Truck', 'Truck', '1FT8W3BT5NEC11', 25, 'In Maintenance'],
  ]) records.create('equipment', null, { name, equipment_type: type, serial_number: serial, hourly_rate: rate, ownership: rate > 300 ? 'Rented' : 'Owned', current_location: status === 'On Site' ? 'Harborview Medical Office' : 'Yard' , status, next_service: d(30) }, sys);

  const project = (data, members) => {
    const info = db.prepare(`INSERT INTO projects (number, name, stage, address, city, state, zip, start_date, completion_date, contract_value, project_type, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(data.number, data.name, data.stage, data.address, data.city, data.state, data.zip, data.start_date, data.completion_date, data.contract_value, data.project_type, data.description);
    const id = Number(info.lastInsertRowid);
    for (const m of members) db.prepare('INSERT INTO project_members (project_id, user_id) VALUES (?, ?)').run(id, users[m]);
    return id;
  };

  const p1 = project({
    number: '2026-014', name: 'Harborview Medical Office Building', stage: 'Course of Construction', address: '1200 Harbor Blvd', city: 'San Francisco', state: 'CA', zip: '94107',
    start_date: d(-180), completion_date: d(240), contract_value: 18450000, project_type: 'Healthcare',
    description: '4-story, 62,000 SF medical office building with podium parking, steel frame over post-tensioned concrete.',
  }, ['admin', 'pm', 'super', 'pe', 'sub', 'owner']);
  const p2 = project({
    number: '2026-021', name: 'Mission Bay Lofts – Tenant Improvements', stage: 'Pre-Construction', address: '455 Channel St', city: 'San Francisco', state: 'CA', zip: '94158',
    start_date: d(30), completion_date: d(150), contract_value: 2350000, project_type: 'Commercial Interiors',
    description: 'Level 2 & 3 office TI: demising walls, new MEP distribution, finishes.',
  }, ['admin', 'pm', 'pe']);
  const p3 = project({
    number: '2025-088', name: 'Oakland Unified – Science Wing Modernization', stage: 'Closeout', address: '3900 MacArthur Blvd', city: 'Oakland', state: 'CA', zip: '94619',
    start_date: d(-420), completion_date: d(-10), contract_value: 6725000, project_type: 'Education',
    description: 'Seismic retrofit and modernization of existing science wing, DSA-approved.',
  }, ['admin', 'pm', 'super']);

  const P = (pid) => (mod, data, by = sys) => records.create(mod, pid, data, by);
  const c1 = P(p1);

  // Budget
  const budget = [
    ['01-100', 'General Conditions', 'Labor', 1150000], ['02-200', 'Earthwork & Shoring', 'Subcontract', 865000],
    ['03-300', 'Cast-in-Place Concrete', 'Subcontract', 2410000], ['05-100', 'Structural Steel', 'Subcontract', 2980000],
    ['07-200', 'Roofing & Waterproofing', 'Subcontract', 640000], ['08-400', 'Curtain Wall & Glazing', 'Subcontract', 1720000],
    ['09-200', 'Drywall & Framing', 'Subcontract', 1285000], ['22-000', 'Plumbing', 'Subcontract', 1190000],
    ['23-000', 'HVAC', 'Subcontract', 2240000], ['26-000', 'Electrical', 'Subcontract', 2060000], ['01-900', 'Contingency', 'Other', 450000],
  ];
  for (const [code, desc, cat, amt] of budget) c1('budget', { cost_code: code, description: desc, category: cat, original_budget: amt });

  const pc = c1('prime_contracts', {
    title: 'Harborview MOB – Prime Contract', owner_company: co.owner, contract_type: 'GMP', executed_date: d(-190), substantial_completion: d(230), retainage_percent: 5, status: 'Approved',
    line_items: budget.map(([code, desc, , amt]) => ({ cost_code: code, description: desc, amount: Math.round(amt * 1.045) })),
    inclusions: 'Per GMP exhibit B.', exclusions: 'Hazardous material abatement; utility company fees.',
  });

  const sc = (title, vendor, code, amount, status = 'Approved', type = 'Subcontract') => c1('commitments', {
    title, commitment_type: type, vendor, executed_date: d(-150), retainage_percent: 10, status,
    line_items: [{ cost_code: code, description: title, amount: Math.round(amount * 0.8) }, { cost_code: code, description: `${title} – Phase 2`, amount: Math.round(amount * 0.2) }],
    scope: `Furnish and install complete ${title.toLowerCase()} per contract documents.`,
  });
  const scConc = sc('Cast-in-Place Concrete', co.conc, '03-300', 2295000);
  const scSteel = sc('Structural Steel Fabrication & Erection', co.steel, '05-100', 2910000);
  const scElec = sc('Electrical Systems', co.elec, '26-000', 1985000);
  sc('HVAC Systems', co.mech, '23-000', 2185000, 'Out for Signature');
  sc('Plumbing Systems', co.plumb, '22-000', 1150000, 'Draft');
  sc('Rebar & Embeds Supply', co.supply, '03-300', 98000, 'Approved', 'Purchase Order');

  const rfi1 = c1('rfis', { subject: 'Conflict between duct main and W18 beam at grid C/4', question: 'The 36x20 supply duct on M-301 conflicts with the W18x35 beam at grid C/4, Level 3. Please advise on routing or beam penetration.', assignee: users.pe, ball_in_court: users.pe, responsible_company: co.arch, due_date: d(-3), priority: 'High', drawing_number: 'M-301', spec_section: '23 31 13', location: 'Level 3, Grid C/4', cost_impact: 'TBD', schedule_impact: 'Yes', schedule_impact_days: 3 });
  c1('rfis', { subject: 'Curtain wall anchor spacing at slab edge', question: 'Confirm anchor spacing at slab edge on levels 2-4 given revised slab edge detail 5/S-501.', assignee: users.pm, ball_in_court: users.pm, responsible_company: co.struct, due_date: d(5), priority: 'Medium', drawing_number: 'A-501', spec_section: '08 44 13', cost_impact: 'No', schedule_impact: 'No' });
  c1('rfis', { subject: 'Electrical room door hardware set', question: 'Hardware set HW-12 lists a lever with no lock; electrical room requires locking per code. Please confirm.', answer: 'Provide storeroom function lockset (ANSI F07). No cost change.', assignee: users.pe, ball_in_court: users.super, responsible_company: co.arch, due_date: d(-10), priority: 'Low', status: 'Answered', cost_impact: 'No', schedule_impact: 'No' }, { user_id: users.sub, name: 'Chris Delgado', source: 'seed' });
  c1('rfis', { subject: 'Slab depression at MRI suite', question: 'Confirm depression depth for MRI shielding at Level 1 suite 110.', answer: '4" depression per vendor drawing rev C.', due_date: d(-40), status: 'Closed', cost_impact: 'Yes', cost_impact_amount: 18500, schedule_impact: 'No' });

  c1('submittals', { title: 'Structural steel shop drawings – Levels 2-4', spec_section: '05 12 00', submittal_type: 'Shop Drawing', responsible_company: co.steel, approver: users.pe, ball_in_court: users.pe, received_date: d(-12), due_date: d(-2), required_on_site: d(20), lead_time_days: 45, status: 'Submitted', workflow: [{ reviewer: 'Priya Natarajan', role: 'GC Review', response: 'Approved', returned: d(-8) }, { reviewer: 'Keel Structural', role: 'EOR', response: 'Pending' }] });
  c1('submittals', { title: 'Switchgear product data', spec_section: '26 24 13', submittal_type: 'Product Data', responsible_company: co.elec, approver: users.pe, ball_in_court: users.sub, due_date: d(10), lead_time_days: 120, required_on_site: d(95), status: 'Revise and Resubmit', revision: 1 });
  c1('submittals', { title: 'Concrete mix designs', spec_section: '03 30 00', submittal_type: 'Product Data', responsible_company: co.conc, approver: users.pe, due_date: d(-60), status: 'Approved' });
  c1('submittals', { title: 'Rooftop unit RTU-1 through RTU-4', spec_section: '23 74 13', submittal_type: 'Product Data', responsible_company: co.mech, approver: users.pe, ball_in_court: users.pe, due_date: d(14), lead_time_days: 84, status: 'Open' });
  c1('submittals', { title: 'Curtain wall mock-up', spec_section: '08 44 13', submittal_type: 'Mock-Up', due_date: d(25), status: 'Draft' });

  for (let i = 0; i < 6; i++) {
    c1('daily_logs', {
      log_date: d(-i), weather: ['Clear', 'Partly Cloudy', 'Overcast', 'Rain', 'Clear', 'Wind'][i], temperature_high: 68 - i, temperature_low: 52 - i, weather_delay: i === 3,
      manpower: [{ company: 'Summit Concrete Co.', workers: 14 - i, hours: 8, location: 'Level 3 deck' }, { company: 'Pacific Steel Erectors', workers: 9, hours: 8, location: 'Level 4' }, { company: 'Bayside Electric Inc.', workers: 6 + (i % 2), hours: 8, location: 'Levels 1-2' }],
      equipment_log: [{ equipment: 'Tower Crane', hours_operating: 7, hours_idle: 1 }, { equipment: 'Boom Lift', hours_operating: 5, hours_idle: 3 }],
      deliveries: i === 1 ? [{ vendor: 'Bay Area Building Supply', contents: 'Rebar #5, #6 – 12 tons', time: '07:30' }] : [],
      work_performed: 'Placed Level 3 deck pour sequence 2; continued steel erection L4; electrical rough-in L1/L2.',
      delays: i === 3 ? 'Rain delay 2 hrs AM – pour postponed.' : '',
      status: i === 0 ? 'Draft' : 'Approved',
    }, { user_id: users.super, name: 'Sam Okafor', source: 'seed' });
  }

  const punch = [['Touch-up paint at corridor 204', 'Level 2 – Corridor 204', 'Finishes', co.mech, 'Work Required', 5], ['Missing cover plate at J-box', 'Level 1 – Electrical Rm 105', 'Electrical', co.elec, 'Ready for Review', -1], ['Ceiling tile damaged', 'Level 2 – Suite 210', 'Finishes', co.mech, 'Work Required', -4], ['Firestop at penetrations', 'Level 3 – Shaft S2', 'Thermal & Moisture', co.plumb, 'Closed', -12]];
  for (const [title, loc, trade, company, status, due] of punch) c1('punch_list', { title, location: loc, trade, responsible_company: company, assignee: company === co.elec ? users.sub : users.super, final_approver: users.super, due_date: d(due), priority: 'Medium', status });

  c1('inspections', { title: 'Pre-pour inspection – Level 3 deck seq 2', inspection_type: 'Pre-Pour', inspection_date: d(-1), inspector: users.super, location: 'Level 3', trade: 'Concrete', status: 'Closed', checklist: [{ item: 'Rebar size & spacing per S-301', result: 'Pass' }, { item: 'Chairs & clearances', result: 'Pass' }, { item: 'Embeds & sleeves located', result: 'Fail', notes: 'Sleeve at grid D/5 missing – corrected' }, { item: 'Forms clean & oiled', result: 'Pass' }] });
  c1('inspections', { title: 'Weekly site safety walk', inspection_type: 'Safety', inspection_date: d(2), inspector: users.super, location: 'Site-wide', status: 'Open', checklist: [{ item: 'Fall protection at open edges' }, { item: 'Housekeeping & access' }, { item: 'Fire extinguishers inspected' }, { item: 'PPE compliance' }] });
  c1('observations', { title: 'Missing guardrail at L4 east edge', observation_type: 'Safety', hazard: 'Fall', priority: 'Urgent', location: 'Level 4 East', responsible_company: co.steel, assignee: users.super, due_date: d(-1), description: 'Top rail removed for steel delivery and not replaced.' });
  c1('observations', { title: 'Honeycombing at column C-7', observation_type: 'Quality', priority: 'High', location: 'Level 2', responsible_company: co.conc, assignee: users.pe, due_date: d(6), status: 'Ready for Review' });
  c1('incidents', { title: 'Laceration – hand, rebar cutting', occurred_at: dt(-18, 10), incident_type: 'Injury/Illness', severity: 'Medical Treatment', osha_recordable: true, days_away: 0, location: 'Laydown yard', involved_company: co.conc, description: 'Worker sustained laceration to left hand while cutting rebar; 4 stitches.', corrective_action: 'Cut-resistant gloves required for all rebar cutting; toolbox talk held.', status: 'Closed' });
  c1('incidents', { title: 'Near miss – dropped bolt bag from L4', occurred_at: dt(-4, 14), incident_type: 'Near Miss', severity: 'None', osha_recordable: false, location: 'Level 4 / Grid B', involved_company: co.steel, description: 'Bolt bag fell from L4 into controlled access zone. No injuries.', status: 'Under Investigation' });

  const ce = c1('change_events', { title: 'Duct reroute at grid C/4', change_reason: 'Design Development', scope: 'Out of Scope', origin_rfi: rfi1.id, line_items: [{ cost_code: '23-000', description: 'Reroute duct & add fittings', amount: 24500 }, { cost_code: '05-100', description: 'Beam web penetration & reinforcement', amount: 8800 }] });
  c1('change_orders', { title: 'PCO-001 Owner-requested MRI suite upgrades', contract_kind: 'Prime Contract', prime_contract: pc.id, status: 'Approved', schedule_impact_days: 5, line_items: [{ cost_code: '26-000', description: 'MRI suite power upgrades', amount: 64000 }, { cost_code: '09-200', description: 'RF shielding framing', amount: 41000 }] });
  c1('change_orders', { title: 'PCO-002 Duct reroute at C/4', contract_kind: 'Prime Contract', prime_contract: pc.id, change_event: ce.id, status: 'Pending', line_items: [{ cost_code: '23-000', description: 'Reroute duct', amount: 26950 }, { cost_code: '05-100', description: 'Beam penetration', amount: 9680 }] });
  c1('change_orders', { title: 'SCCO-001 MRI suite electrical', contract_kind: 'Commitment', commitment: scElec.id, status: 'Approved', line_items: [{ cost_code: '26-000', description: 'MRI suite power upgrades', amount: 58500 }] });
  c1('change_orders', { title: 'SCCO-002 Additional embeds', contract_kind: 'Commitment', commitment: scConc.id, status: 'Pending', line_items: [{ cost_code: '03-300', description: 'Additional embed plates L3', amount: 12400 }] });

  c1('invoices', { title: 'Pay App #5 – Owner', contract_kind: 'Prime Contract', prime_contract: pc.id, period_start: d(-60), period_end: d(-31), retainage_percent: 5, status: 'Paid', line_items: [{ cost_code: '03-300', description: 'Concrete', amount: 612000 }, { cost_code: '05-100', description: 'Steel', amount: 488000 }, { cost_code: '01-100', description: 'General Conditions', amount: 96000 }] });
  c1('invoices', { title: 'Pay App #6 – Owner', contract_kind: 'Prime Contract', prime_contract: pc.id, period_start: d(-30), period_end: d(-1), retainage_percent: 5, status: 'Under Review', line_items: [{ cost_code: '03-300', description: 'Concrete', amount: 540000 }, { cost_code: '05-100', description: 'Steel', amount: 702000 }, { cost_code: '26-000', description: 'Electrical', amount: 215000 }] });
  c1('invoices', { title: 'Summit Concrete – Invoice #1142', contract_kind: 'Commitment', commitment: scConc.id, period_start: d(-30), period_end: d(-1), status: 'Approved', line_items: [{ cost_code: '03-300', description: 'Cast-in-Place Concrete', amount: 498000, percent_complete: 55 }] });
  c1('invoices', { title: 'Pacific Steel – Pay Request 4', contract_kind: 'Commitment', commitment: scSteel.id, period_start: d(-30), period_end: d(-1), status: 'Under Review', line_items: [{ cost_code: '05-100', description: 'Structural Steel', amount: 655000, percent_complete: 48 }] });

  c1('direct_costs', { description: 'Site trailer rental – monthly', cost_type: 'Invoice', vendor: co.supply, cost_code: '01-100', cost_date: d(-15), invoice_number: 'BABS-88213', amount: 3850, status: 'Approved' });
  c1('direct_costs', { description: 'Temporary power & fuel', cost_type: 'Expense', cost_code: '01-100', cost_date: d(-9), amount: 12640, status: 'Approved' });
  c1('direct_costs', { description: 'Field labor – week 32', cost_type: 'Payroll', cost_code: '01-100', cost_date: d(-7), amount: 28400, status: 'Pending' });

  const sched = [
    ['Mobilization & Site Prep', '1.1', -180, -165, 100], ['Excavation & Shoring', '1.2', -165, -120, 100], ['Foundations', '1.3', -125, -85, 100],
    ['Podium Concrete L1-L2', '2.1', -90, -30, 100], ['Structural Steel Erection L3-Roof', '2.2', -40, 25, 65], ['Metal Deck & Slab on Deck', '2.3', -20, 40, 35],
    ['Roofing', '3.1', 35, 65, 0], ['Curtain Wall Installation', '3.2', 30, 110, 0], ['MEP Rough-In', '4.1', -30, 90, 20],
    ['Interior Framing & Drywall', '4.2', 40, 150, 0], ['Finishes', '4.3', 120, 210, 0], ['Commissioning', '5.1', 190, 225, 0], ['Substantial Completion', '5.2', 230, 230, 0],
  ];
  for (const [name, wbs, s, f, pct] of sched) {
    c1('schedule', { name, wbs, start_date: d(s), finish_date: d(f), percent_complete: pct, milestone: s === f, critical: ['2.2', '2.3', '3.2', '4.2', '5.2'].includes(wbs), status: pct === 100 ? 'Complete' : pct > 0 ? 'In Progress' : 'Not Started' });
  }

  c1('meetings', { title: 'OAC Meeting #24', meeting_type: 'OAC', meeting_date: dt(2, 10), location: 'Site trailer / Teams', attendees: 'Harborview, Studio Meridian, Keystone', agenda: '1. Safety\n2. Schedule update\n3. RFIs & Submittals\n4. Change events', items: [{ topic: 'Duct reroute at C/4', discussion: 'Awaiting EOR response on beam penetration', owner: 'Keel SE', due: d(4), status: 'Open' }, { topic: 'Curtain wall mock-up', discussion: 'Schedule mock-up review', owner: 'Studio Meridian', due: d(12), status: 'Open' }] });
  c1('meetings', { title: 'Subcontractor Coordination – MEP', meeting_type: 'Coordination', meeting_date: dt(-5, 7), location: 'Site trailer', status: 'Distributed', minutes: 'Reviewed L3 ceiling space coordination. Clash list updated.' });
  c1('tasks', { title: 'Update 3-week look-ahead', category: 'General', assignee: users.super, due_date: d(1), priority: 'High' });
  c1('tasks', { title: 'Collect updated COI from Coastal Mechanical', category: 'Contract', assignee: users.pm, due_date: d(-2), priority: 'Urgent' });
  c1('tasks', { title: 'Prepare O&M manual index', category: 'Closeout', assignee: users.pe, due_date: d(60), priority: 'Low' });
  c1('drawings', { sheet_number: 'A-101', title: 'Level 1 Floor Plan', discipline: 'Architectural', revision: '3', drawing_set: 'IFC Rev 3', drawing_date: d(-70) });
  c1('drawings', { sheet_number: 'S-301', title: 'Level 3 Framing Plan', discipline: 'Structural', revision: '2', drawing_set: 'IFC Rev 2', drawing_date: d(-95) });
  c1('drawings', { sheet_number: 'M-301', title: 'Level 3 HVAC Plan', discipline: 'Mechanical', revision: '2', drawing_set: 'IFC Rev 2', drawing_date: d(-95) });
  c1('drawings', { sheet_number: 'E-201', title: 'Level 1 Power Plan', discipline: 'Electrical', revision: '4', drawing_set: 'ASI-07', drawing_date: d(-20) });
  c1('specifications', { section_number: '03 30 00', title: 'Cast-in-Place Concrete', division: '03 – Concrete', revision: '0', issued_date: d(-200) });
  c1('specifications', { section_number: '05 12 00', title: 'Structural Steel Framing', division: '05 – Metals', revision: '1', issued_date: d(-120) });
  c1('specifications', { section_number: '26 24 13', title: 'Switchboards', division: '26 – Electrical', revision: '0', issued_date: d(-200) });
  c1('documents', { title: 'Building Permit #BP-2026-00412', folder: 'Permits', version: '1', description: 'Issued by SF DBI' });
  c1('documents', { title: 'Site Specific Safety Plan', folder: 'Reports', version: '2' });
  c1('photos', { title: 'Level 3 deck pour – sequence 2', album: 'Progress', location: 'Level 3', taken_on: d(-1) });
  c1('correspondence', { subject: 'Notice of potential delay – steel delivery', correspondence_type: 'Notice of Delay', to_company: co.owner, assignee: users.pm, response_due: d(7), body: 'Please be advised of a potential 5-day delay due to mill shortages.', status: 'Sent' });
  c1('transmittals', { subject: 'Revised steel shop drawings for review', to_company: co.struct, sent_via: 'Email', purpose: 'For Approval', due_by: d(7), items: [{ copies: 1, description: 'Shop drawings L2-L4 rev 1 (PDF)' }], status: 'Sent' });
  c1('action_plans', { title: 'Level 1 Turnover Plan', plan_type: 'Turnover', owner: users.super, status: 'In Progress', steps: [{ step: 'Final MEP inspections', assignee: 'Sam', due: d(170), done: false }, { step: 'Punch walk with owner', assignee: 'Jordan', due: d(180), done: false }, { step: 'Life-safety sign-off', assignee: 'Fire Marshal', due: d(185), done: false }] });
  c1('timesheets', { worker: 'Luis Ortega', work_date: d(-1), cost_code: '01-100', classification: 'Laborer', regular_hours: 8, overtime_hours: 1, hourly_rate: 42, status: 'Approved' });
  c1('timesheets', { worker: 'Tom Nguyen', work_date: d(-1), cost_code: '01-100', classification: 'Carpenter', regular_hours: 8, overtime_hours: 0, hourly_rate: 58 });

  // Project 2 – preconstruction
  const c2 = P(p2);
  c2('bid_packages', { title: 'Drywall & Framing', trade: 'Finishes', bid_due: dt(10, 14), pre_bid_walk: dt(4, 9), estimate: 412000, status: 'Open for Bidding', bidders: [{ company: 'Pacific Interiors', status: 'Submitted', amount: 398500 }, { company: 'Bay Wall Systems', status: 'Will Bid' }, { company: 'Metro Drywall', status: 'Submitted', amount: 431200 }, { company: 'Allied Framing', status: 'Declined' }] });
  c2('bid_packages', { title: 'Electrical', trade: 'Electrical', bid_due: dt(12, 14), estimate: 356000, status: 'Draft', bidders: [{ company: 'Bayside Electric Inc.', status: 'Invited' }] });
  c2('estimates', { title: 'TI Budget – DD Estimate', estimate_type: 'Design Development', markup_percent: 9, line_items: [{ cost_code: '09-200', description: 'Demising walls', quantity: 4200, unit: 'SF', unit_cost: 92 }, { cost_code: '23-000', description: 'HVAC distribution', quantity: 22000, unit: 'SF', unit_cost: 18.5 }, { cost_code: '26-000', description: 'Lighting & power', quantity: 22000, unit: 'SF', unit_cost: 16 }] });
  c2('rfis', { subject: 'Existing sprinkler main elevation', question: 'Please confirm existing main elevation at Level 2 corridor.', due_date: d(8), status: 'Draft' });

  // Project 3 – closeout
  const c3 = P(p3);
  c3('punch_list', { title: 'Lab casework adjustment', location: 'Room 214', trade: 'Furnishings', due_date: d(3), status: 'Work Required' });
  c3('documents', { title: 'DSA Form 6 – Inspector Verified Report', folder: 'Closeout', version: '1' });
  c3('tasks', { title: 'Submit as-builts to district', category: 'Closeout', assignee: users.pm, due_date: d(7), priority: 'High' });

  // A sandbox integration so the Integrations screen has something to explore.
  db.prepare(`INSERT INTO connections (adapter, name, project_id, config, mappings, enabled, realtime, schedule_minutes, inbound_secret) VALUES (?, ?, NULL, ?, ?, 1, 0, 0, ?)`)
    .run('quickbooks', 'QuickBooks Online (Sandbox)', JSON.stringify({ sandbox: true, environment: 'sandbox' }),
      JSON.stringify(require('./integrations/adapters').getAdapter('quickbooks').entities.map((e) => ({ entity: e.key, module: e.module, direction: e.directions.length > 1 ? 'both' : e.directions[0], fields: e.fields, filter: e.filter || null, createMissing: true }))),
      require('node:crypto').randomBytes(24).toString('hex'));
  return true;
}

module.exports = { seed, DEMO_PASSWORD };

if (require.main === module) {
  const { createApp } = require('./app');
  const dbFile = process.env.KEYSTONE_DB || path.join(__dirname, '..', 'data', 'keystone.db');
  if (process.argv.includes('--reset')) for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true });
  const ctx = createApp({ dbFile, background: false });
  const did = seed(ctx);
  console.log(did ? `Seeded demo data into ${dbFile}. Log in as admin@keystone.test / ${DEMO_PASSWORD}` : 'Database already has users – skipped seeding.');
  ctx.close();
}
