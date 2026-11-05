export const COUNSELING_TYPES = ['OUTSTANDING', 'PRE', 'POST', 'COURT', 'Workshop', 'Case Management'];

export const AMI_LEVELS = [
  'Extremely Low Income',
  'Very Low Income',
  'Low Income',
  'Non Low-Moderate',
];

export function amiCategory(val) {
  if (val == null || val === '') return '';
  const n = Number(val);
  if (!isNaN(n) && n > 0) {
    if (n <= 30) return 'Extremely Low Income';
    if (n <= 50) return 'Very Low Income';
    if (n <= 80) return 'Low Income';
    return 'Non Low-Moderate';
  }
  // Legacy string values stored before numeric AMI was calculated
  const s = String(val).toLowerCase().trim();
  const legacyMap = {
    'extremely low':        'Extremely Low Income',
    'extremely low income': 'Extremely Low Income',
    '0-30%':                'Extremely Low Income',
    '<30%':                 'Extremely Low Income',
    'very low':             'Very Low Income',
    'very low income':      'Very Low Income',
    'low':                  'Very Low Income',    // old ≤50% bucket
    '30-49%':               'Very Low Income',
    '30-50%':               'Very Low Income',
    '31-50%':               'Very Low Income',
    'low income':           'Low Income',
    'moderate':             'Low Income',         // old ≤80% bucket
    'low-moderate':         'Low Income',
    '50-79%':               'Low Income',
    '51-80%':               'Low Income',
    '50-80%':               'Low Income',
    'non low-moderate':     'Non Low-Moderate',
    'non low moderate':     'Non Low-Moderate',
    'non-moderate':         'Non Low-Moderate',
    'non moderate':         'Non Low-Moderate',
    'above moderate':       'Non Low-Moderate',
    '80-100%':              'Non Low-Moderate',
    '100+%':                'Non Low-Moderate',
    '>80%':                 'Non Low-Moderate',
    'above 80%':            'Non Low-Moderate',
  };
  return legacyMap[s] || String(val);
}

// Numeric values display as "56%"; legacy strings display as their HUD tier label
export function amiDisplayLabel(val) {
  if (val == null || val === '') return '—';
  const n = Number(val);
  if (!isNaN(n) && n > 0) return n + '%';
  return amiCategory(val);
}

export function amiCdbgCategory(val) {
  return amiCategory(val);
}

// Compute a household's AMI % from actual income vs. the county's HUD 100%
// income limit for their household size. Shared by the client profile and the
// New Client form so the math never diverges. Returns null when any input is
// missing/unusable (caller then keeps whatever was entered manually).
//   limits:       settings/amiLimits `counties` map (county → tier → [8 limits])
//   county:       county name (with or without a trailing "County")
//   hhSize:       household size (adults + children); clamped 1–8
//   grossMonthly: total gross MONTHLY household income
export function computeAmiPercent({ limits, county, hhSize, grossMonthly }) {
  if (!limits || !grossMonthly || grossMonthly <= 0) return null;
  const raw = String(county || '').replace(/\s*county\s*$/i, '').trim();
  if (!raw) return null;
  const key        = Object.keys(limits).find(k => k.toLowerCase() === raw.toLowerCase());
  const countyData = key ? limits[key] : null;
  if (!countyData) return null;
  const size = Math.max(1, Math.min(8, parseInt(hhSize) || 0));
  if (!size) return null;
  const base = (countyData['100'] || [])[size - 1] || 0;
  if (!base) return null;
  return Math.round((grossMonthly * 12 / base) * 100);
}

export const RE_CODES = [
  'White (Code 11)',
  'Black (Code 12)',
  'Asian (Code 13)',
  'American Indian (Code 14)',
  'Native Hawaiian/Other Pacific Islander (Code 15)',
  'American Indian/Alaskan Native & White (Code 16)',
  'Asian & White (Code 17)',
  'Black & White (Code 18)',
  'Amer. Indian & Black/African Amer. (Code 19)',
  'Other Multi-Racial (Code 20)'
];

export const RE_CODE_LABELS = {
  'White (Code 11)':                                    'White (Code 11)',
  'Black (Code 12)':                                    'Black/African American (Code 12)',
  'Asian (Code 13)':                                    'Asian (Code 13)',
  'American Indian (Code 14)':                          'American Indian/Alaskan Native (Code 14)',
  'Native Hawaiian/Other Pacific Islander (Code 15)':   'Native Hawaiian/Other Pacific Islander (Code 15)',
  'American Indian/Alaskan Native & White (Code 16)':   'American Indian/Alaskan Native & White (Code 16)',
  'Asian & White (Code 17)':                            'Asian & White (Code 17)',
  'Black & White (Code 18)':                            'Black/African American & White (Code 18)',
  'Amer. Indian & Black/African Amer. (Code 19)':       'Amer. Indian & Black/African Amer. (Code 19)',
  'Other Multi-Racial (Code 20)':                       'Other Multi-Racial (Code 20)'
};

// Strip " (Code XX)" suffix for display — stored values keep the full string
export function reCodeDisplay(val) {
  return (val || '').replace(/\s*\(Code\s*\d+\)\s*$/i, '').trim() || val;
}

export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

export const AWARD_TYPES = [
  'Direct Assistance',   // Money you actually disbursed (CCA, grant, etc.)
  'Loan Modification',   // Lender agreed to change terms
  'Debt Forgiveness',    // Delinquent balance written off by lender
  'Deferred Payment',    // Payment postponed, not forgiven
  'Other',
];

export const BILLING_TYPES = ['In-Person', 'Case Management Activity', 'Court', 'Group Education'];

export const RX_GUARANTORS = ['NOFA', 'Anti-Pred', 'CHCI', 'HEMAP', 'M&D', 'Non-Billable'];

export const DEFAULT_RATE = 48.5;
export const COURT_RATE   = 2.0;

export function getDefaultRate(counselingType) {
  return counselingType === 'COURT' ? COURT_RATE : DEFAULT_RATE;
}

// AMI label normalization for CSV import — maps common variants to HUD standard labels
export const AMI_IMPORT_MAP = {
  'extremely low':        'Extremely Low Income',
  'extremely low income': 'Extremely Low Income',
  '<30%':                 'Extremely Low Income',
  '0-30%':                'Extremely Low Income',
  'very low':             'Very Low Income',
  'very low income':      'Very Low Income',
  '30-50%':               'Very Low Income',
  '31-50%':               'Very Low Income',
  'low':                  'Very Low Income',
  'low income':           'Low Income',
  'low-moderate':         'Low Income',
  'mod':                  'Low Income',
  '51-80%':               'Low Income',
  '50-80%':               'Low Income',
  'moderate':             'Low Income',
  'non low-moderate':     'Non Low-Moderate',
  'non low moderate':     'Non Low-Moderate',
  'non-moderate':         'Non Low-Moderate',
  'non moderate':         'Non Low-Moderate',
  'above moderate':       'Non Low-Moderate',
  '>80%':                 'Non Low-Moderate',
  'above 80%':            'Non Low-Moderate',
};
