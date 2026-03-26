#!/usr/bin/env node
/**
 * hunt.js — Job hunter + auto-apply toolkit for cloudnomad.us/jobs
 *
 * Usage:
 *   node hunt.js search          - Search for new jobs (web scrape)
 *   node hunt.js refresh         - Re-score all existing jobs
 *   node hunt.js list             - Show all jobs sorted by score
 *   node hunt.js apply <id>      - Generate cover letter + open apply URL
 *   node hunt.js blast            - Mass apply: generate cover letters for all "new" jobs
 *   node hunt.js status <id> <status>  - Update job status (new/applied/skipped)
 *   node hunt.js add              - Add jobs from staged-jobs.json
 *   node hunt.js stats            - Show dashboard stats
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

const JOBS_FILE = path.join(__dirname, 'data', 'jobs.json');
const COVER_DIR = path.join(__dirname, 'covers');
const STAGED_FILE = path.join(__dirname, 'staged-jobs.json');

// ── Blake's profile for scoring & cover letters ──────────────────────
const PROFILE = {
  name: 'Blake Corbit',
  email: 'Blake.A.Corbit@gmail.com',
  phone: '(603) 732-3032',
  location: 'Milford, NH',
  currentRole: 'Technical Support Team Manager — Automation & Platform Engineering',
  currentCompany: 'AutoVitals',
  yearsExp: 4.5,
  skills: [
    'python', 'javascript', 'typescript', 'node.js', 'nodejs', 'react', 'sql',
    'sql server', 'powershell', 'bash', 'html', 'css', 'vite', 'tailwind',
    'supabase', 'rest api', 'rest apis', 'api', 'apis', 'stripe', 'vercel',
    'claude api', 'openai api', 'openai', 'ai', 'llm', 'zendesk', 'jira',
    'slack', 'twilio', 'mailgun', 'statuspage', 'git', 'postman', 'windbg',
    'windows server', 'distributed systems', 'automation', 'incident management',
    'sla', 'escalation', 'documentation', 'technical writing', 'hiring',
    'team management', 'leadership', 'saas', 'b2b', 'full stack', 'full-stack',
    'crm', 'data analysis', 'clustering', 'tf-idf', 'machine learning',
    'diagnostic', 'troubleshooting', 'network', 'dns', 'registry',
    'crash dump', 'windbg', 'packet capture', 'sqlite', 'express',
    'nodemailer', 'webhook', 'webhooks', 'ci/cd', 'agile'
  ],
  highlights: [
    '3 promotions in 3.5 years at AutoVitals',
    'Built 12-service internal automation platform (Node.js)',
    'AI-powered ticket pipeline (Python + OpenAI API) — enabled 3-person team to do work of 7',
    'First-contact resolution: 62% → 78%',
    'Manages 163+ tickets/week for 200+ B2B SaaS clients',
    'PowerShell diagnostic toolkit for distributed system troubleshooting',
    'Led zero-downtime NAPA TRACS API v1→v3 migration across entire customer base',
    'Eagle Scout, Appalachian Trail thru-hiker (2,192mi in 100 days)',
    'Studying for CISSP certification',
    'Runs security consultancy side project (Apollo\'s Table)'
  ],
  desiredSalaryMin: 90000,
  preferRemote: true
};

// ── Scoring weights ──────────────────────────────────────────────────
// Blake is a CUSTOMER-FACING TECHNICAL SUPPORT TEAM MANAGER.
// NOT a software dev, NOT internal IT. His building/automation skills
// are a differentiator, but the core role is support operations leadership.
const TITLE_KEYWORDS = {
  // Bullseye — exactly what Blake does
  'support manager': 20, 'technical support manager': 25,
  'customer support manager': 20, 'support team manager': 20,
  'support operations': 18, 'help desk manager': 15,
  'customer success manager': 18, 'customer success': 15,
  'technical account manager': 18, 'technical account': 15,
  'support engineering manager': 20,

  // Strong fit — adjacent leadership roles
  'manager': 12, 'lead': 10, 'senior': 5,
  'implementation manager': 15, 'implementation': 8,
  'onboarding': 10, 'client success': 15,
  'professional services': 12, 'engagement manager': 15,
  'solutions consultant': 10,

  // Decent fit — could leverage his skills
  'solutions engineer': 8, 'support engineer': 8,
  'automation': 5, 'integration': 5,

  // Bad fit — he's not a dev or internal IT
  'software engineer': -10, 'software developer': -10,
  'full stack': -8, 'fullstack': -8, 'backend': -8, 'frontend': -10,
  'devops': -8, 'sre': -8, 'platform engineer': -8,
  'data engineer': -10, 'data scientist': -10, 'ml engineer': -10,
  'security engineer': -5, 'firmware': -15,
  'intern': -20, 'junior': -5, 'principal': -5, 'director': -3, 'vp': -10,
  'staff software': -8
};

function scoreJob(job) {
  let score = 50; // base
  const breakdown = { title: 0, salary: 0, keywords: 0, location: 0, company: 0 };
  const titleLower = (job.title || '').toLowerCase();
  const descLower = (job.description || '').toLowerCase();
  const locLower = (job.location || '').toLowerCase();

  // Title scoring
  for (const [kw, pts] of Object.entries(TITLE_KEYWORDS)) {
    if (titleLower.includes(kw)) {
      breakdown.title += pts;
    }
  }
  score += breakdown.title;

  // Salary scoring
  const salMax = job.salaryMax || parseSalary(job.salary).max;
  const salMin = job.salaryMin || parseSalary(job.salary).min;
  if (salMax && salMax >= 150000) breakdown.salary += 15;
  else if (salMax && salMax >= 120000) breakdown.salary += 10;
  else if (salMax && salMax >= 90000) breakdown.salary += 5;
  else if (salMax && salMax < 70000) breakdown.salary -= 10;
  score += breakdown.salary;

  // Skill keyword matching
  const allText = `${titleLower} ${descLower}`;
  let matched = [];
  let missing = [];
  const jobWants = extractRequiredSkills(descLower);

  for (const skill of jobWants) {
    if (PROFILE.skills.some(s => s === skill || skill.includes(s) || s.includes(skill))) {
      matched.push(skill);
      breakdown.keywords += 2;
    } else {
      missing.push(skill);
    }
  }
  score += breakdown.keywords;

  // Location scoring
  if (locLower.includes('remote')) breakdown.location += 10;
  else if (locLower.includes('hybrid')) breakdown.location += 3;
  else if (locLower.includes('nh') || locLower.includes('new hampshire') || locLower.includes('boston') || locLower.includes('new england')) breakdown.location += 8;
  else breakdown.location -= 5;
  score += breakdown.location;

  // Automotive/adjacent company bonus
  const autoCompanies = ['autovitals', 'cdk', 'cox automotive', 'reynolds', 'tekion', 'solera',
    'dealersocket', 'mitchell', 'snap-on', 'opus ivs', 'carfax', 'truecar', 'rivian', 'tesla',
    'lucid', 'jerry', 'upstart', 'fullpath', 'dynatron', 'agero', 'samsara', 'impel',
    'oeconnection', 'oec', 'repairify', 'astech', 'chamberlain', 'salvo'];
  const compLower = (job.company || '').toLowerCase();
  if (autoCompanies.some(c => compLower.includes(c))) {
    breakdown.company += 10;
  }
  // Tier 1 tech company bonus
  const tier1 = ['cloudflare', 'crowdstrike', 'pagerduty', 'drata', 'gitlab', 'atlassian',
    'twilio', 'zendesk', 'ninjaone', 'samsara', 'datadog'];
  if (tier1.some(c => compLower.includes(c))) {
    breakdown.company += 8;
  }
  score += breakdown.company;

  // Cap at 100
  score = Math.max(0, Math.min(100, score));

  const matchRate = jobWants.length > 0
    ? Math.round((matched.length / jobWants.length) * 100)
    : 50;

  return {
    score,
    scoreBreakdown: breakdown,
    gaps: { matched, missing, matchRate, jobWants }
  };
}

function parseSalary(salStr) {
  if (!salStr) return { min: null, max: null };
  const nums = (salStr.match(/[\d,]+/g) || []).map(n => parseInt(n.replace(/,/g, '')));
  // If numbers look like hourly (<200), convert to annual
  const annual = nums.map(n => n < 200 ? n * 2080 : n);
  return {
    min: annual.length > 0 ? Math.min(...annual) : null,
    max: annual.length > 0 ? Math.max(...annual) : null
  };
}

function extractRequiredSkills(desc) {
  const skillPatterns = [
    'python', 'javascript', 'typescript', 'node\\.?js', 'react', 'angular', 'vue',
    'sql', 'sql server', 'postgres', 'postgresql', 'mysql', 'sqlite', 'mongodb',
    'powershell', 'bash', 'shell', 'linux', 'windows server', 'windows',
    'aws', 'azure', 'gcp', 'google cloud', 'cloud', 'docker', 'kubernetes', 'k8s',
    'terraform', 'ci/cd', 'jenkins', 'github actions',
    'rest api', 'graphql', 'grpc', 'api',
    'git', 'jira', 'zendesk', 'salesforce', 'slack', 'twilio', 'stripe',
    'ai', 'machine learning', 'ml', 'llm', 'openai', 'langchain',
    'agile', 'scrum', 'kanban',
    'saas', 'b2b', 'b2c',
    'security', 'cissp', 'soc2', 'compliance', 'penetration testing',
    'go', 'golang', 'rust', 'scala', 'java', 'c\\+\\+', 'c#', '\\.net',
    'ruby', 'rails', 'php', 'swift', 'kotlin',
    'redis', 'kafka', 'rabbitmq', 'elasticsearch',
    'tableau', 'power ?bi', 'looker', 'dbt',
    'datadog', 'splunk', 'grafana', 'prometheus',
    'pmp', 'itil',
    'leadership', 'management', 'hiring', 'mentoring',
    'documentation', 'technical writing',
    'customer success', 'pre-sales', 'demo', 'onboarding',
    'incident management', 'escalation', 'sla',
    'distributed systems', 'microservices', 'event-driven'
  ];

  const found = new Set();
  for (const pattern of skillPatterns) {
    const re = new RegExp(`\\b${pattern}\\b`, 'i');
    if (re.test(desc)) {
      found.add(pattern.replace(/\\[.+]/g, '').replace(/\\/g, '').replace(/\?/g, ''));
    }
  }
  return [...found];
}

// ── Cover letter generator ───────────────────────────────────────────
function generateCoverLetter(job) {
  const matchedSkills = (job.gaps?.matched || []).slice(0, 8).join(', ');
  const companyName = job.company || 'your company';
  const jobTitle = job.title || 'this role';

  // Pick the most relevant highlights based on job description
  const descLower = (job.description || '').toLowerCase();
  const relevantHighlights = [];

  if (descLower.includes('automat') || descLower.includes('platform') || descLower.includes('pipeline')) {
    relevantHighlights.push(PROFILE.highlights[1]); // 12-service platform
  }
  if (descLower.includes('ai') || descLower.includes('llm') || descLower.includes('openai') || descLower.includes('machine learning')) {
    relevantHighlights.push(PROFILE.highlights[2]); // AI pipeline
  }
  if (descLower.includes('team') || descLower.includes('manag') || descLower.includes('lead')) {
    relevantHighlights.push(PROFILE.highlights[0]); // 3 promotions
    relevantHighlights.push(PROFILE.highlights[4]); // 163+ tickets
  }
  if (descLower.includes('support') || descLower.includes('customer') || descLower.includes('ticket')) {
    relevantHighlights.push(PROFILE.highlights[3]); // FCR improvement
    relevantHighlights.push(PROFILE.highlights[4]); // 163+ tickets
  }
  if (descLower.includes('security') || descLower.includes('compliance') || descLower.includes('cissp')) {
    relevantHighlights.push(PROFILE.highlights[8]); // CISSP
    relevantHighlights.push(PROFILE.highlights[9]); // Security consultancy
  }
  if (descLower.includes('integration') || descLower.includes('api') || descLower.includes('migration')) {
    relevantHighlights.push(PROFILE.highlights[6]); // NAPA TRACS migration
  }
  if (descLower.includes('diagnostic') || descLower.includes('troubleshoot') || descLower.includes('distributed')) {
    relevantHighlights.push(PROFILE.highlights[5]); // PowerShell toolkit
  }

  // Always include at least 3 highlights
  if (relevantHighlights.length < 3) {
    for (const h of PROFILE.highlights.slice(0, 5)) {
      if (!relevantHighlights.includes(h)) relevantHighlights.push(h);
      if (relevantHighlights.length >= 3) break;
    }
  }

  // Deduplicate
  const uniqueHighlights = [...new Set(relevantHighlights)].slice(0, 4);

  const letter = `${PROFILE.name}
${PROFILE.location} · ${PROFILE.phone} · ${PROFILE.email}

${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}

Re: ${jobTitle} at ${companyName}

To the hiring team at ${companyName},

I manage the technical support team at AutoVitals, a B2B SaaS platform serving 200+ automotive repair shops. My team handles 163+ tickets a week across distributed systems, API integrations, and SQL Server environments — and I've earned three promotions in 3.5 years by finding ways to make us dramatically more effective without adding headcount.

When our team got cut from 7 to 3, I didn't just redistribute the work — I built the automation that made it possible. An AI-powered ticket pipeline that handles triage, routing, and response drafting. A diagnostic toolkit that drove first-contact resolution from 62% to 78%. The result: same volume, smaller team, faster response times.

What I'd bring to ${companyName}:

${uniqueHighlights.map(h => `• ${h}`).join('\n')}

${matchedSkills ? `I also bring hands-on technical depth in ${matchedSkills} — not as a developer, but as someone who understands the product deeply enough to build the tools his team needs and speak the same language as engineering.` : 'I bring the kind of technical depth that lets me build internal tools, speak the same language as engineering, and actually understand what customers are dealing with — not just relay messages.'}

I'd welcome the chance to talk about how that translates to ${companyName}. I'm available anytime.

Blake Corbit
cloudnomad.us · github.com/ApollosTable · linkedin.com/in/blake-corbit`;

  return letter;
}

// ── Job data (freshly sourced March 2026) ────────────────────────────
function getStagedJobs() {
  return [
    // PRIORITY: Tekmetric — direct AutoVitals competitor, automotive SaaS
    {
      title: 'Manager, Scaled Customer Success',
      company: 'Tekmetric',
      location: 'Remote (US)',
      salary: '',
      salaryMin: null, salaryMax: null,
      url: 'https://job-boards.greenhouse.io/tekmetric/jobs/5805375004',
      source: 'greenhouse',
      description: 'Manage CSM team handling thousands of customers using scalable success strategies. Operationalize AI workflows (Vitally AI) for call prep, risk detection, account analysis. Mentor CSMs. Design churn analysis workflows. Build CS processes with AI tools and automation. 2+ yrs CS management, 7+ yrs total CS/Sales/customer-facing. Track record managing churn rate, NRR, NPS/CSAT. Experience building/refining CS processes with AI tools and automation. Automotive shop management SaaS platform.'
    },
    {
      title: 'Customer Success Manager (Mid-Market)',
      company: 'Tekmetric',
      location: 'Remote (US)',
      salary: '',
      salaryMin: null, salaryMax: null,
      url: 'https://job-boards.greenhouse.io/tekmetric/jobs/5678354004',
      source: 'greenhouse',
      description: 'Manage named book of 40-60 mid-market automotive repair business accounts as primary strategic advisor. Drive proactive engagement and success planning. Coordinate across onboarding, support, product, sales teams. Identify churn risks. Build consultative relationships. 3-5 years B2B SaaS experience. Shop management system experience preferred. Automotive repair shop management platform.'
    },
    {
      title: 'Customer Onboarding Manager',
      company: 'Tekmetric',
      location: 'Remote (US)',
      salary: '',
      salaryMin: null, salaryMax: null,
      url: 'https://job-boards.greenhouse.io/tekmetric/jobs/5481339004',
      source: 'greenhouse',
      description: 'Conduct detailed account walkthroughs for new customers. Manage customer implementation and onboarding processes. Document customer needs in HubSpot. Execute customer data migrations. Collaborate across sales, success, operations, support, engineering teams. 1-2 years customer onboarding. Project management. Automotive repair shop SaaS platform.'
    },
    {
      title: 'Customer Success Manager (SMB)',
      company: 'Tekmetric',
      location: 'Remote (US)',
      salary: '',
      salaryMin: null, salaryMax: null,
      url: 'https://job-boards.greenhouse.io/tekmetric/jobs/5678350004',
      source: 'greenhouse',
      description: 'Customer success management for small-to-medium automotive repair businesses on Tekmetric platform. Proactive engagement, success planning, product adoption. B2B SaaS experience. Shop management system knowledge.'
    },
    {
      title: 'Customer Education Manager',
      company: 'Tekmetric',
      location: 'Remote (US)',
      salary: '',
      salaryMin: null, salaryMax: null,
      url: 'https://job-boards.greenhouse.io/tekmetric/jobs/5812633004',
      source: 'greenhouse',
      description: 'Implement and manage new LMS. Create e-learning modules and digital courses. Develop training materials. 5+ yrs experience, 2+ yrs in SaaS (Customer Education, L&D, or Sales Ops). LMS experience preferred. E-learning tools (Articulate, Camtasia). Automotive shop management SaaS.'
    },
    {
      title: 'Manager, Customer Support',
      company: 'Tekmetric',
      location: 'Houston, TX (Hybrid)',
      salary: '',
      salaryMin: null, salaryMax: null,
      url: 'https://job-boards.greenhouse.io/tekmetric/jobs/5801112004',
      source: 'greenhouse',
      description: 'Lead customer support department. Maintain SLAs across phone, chat, email. Establish quarterly strategy, monitor KPIs including response times, CSAT, NPS, renewal rates. Drive operational efficiencies. Manage escalations. Implement quality control metrics and training. 3+ yrs customer support leadership (SaaS preferred). AI tools experience. Zendesk experience nice-to-have. Must be local to Houston or willing to relocate. Automotive shop management SaaS platform.'
    },

    // TIER 1: Automotive SaaS (direct domain match)
    {
      title: 'Engagement Manager, SaaS Implementation',
      company: 'Tekion',
      location: 'Remote (US)',
      salary: '$84,000 - $140,000 + equity',
      salaryMin: 84000, salaryMax: 140000,
      url: 'https://job-boards.greenhouse.io/tekion/jobs/7645111003',
      source: 'greenhouse',
      description: 'Lead customer implementations end-to-end for cloud-native DMS platform. 3+ yrs project management, SaaS onboarding/adoption experience, understanding of DMS, change management. Up to 50% travel.'
    },
    {
      title: 'Customer Success Manager (Growth)',
      company: 'Tekion',
      location: 'Remote (US)',
      salary: '$70,500 - $117,000 + equity',
      salaryMin: 70500, salaryMax: 117000,
      url: 'https://job-boards.greenhouse.io/tekion/jobs/7649930003',
      source: 'greenhouse',
      description: '5+ yrs automotive dealership or automotive software experience, DMS knowledge, CRM (Salesforce), BI tools (Tableau/PowerBI). Customer success management for cloud-native automotive DMS.'
    },
    {
      title: 'Software Engineer, Auto Retail',
      company: 'Upstart',
      location: 'Remote (US)',
      salary: '$142,000 - $196,000',
      salaryMin: 142000, salaryMax: 196000,
      url: 'https://careers.upstart.com/jobs/software-engineer-auto-retail-b7124ace-f82a-42d9-99f9-509dabb75029',
      source: 'careers',
      description: '3+ yrs full stack development. NodeJS, TypeScript, Python backend. React or Angular frontend. System architecture, scalable SaaS. Auto retail domain. Quarterly 3-day onsites.'
    },
    {
      title: 'Software Engineer II (Full Stack, Backend-leaning)',
      company: 'Jerry.ai',
      location: 'Remote (US)',
      salary: '$100,000 - $185,000',
      salaryMin: 100000, salaryMax: 185000,
      url: 'https://himalayas.app/companies/jerry/jobs/software-engineer-ii-full-stack-backend-leaning-4271816591',
      source: 'himalayas',
      description: 'TypeScript, Nest.js, Next.js, React, React Native, GraphQL, PostgreSQL, AWS, Microservices. #1 automotive insurance/services app. AI and LLM integrations.'
    },
    {
      title: 'Staff Software Engineer, GenAI',
      company: 'Chamberlain Group',
      location: 'Remote (US)',
      salary: '$149,000 - $254,000',
      salaryMin: 149000, salaryMax: 254000,
      url: 'https://chamberlain.wd1.myworkdayjobs.com/chamberlain_group/job/remote---california/staff-software-engineer---genai_jr30288',
      source: 'workday',
      description: 'LLMs, LangChain/LangGraph, RAG, MCP (Anthropic), agentic AI systems, Python, AWS, Node.js. myQ garage door/access control platform. Building AI-powered customer experiences.'
    },
    {
      title: 'Sr. Data Integration Analyst',
      company: 'OEConnection',
      location: 'Remote (US)',
      salary: '',
      salaryMin: null, salaryMax: null,
      url: 'https://www.glassdoor.com/job-listing/sr-data-integration-analyst-remote-within-the-united-states-oeconnection-JV_KO0,59_KE60,72.htm?jl=1009886050362',
      source: 'glassdoor',
      description: '5+ yrs data integration, automotive background, OEM data workflows, SSO, SaaS, incident response. Automotive aftermarket parts platform.'
    },
    {
      title: 'Senior Software Engineer, Data Pipeline',
      company: 'Torc Robotics',
      location: 'Remote (US)',
      salary: '$160,800 - $193,000 + equity',
      salaryMin: 160800, salaryMax: 193000,
      url: 'https://job-boards.greenhouse.io/torcrobotics/jobs/8467098002',
      source: 'greenhouse',
      description: 'Python, Spark, Airflow, AWS, SQL, ETL/ELT pipelines, autonomous driving sensor data. Owned by Daimler. Autonomous trucking.'
    },
    {
      title: 'Sr. Manager, Customer Success',
      company: 'Samsara',
      location: 'Remote (US)',
      salary: '$119,000 - $170,000',
      salaryMin: 119000, salaryMax: 170000,
      url: 'https://builtin.com/job/sr-manager-customer-success/8465430',
      source: 'builtin',
      description: 'Lead team of CSMs, define scalable customer success strategies, build playbooks for onboarding/adoption/expansion. IoT platform for fleet/vehicle operations. Automotive industry adjacent.'
    },
    {
      title: 'Solutions Integration Engineer',
      company: 'Samsara',
      location: 'Remote (US)',
      salary: '$87,465 - $117,600',
      salaryMin: 87465, salaryMax: 117600,
      url: 'https://www.samsara.com/company/careers/roles/7610288',
      source: 'samsara',
      description: '1+ years building enterprise integrations/API scripting, Python + one additional language, B2B integration projects. IoT fleet management platform.'
    },
    {
      title: 'Engineering Manager, Data Science/ML',
      company: 'Agero',
      location: 'Remote (US)',
      salary: '$150,000 - $200,000',
      salaryMin: 150000, salaryMax: 200000,
      url: 'https://builtin.com/job/engineering-manager-data-science-ml/7887911',
      source: 'builtin',
      description: '6+ yrs DS/ML experience, 2+ yrs management, Python, SQL, AWS, MLOps, 24/7 real-time systems. Leading automotive roadside assistance platform. Deadline: April 25, 2026.'
    },

    // TIER 2: Solutions Engineer / SE roles
    {
      title: 'Enterprise Solutions Engineer',
      company: 'NinjaOne',
      location: 'Remote (US)',
      salary: '$140,000 - $200,000',
      salaryMin: 140000, salaryMax: 200000,
      url: 'https://builtin.com/job/enterprise-solutions-engineer/8877573',
      source: 'builtin',
      description: 'Windows environments, Linux/macOS, networking, PowerShell/JavaScript scripting, Salesforce/Jira experience, RMM/ITSM tools. IT management SaaS platform.'
    },
    {
      title: 'Senior Solutions Engineer, New England',
      company: 'Cloudflare',
      location: 'Remote (New England)',
      salary: '$208,000 - $254,000',
      salaryMin: 208000, salaryMax: 254000,
      url: 'https://builtin.com/job/senior-solutions-engineer-new-england/8181072',
      source: 'builtin',
      description: '8+ years relevant experience, deep knowledge of internet technologies/protocols, cloud technologies. Pre-sales solutions engineering for New England territory.'
    },
    {
      title: 'Senior Solutions Engineer, Enterprise',
      company: 'Drata',
      location: 'Remote (US)',
      salary: '$179,000 - $277,000 OTE',
      salaryMin: 179000, salaryMax: 277000,
      url: 'https://builtin.com/job/senior-solutions-engineer-enterprise/8596631',
      source: 'builtin',
      description: 'Pre-sales technical experience, GRC/compliance knowledge. Compliance automation platform. 100% remote company.'
    },
    {
      title: 'Senior Technical Solutions Engineer',
      company: 'Bestow',
      location: 'Remote (US)',
      salary: '$120,000 - $150,000',
      salaryMin: 120000, salaryMax: 150000,
      url: 'https://builtin.com/job/senior-technical-solutions-engineer/8376631',
      source: 'builtin',
      description: 'Bug triage, working with internal/external engineers, product managers, and account managers. Technical problem solving and solution design.'
    },
    {
      title: 'Associate Solutions Engineer (DX)',
      company: 'Atlassian',
      location: 'Remote/Hybrid (Salt Lake City)',
      salary: '$98,000 - $155,000',
      salaryMin: 98000, salaryMax: 155000,
      url: 'https://builtin.com/job/associate-solutions-engineer-dx/8383133',
      source: 'builtin',
      description: '0-2+ years customer-facing technical experience, familiarity with Jira/Confluence/Bitbucket. Developer experience solutions engineering.'
    },
    {
      title: 'Solutions Engineer',
      company: 'Acquia',
      location: 'Remote (US)',
      salary: '$90,000 - $100,000 + variable',
      salaryMin: 90000, salaryMax: 100000,
      url: 'https://builtin.com/job/sales-engineer/8349205',
      source: 'builtin',
      description: 'Customer-facing technical experience, solution scoping, enterprise applications. Digital experience platform.'
    },
    {
      title: 'Solutions Engineer, GovCon',
      company: 'Unanet',
      location: 'Remote (US)',
      salary: '$95,000 - $113,000',
      salaryMin: 95000, salaryMax: 113000,
      url: 'https://builtin.com/job/solutions-engineer-govcon/8566986',
      source: 'builtin',
      description: 'Government contractor SaaS solutions engineering. B2B SaaS experience. CISSP and security background valued.'
    },

    // TIER 3: Support / TAM / CSM Management
    {
      title: 'Senior Manager, Personalized Support (TAM)',
      company: 'Twilio',
      location: 'Remote (US)',
      salary: '$142,000 - $208,000 + equity',
      salaryMin: 142000, salaryMax: 208000,
      url: 'https://www.glassdoor.com/job-listing/senior-manager-personalized-support-technical-account-management-twilio-JV_KO0,64_KE65,71.htm?jl=1009998163190',
      source: 'glassdoor',
      description: 'Experience growing and overseeing customer support delivery, NAMER sales vertical alignment. Technical account management leadership.'
    },
    {
      title: 'Manager, Customer Success Engineers (AMER)',
      company: 'GitLab',
      location: 'Remote (US)',
      salary: '$120,900 - $220,300',
      salaryMin: 120900, salaryMax: 220300,
      url: 'https://www.glassdoor.com/job-listing/manager-customer-success-engineers-gitlab-JV_KO0,34_KE35,41.htm?jl=1008003182206',
      source: 'glassdoor',
      description: 'Entrepreneurial leader to manage existing and newly-hired CSEs. All-remote company. Technical managers who hire and develop engineers.'
    },
    {
      title: 'Customer Success Manager, Enterprise (East Coast)',
      company: 'monday.com',
      location: 'Remote (East Coast US)',
      salary: '$110,000 - $150,000',
      salaryMin: 110000, salaryMax: 150000,
      url: 'https://builtin.com/job/customer-success-manager-enterprise-remote-east-coast-midwest/8865167',
      source: 'builtin',
      description: 'Enterprise CSM experience, SaaS background. Workflow/project management platform. East Coast remote.'
    },
    {
      title: 'Senior Customer Success Manager',
      company: 'Domino Data Lab',
      location: 'Remote (US)',
      salary: '$200,000 - $230,000',
      salaryMin: 200000, salaryMax: 230000,
      url: 'https://builtin.com/job/customer-success-manager/7522758',
      source: 'builtin',
      description: 'ML Ops/AI knowledge, product expertise, commercial acumen. Enterprise AI/ML platform. Data science workflow management.'
    },
    {
      title: 'Senior Enterprise CSM, Public Sector',
      company: 'Imprivata',
      location: 'Remote (US)',
      salary: '$171,000 - $204,000',
      salaryMin: 171000, salaryMax: 204000,
      url: 'https://builtin.com/job/senior-enterprise-customer-success-manager-public-sector/8853025',
      source: 'builtin',
      description: 'Enterprise client management, public sector, security/identity management. Digital identity and access management platform. CISSP valued.'
    },
    {
      title: 'Senior Customer Success Manager',
      company: 'Nexthink',
      location: 'Remote (US)',
      salary: '$105,000 - $164,000',
      salaryMin: 105000, salaryMax: 164000,
      url: 'https://builtin.com/job/senior-customer-success-manager/8710753',
      source: 'builtin',
      description: 'Technical background, ITSM/ITIL understanding, enterprise relationship management, C-suite communication. Digital Employee Experience platform.'
    },

    // TIER 4: Platform / Integration / DevOps
    {
      title: 'Sr. Business Systems Integration Engineer',
      company: 'Storable',
      location: 'Remote (US)',
      salary: '$100,000 - $135,000',
      salaryMin: 100000, salaryMax: 135000,
      url: 'https://builtin.com/job/sr-business-systems-integration-engineer/8309188',
      source: 'builtin',
      description: 'Business systems integration experience. Zendesk, Jira, Slack, Stripe integration. Vertical SaaS platform.'
    },
    {
      title: 'Lead Process Engineer, SaaS Automation Platform',
      company: 'AIO Logic',
      location: 'Remote (US)',
      salary: '$145,000 - $160,000',
      salaryMin: 145000, salaryMax: 160000,
      url: 'https://builtin.com/job/lead-process-engineer-bfsi-saas-automation-platform/8396183',
      source: 'builtin',
      description: 'Process automation, SaaS platform architecture. Fintech automation platform. Leadership of automation initiatives.'
    },
    {
      title: 'Senior Software Engineer: Platform',
      company: 'LogicGate',
      location: 'Remote (US)',
      salary: '$125,000 - $165,000',
      salaryMin: 125000, salaryMax: 165000,
      url: 'https://builtin.com/job/senior-software-engineer-platform/8495034',
      source: 'builtin',
      description: 'Platform engineering, GRC automation. Governance, risk, and compliance automation platform. Internal platform engineering.'
    },
    {
      title: 'Sr. Slack Platform Engineer, Enterprise Collaboration',
      company: 'CrowdStrike',
      location: 'Remote (US)',
      salary: '$125,000 - $180,000',
      salaryMin: 125000, salaryMax: 180000,
      url: 'https://builtin.com/job/sr-slack-platform-engineer-enterprise-collaboration-remote/7146719',
      source: 'builtin',
      description: 'Slack platform development, enterprise collaboration tools. Cybersecurity platform. Slack API and enterprise automation.'
    },
    {
      title: 'Readiness Services Consultant',
      company: 'CrowdStrike',
      location: 'Remote (US)',
      salary: '$95,000 - $140,000 + equity',
      salaryMin: 95000, salaryMax: 140000,
      url: 'https://www.glassdoor.com/job-listing/readiness-services-consultant-remote-crowdstrike-JV_KO0,36_KE37,48.htm?jl=1010007760958',
      source: 'glassdoor',
      description: 'Security readiness consulting, incident response preparation. Leading cybersecurity platform. Security assessment and readiness.'
    },
    {
      title: 'Integration Engineer',
      company: 'Concord Technologies',
      location: 'Remote (US)',
      salary: '$85,000 - $100,000',
      salaryMin: 85000, salaryMax: 100000,
      url: 'https://builtin.com/job/integration-engineer/8840475',
      source: 'builtin',
      description: 'Integration development, API experience. Cloud communications platform. Enterprise integrations.'
    },

    // TIER 5: Security path (CISSP leverage)
    {
      title: 'Staff Application Security Engineer',
      company: 'Drata',
      location: 'Remote (US)',
      salary: '$160,000 - $250,000',
      salaryMin: 160000, salaryMax: 250000,
      url: 'https://www.linkedin.com/jobs/view/staff-application-security-engineer-remote-at-drata-3518694926',
      source: 'linkedin',
      description: 'Node, JavaScript, TypeScript, React knowledge, SDLC security integration, code reviews, penetration testing. Compliance automation platform. Application security.'
    }
  ];
}

// ── Commands ─────────────────────────────────────────────────────────

function loadJobs() {
  if (!fs.existsSync(JOBS_FILE)) return [];
  return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
}

function saveJobs(jobs) {
  fs.mkdirSync(path.dirname(JOBS_FILE), { recursive: true });
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
  console.log(`Saved ${jobs.length} jobs to ${JOBS_FILE}`);
}

function genId(job) {
  const slug = `${job.source}-${job.company}-${job.title}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
  const hash = crypto.createHash('md5').update(`${job.url || ''}${job.title}${job.company}`).digest('hex').slice(0, 8);
  return `${slug}-${hash}`;
}

function cmdAdd() {
  const existing = loadJobs();
  const existingUrls = new Set(existing.map(j => j.url).filter(Boolean));
  const existingIds = new Set(existing.map(j => j.id));

  const staged = getStagedJobs();
  let added = 0;

  for (const raw of staged) {
    if (raw.url && existingUrls.has(raw.url)) continue;

    const job = {
      id: genId(raw),
      source: raw.source || 'manual',
      title: raw.title,
      company: raw.company,
      location: raw.location || '',
      salary: raw.salary || '',
      salaryMin: raw.salaryMin || null,
      salaryMax: raw.salaryMax || null,
      url: raw.url || '',
      description: raw.description || '',
      status: 'new',
      foundDate: new Date().toISOString().split('T')[0],
      appliedDate: null,
      ...scoreJob(raw)
    };

    if (existingIds.has(job.id)) continue;
    existing.push(job);
    added++;
  }

  existing.sort((a, b) => b.score - a.score);
  saveJobs(existing);
  console.log(`Added ${added} new jobs (${staged.length - added} duplicates skipped)`);
}

function cmdRefresh() {
  const jobs = loadJobs();
  for (const job of jobs) {
    const scored = scoreJob(job);
    Object.assign(job, scored);
  }
  jobs.sort((a, b) => b.score - a.score);
  saveJobs(jobs);
  console.log('Re-scored all jobs');
}

function cmdList() {
  const jobs = loadJobs();
  if (jobs.length === 0) {
    console.log('No jobs found. Run: node hunt.js add');
    return;
  }

  const statusColors = { new: '\x1b[36m', applied: '\x1b[32m', skipped: '\x1b[90m' };
  const reset = '\x1b[0m';

  console.log(`\n${'Score'.padEnd(6)} ${'Status'.padEnd(9)} ${'Company'.padEnd(22)} ${'Title'.padEnd(45)} ${'Salary'.padEnd(22)} Match`);
  console.log('─'.repeat(115));

  for (const j of jobs) {
    const color = statusColors[j.status] || '';
    const matchPct = j.gaps?.matchRate != null ? `${j.gaps.matchRate}%` : '—';
    console.log(
      `${color}${String(j.score).padEnd(6)} ${(j.status || 'new').padEnd(9)} ${(j.company || '').slice(0, 20).padEnd(22)} ${(j.title || '').slice(0, 43).padEnd(45)} ${(j.salary || '—').slice(0, 20).padEnd(22)} ${matchPct}${reset}`
    );
  }
  console.log(`\nTotal: ${jobs.length} | New: ${jobs.filter(j => j.status === 'new').length} | Applied: ${jobs.filter(j => j.status === 'applied').length}`);
}

function cmdApply(idOrIndex) {
  const jobs = loadJobs();
  const job = jobs.find(j => j.id === idOrIndex) || jobs[parseInt(idOrIndex)];
  if (!job) {
    console.error(`Job not found: ${idOrIndex}`);
    console.log('Use "node hunt.js list" to see all jobs');
    return;
  }

  const letter = generateCoverLetter(job);
  fs.mkdirSync(COVER_DIR, { recursive: true });

  const filename = `cover_${job.company.replace(/[^a-z0-9]/gi, '_')}_${job.title.replace(/[^a-z0-9]/gi, '_').slice(0, 30)}.txt`;
  const filepath = path.join(COVER_DIR, filename);
  fs.writeFileSync(filepath, letter);

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${job.title} @ ${job.company}`);
  console.log(`  Score: ${job.score} | Match: ${job.gaps?.matchRate || '?'}%`);
  console.log(`  Salary: ${job.salary || 'Not listed'}`);
  console.log(`${'═'.repeat(70)}\n`);
  console.log(letter);
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`Cover letter saved: ${filepath}`);

  if (job.url) {
    console.log(`\nOpening application URL...`);
    try {
      if (process.platform === 'win32') execSync(`start "" "${job.url}"`, { stdio: 'ignore' });
      else if (process.platform === 'darwin') execSync(`open "${job.url}"`, { stdio: 'ignore' });
      else execSync(`xdg-open "${job.url}"`, { stdio: 'ignore' });
    } catch { console.log(`Open manually: ${job.url}`); }
  }
}

function cmdBlast() {
  const jobs = loadJobs();
  const newJobs = jobs.filter(j => j.status === 'new').sort((a, b) => b.score - a.score);

  if (newJobs.length === 0) {
    console.log('No new jobs to process.');
    return;
  }

  fs.mkdirSync(COVER_DIR, { recursive: true });
  console.log(`\nGenerating cover letters for ${newJobs.length} jobs...\n`);

  const results = [];
  for (const job of newJobs) {
    const letter = generateCoverLetter(job);
    const filename = `cover_${job.company.replace(/[^a-z0-9]/gi, '_')}_${job.title.replace(/[^a-z0-9]/gi, '_').slice(0, 30)}.txt`;
    const filepath = path.join(COVER_DIR, filename);
    fs.writeFileSync(filepath, letter);

    results.push({
      score: job.score,
      company: job.company,
      title: job.title,
      salary: job.salary || '—',
      url: job.url,
      cover: filepath
    });

    console.log(`  [${job.score}] ${job.title} @ ${job.company} → ${filename}`);
  }

  // Generate a blast summary with all URLs
  const summaryPath = path.join(COVER_DIR, '_BLAST_SUMMARY.txt');
  const summary = `JOB APPLICATION BLAST — ${new Date().toLocaleDateString()}
${'═'.repeat(60)}
Generated ${results.length} cover letters for review.

${'─'.repeat(60)}
APPLY IN ORDER (highest score first):
${'─'.repeat(60)}

${results.map((r, i) => `${i + 1}. [Score: ${r.score}] ${r.title} @ ${r.company}
   Salary: ${r.salary}
   Apply:  ${r.url}
   Cover:  ${r.cover}
`).join('\n')}

${'─'.repeat(60)}
QUICK LINKS (open all in browser):
${'─'.repeat(60)}
${results.map(r => r.url).filter(Boolean).join('\n')}
`;

  fs.writeFileSync(summaryPath, summary);
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Blast summary: ${summaryPath}`);
  console.log(`Cover letters: ${COVER_DIR}/`);
  console.log(`\nReady to apply! Review letters, then:`);
  console.log(`  node hunt.js status <id> applied   — mark as applied`);
  console.log(`  node hunt.js status <id> skipped    — skip a job`);
}

function cmdStatus(idOrIndex, newStatus) {
  const validStatuses = ['new', 'applied', 'skipped', 'interview', 'rejected', 'offer'];
  if (!validStatuses.includes(newStatus)) {
    console.error(`Invalid status: ${newStatus}. Use: ${validStatuses.join(', ')}`);
    return;
  }

  const jobs = loadJobs();
  const job = jobs.find(j => j.id === idOrIndex) || jobs[parseInt(idOrIndex)];
  if (!job) {
    console.error(`Job not found: ${idOrIndex}`);
    return;
  }

  job.status = newStatus;
  if (newStatus === 'applied') job.appliedDate = new Date().toISOString().split('T')[0];
  saveJobs(jobs);
  console.log(`Updated: ${job.title} @ ${job.company} → ${newStatus}`);
}

function cmdStats() {
  const jobs = loadJobs();
  const stats = { total: jobs.length, new: 0, applied: 0, skipped: 0, interview: 0, offer: 0 };
  let totalSalaryMax = 0, salaryCount = 0;

  for (const j of jobs) {
    stats[j.status] = (stats[j.status] || 0) + 1;
    if (j.salaryMax) { totalSalaryMax += j.salaryMax; salaryCount++; }
  }

  const avgScore = jobs.length ? Math.round(jobs.reduce((s, j) => s + j.score, 0) / jobs.length) : 0;
  const avgSalary = salaryCount ? `$${Math.round(totalSalaryMax / salaryCount).toLocaleString()}` : '—';
  const topJobs = jobs.slice(0, 5);

  console.log(`\n${'═'.repeat(50)}`);
  console.log('  JOB HUNT STATS');
  console.log(`${'═'.repeat(50)}`);
  console.log(`  Total:     ${stats.total}`);
  console.log(`  New:       ${stats.new}`);
  console.log(`  Applied:   ${stats.applied}`);
  console.log(`  Interview: ${stats.interview || 0}`);
  console.log(`  Skipped:   ${stats.skipped}`);
  console.log(`  Avg Score: ${avgScore}`);
  console.log(`  Avg Max $: ${avgSalary}`);
  console.log(`${'─'.repeat(50)}`);
  console.log('  TOP 5:');
  for (const j of topJobs) {
    console.log(`    [${j.score}] ${j.title.slice(0, 35)} @ ${j.company}`);
  }
  console.log(`${'═'.repeat(50)}\n`);
}

// ── Main ─────────────────────────────────────────────────────────────
const [,, cmd, ...args] = process.argv;

switch (cmd) {
  case 'add':      cmdAdd(); break;
  case 'refresh':  cmdRefresh(); break;
  case 'list':     cmdList(); break;
  case 'apply':    cmdApply(args[0]); break;
  case 'blast':    cmdBlast(); break;
  case 'status':   cmdStatus(args[0], args[1]); break;
  case 'stats':    cmdStats(); break;
  default:
    console.log(`
hunt.js — Job hunter + auto-apply toolkit

Commands:
  node hunt.js add              Load new staged jobs, score & deduplicate
  node hunt.js refresh          Re-score all existing jobs
  node hunt.js list             Show all jobs sorted by score
  node hunt.js apply <id|#>     Generate cover letter + open apply URL
  node hunt.js blast            Mass generate cover letters for all "new" jobs
  node hunt.js status <id> <s>  Update status (new/applied/skipped/interview/offer)
  node hunt.js stats            Show dashboard stats
    `);
}
